import { App, TFile } from "obsidian";
import * as path from "path";
import type {
	BooksIndex,
	BooksIndexRecord,
	CalibreBook,
	CfiInfo,
	Clipping,
	HighlightEntry,
	KindleCalibreSettings,
	SyncSummary,
} from "../types";
import { CalibreDatabase, detectCalibreLibraryPath } from "./calibreDb";
import { parseClippingsContent, parseClippingsFile } from "./clippingsParser";
import {
	buildEpubTextIndex,
	buildPointCfi,
	buildRangeCfi,
	findCfiInIndex,
	type EpubTextIndex,
} from "./epubCfi";
import {
	ensureBookDirHasEpub,
	findBestConvertibleSourceInDir,
	findBookDirectoryById,
	findExistingEpubInDir,
} from "./epubConverter";
import {
	loadCalibreAuthorMap,
	mergeClippingsAndKsdkBooks,
	parseKsdkAnnotationsDb,
} from "./ksdkDbReader";
import { resolveHighlightsFolder, VaultExporter } from "./obsidianExporter";

export interface SyncRunOptions {
	app: App;
	settings: KindleCalibreSettings;
	clippingsSource?: { path: string; content?: string } | null;
	ksdkDb?: { path: string; data: Uint8Array } | null;
	extraKfxDirs?: string[];
	autoConvertToEpub?: boolean;
	onProgress?: (message: string) => void;
}

export interface SyncRunResult {
	summary: SyncSummary;
	booksIndex: BooksIndex | null;
	resolvedCalibrePath: string | null;
	resolvedFolder: string;
}

export interface PreparedBookEpubResult {
	bookId: string;
	epubPath: string;
	converted: boolean;
	sourceFormat: string | null;
	bookRecord: BooksIndexRecord;
	resolvedOpenAt?: string;
	noteUpdated: boolean;
	dbWarning?: string;
}

/**
 * Reads Calibre metadata.db directly in TypeScript/WASM and builds a fresh BooksIndex without Python.
 */
export async function buildBooksIndexFromCalibre(settings: KindleCalibreSettings): Promise<{
	booksIndex: BooksIndex | null;
	calibrePath: string | null;
}> {
	const calibrePath = detectCalibreLibraryPath(settings.calibreLibraryPath);
	if (!calibrePath) {
		return { booksIndex: null, calibrePath: null };
	}

	let calibre: CalibreDatabase | null = null;
	try {
		calibre = await CalibreDatabase.open(calibrePath, settings.calibreLibraryId || "Calibre_Library");
		return {
			booksIndex: calibre.exportBooksIndex(),
			calibrePath,
		};
	} catch (err) {
		console.warn("Failed to build books index from Calibre:", err);
		return { booksIndex: null, calibrePath };
	} finally {
		calibre?.close();
	}
}

/**
 * Runs end-to-end native sync inside Obsidian without Python or external config:
 * parse My Clippings.txt + ksdk_annotation_v1.db -> match Calibre books ->
 * queue-convert missing EPUBs -> compute EPUB CFIs -> inject annotations into Calibre DB ->
 * export/update vault markdown notes -> refresh BooksIndex.
 */
export async function runNativeSync(options: SyncRunOptions): Promise<SyncRunResult> {
	const {
		app,
		settings,
		clippingsSource,
		ksdkDb,
		extraKfxDirs = [],
		autoConvertToEpub = true,
		onProgress,
	} = options;

	const legacyBooks = clippingsSource?.path
		? typeof clippingsSource.content === "string"
			? parseClippingsContent(clippingsSource.content)
			: parseClippingsFile(clippingsSource.path)
		: new Map<string, Clipping[]>();

	const detectedLibraryPath = detectCalibreLibraryPath(settings.calibreLibraryPath) || "";
	let booksClippings = legacyBooks;

	if (ksdkDb) {
		onProgress?.("Reading Kindle annotation database (ksdk_annotation_v1.db)...");
		const calibreAuthorByTitle = detectedLibraryPath
			? await loadCalibreAuthorMap(detectedLibraryPath)
			: undefined;
		const kfxSearchDirs = [detectedLibraryPath, ...extraKfxDirs].filter(Boolean);
		const ksdkResult = await parseKsdkAnnotationsDb(ksdkDb.data, {
			kfxSearchDirs,
			calibreAuthorByTitle,
		});
		booksClippings = mergeClippingsAndKsdkBooks(legacyBooks, ksdkResult.books);
		if (ksdkResult.stats.unresolvedAsins.length > 0) {
			onProgress?.(
				`Note: ${ksdkResult.stats.unresolvedAsins.length} KFX book(s) in Kindle DB had no local .kfx match in Calibre Library.`
			);
		}
	}

	let totalClips = 0;
	for (const list of booksClippings.values()) {
		totalClips += list.length;
	}

	const resolvedFolder = resolveHighlightsFolder(app, settings.highlightsFolder);
	const exporter = new VaultExporter(app, resolvedFolder);
	await exporter.ensureFolderExists();

	const resolvedCalibrePath = detectCalibreLibraryPath(settings.calibreLibraryPath);
	let calibre: CalibreDatabase | null = null;
	let calibreWarning: string | undefined;

	if (resolvedCalibrePath) {
		try {
			calibre = await CalibreDatabase.open(resolvedCalibrePath, settings.calibreLibraryId || "Calibre_Library");
		} catch (err) {
			calibreWarning = `Could not open Calibre database: ${err instanceof Error ? err.message : String(err)}`;
		}
	} else {
		calibreWarning = "Calibre Library not found. Exported notes without Calibre CFI links.";
	}

	let matchedBooks = 0;
	let cfiFound = 0;
	let injectedAnnots = 0;
	let notesUpdated = 0;
	let epubsConverted = 0;
	const epubConversionWarnings: string[] = [];

	const epubIndexCache = new Map<string, EpubTextIndex | null>();

	try {
		// Pre-match all synced books and queue missing EPUB conversions upfront so the reader never waits later.
		const syncedEntries: Array<{
			title: string;
			author: string;
			clippings: Clipping[];
			calibreBook: CalibreBook | null;
		}> = [];

		const conversionQueue: Array<{ calibreBook: CalibreBook; bookDir: string }> = [];
		const queuedBookIds = new Set<number>();

		for (const [title, clippings] of booksClippings.entries()) {
			const author = clippings[0]?.author || "";
			const calibreBook = calibre ? calibre.findBook(title, author) : null;
			syncedEntries.push({ title, author, clippings, calibreBook });

			if (!calibreBook || !calibre || queuedBookIds.has(calibreBook.bookId)) {
				continue;
			}

			if (calibre.getBookEpubPath(calibreBook)) {
				continue;
			}

			const bookDir = path.join(calibre.libraryPath, calibreBook.path);
			const existingDiskEpub = findExistingEpubInDir(bookDir);
			if (existingDiskEpub) {
				calibre.ensureEpubFormatRecord(calibreBook.bookId, existingDiskEpub);
				if (!calibreBook.formats.includes("EPUB")) {
					calibreBook.formats.unshift("EPUB");
				}
				continue;
			}

			if (autoConvertToEpub && findBestConvertibleSourceInDir(bookDir)) {
				queuedBookIds.add(calibreBook.bookId);
				conversionQueue.push({ calibreBook, bookDir });
			}
		}

		for (let qi = 0; qi < conversionQueue.length; qi++) {
			const { calibreBook, bookDir } = conversionQueue[qi];
			onProgress?.(
				`Preparing EPUB queue (${qi + 1}/${conversionQueue.length}): ${calibreBook.title}...`
			);
			try {
				const res = await ensureBookDirHasEpub(bookDir);
				calibre?.ensureEpubFormatRecord(calibreBook.bookId, res.epubPath);
				if (!calibreBook.formats.includes("EPUB")) {
					calibreBook.formats.unshift("EPUB");
				}
				if (res.converted) {
					epubsConverted++;
				}
			} catch (err) {
				epubConversionWarnings.push(
					`Failed to convert "${calibreBook.title}" to EPUB: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}

		let bookIdx = 0;
		const totalBooks = syncedEntries.length;

		for (const { title, author, clippings, calibreBook } of syncedEntries) {
			bookIdx++;
			if (onProgress) {
				onProgress(`Syncing (${bookIdx}/${totalBooks}): ${title}`);
			}

			const calibreLinks = new Map<string, string>();

			if (calibreBook && calibre) {
				matchedBooks++;
				const epubPath = calibre.getBookEpubPath(calibreBook);
				let epubIndex: EpubTextIndex | null = null;

				if (epubPath) {
					if (epubIndexCache.has(epubPath)) {
						epubIndex = epubIndexCache.get(epubPath) ?? null;
					} else {
						epubIndex = await buildEpubTextIndex(epubPath);
						epubIndexCache.set(epubPath, epubIndex);
					}
				}

				const fmt = epubPath || calibreBook.formats.includes("EPUB")
					? "EPUB"
					: calibreBook.formats[0] || "EPUB";

				for (const clip of clippings) {
					const cfiInfo = epubIndex ? findCfiInIndex(epubIndex, clip.text) : null;
					if (cfiInfo) {
						cfiFound++;
					}

					const link = calibre.buildDeepLink(calibreBook, clip.text, cfiInfo);
					calibreLinks.set(clip.refId, link);

					if (settings.injectCalibreAnnotations) {
						const insertedId = calibre.injectAnnotation(
							calibreBook.bookId,
							fmt,
							clip.text,
							cfiInfo,
							clip.note
						);
						if (insertedId) {
							injectedAnnots++;
						}
					}
				}
			}

			const bookIdStr = calibreBook ? String(calibreBook.bookId) : null;
			const { updatedCount } = await exporter.exportOrUpdateBook(
				title,
				author,
				clippings,
				calibreLinks,
				bookIdStr,
				calibreBook?.title || null
			);
			notesUpdated += updatedCount;
		}

		if (calibre) {
			try {
				await calibre.save();
			} catch (err) {
				calibreWarning = err instanceof Error ? err.message : String(err);
			}
		}

		const booksIndex = calibre ? calibre.exportBooksIndex() : null;

		if (epubConversionWarnings.length > 0 && !calibreWarning) {
			calibreWarning = epubConversionWarnings[0];
		}

		return {
			summary: {
				clippingsPath: clippingsSource?.path || ksdkDb?.path || "",
				totalBooks: booksClippings.size,
				totalClips,
				matchedBooks,
				cfiFound,
				injectedAnnots,
				notesUpdated,
				highlightsFolder: resolvedFolder,
				epubsConverted,
				epubConversionWarnings: epubConversionWarnings.length ? epubConversionWarnings : undefined,
				calibreWarning,
			},
			booksIndex,
			resolvedCalibrePath,
			resolvedFolder,
		};
	} finally {
		calibre?.close();
	}
}

interface ParsedMarkdownHighlight {
	text: string;
	refId: string;
	note?: string;
}

function normalizeTextKey(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function extractHighlightsFromMarkdown(content: string): ParsedMarkdownHighlight[] {
	const results: ParsedMarkdownHighlight[] = [];
	const highlightsIdx = content.search(/^##\s+Highlights\b/m);
	const body = highlightsIdx >= 0 ? content.slice(highlightsIdx) : content;
	const blocks = body.split(/\r?\n---\s*(?:\r?\n|$)/);

	for (const block of blocks) {
		const m = block.match(/([\s\S]*?)\s+—\s+location:\s*\[\d+\]\([^)]*\)\s*\^ref-(\w+)/);
		if (!m) continue;
		const rawText = m[1].replace(/^##\s+Highlights\s*\r?\n/m, "").trim();
		if (!rawText) continue;
		const refId = m[2];
		const afterMatch = block.slice((m.index ?? 0) + m[0].length);
		const noteMatch = afterMatch.match(/\*Note\*:\s*([\s\S]+)$/);
		const note = noteMatch ? noteMatch[1].trim() : undefined;
		results.push({ text: rawText, refId, note });
	}

	return results;
}

function findNoteFileByBookId(app: App, bookId: string, titleHint?: string): TFile | null {
	const files = app.vault.getMarkdownFiles();
	for (const file of files) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		if (String(fm["kindle-bookId"] ?? "").trim() === String(bookId).trim()) {
			return file;
		}
	}
	if (titleHint) {
		const normTitle = normalizeTextKey(titleHint);
		for (const file of files) {
			const fm = app.metadataCache.getFileCache(file)?.frontmatter;
			const fmTitle = typeof fm?.["kindle-title"] === "string" ? fm["kindle-title"] : "";
			if (fmTitle && normalizeTextKey(fmTitle) === normTitle) {
				return file;
			}
		}
	}
	return null;
}

function buildDeepLinkDirect(libraryId: string, bookId: number, cfiInfo: CfiInfo | null, fallbackText: string): string {
	const base = `calibre://view-book/${libraryId || "Calibre_Library"}/${bookId}/EPUB`;
	if (cfiInfo && cfiInfo.fullCfi) {
		const encodedCfi = encodeURIComponent(cfiInfo.fullCfi)
			.replace(/!/g, "%21")
			.replace(/'/g, "%27")
			.replace(/\)/g, "%29")
			.replace(/\*/g, "%2A");
		return `${base}?open_at=${encodedCfi}`;
	}
	const snippet = fallbackText.replace(/[\s\u00a0\u00ad]+/g, " ").trim().slice(0, 60);
	const encodedQuery = encodeURIComponent(`search:${snippet}`)
		.replace(/!/g, "%21")
		.replace(/'/g, "%27")
		.replace(/\(/g, "%28")
		.replace(/\)/g, "%29")
		.replace(/\*/g, "%2A");
	return `${base}?open_at=${encodedQuery}`;
}

export interface PrepareBookEpubOptions {
	app: App;
	settings: KindleCalibreSettings;
	bookId: string;
	openAt?: string;
	noteFile?: TFile | null;
	onStatus?: (message: string) => void;
}

/**
 * Ensures a single book has an EPUB file (converting if missing), registers it in Calibre metadata.db,
 * computes EPUB CFIs for all highlights (from DB + vault note), updates the note's links,
 * and returns a fresh BooksIndexRecord so the side-by-side reader renders highlights immediately.
 */
export async function prepareBookEpubForViewer(
	options: PrepareBookEpubOptions
): Promise<PreparedBookEpubResult | null> {
	const { app, settings, bookId, openAt = "", noteFile, onStatus } = options;
	const libraryPath = detectCalibreLibraryPath(settings.calibreLibraryPath);
	if (!libraryPath) return null;

	const bookIdNum = Number.parseInt(bookId, 10);
	const libraryId = settings.calibreLibraryId || "Calibre_Library";
	let calibre: CalibreDatabase | null = null;
	let calibreBook: CalibreBook | null = null;
	let dbWarning: string | undefined;

	try {
		try {
			calibre = await CalibreDatabase.open(libraryPath, libraryId);
			if (Number.isFinite(bookIdNum) && bookIdNum > 0) {
				calibreBook = calibre.getBookById(bookIdNum);
			}
		} catch (err) {
			dbWarning = err instanceof Error ? err.message : String(err);
		}

		const bookDir = calibreBook
			? path.join(libraryPath, calibreBook.path)
			: findBookDirectoryById(libraryPath, bookId);
		if (!bookDir) return null;

		const titleLabel = calibreBook?.title || path.basename(bookDir);
		const alreadyHasEpub = Boolean(findExistingEpubInDir(bookDir));
		if (!alreadyHasEpub) {
			onStatus?.(`Converting "${titleLabel}" to EPUB...`);
		}

		const conv = await ensureBookDirHasEpub(bookDir);
		const epubPath = conv.epubPath;

		if (calibre && calibreBook) {
			calibre.ensureEpubFormatRecord(calibreBook.bookId, epubPath);
			if (!calibreBook.formats.includes("EPUB")) {
				calibreBook.formats.unshift("EPUB");
			}
		}

		onStatus?.(`Indexing highlights in EPUB for "${titleLabel}"...`);

		// Gather highlights from Calibre annotations AND the vault Markdown note so both DB and note stay in sync.
		const targetNoteFile = noteFile || findNoteFileByBookId(app, bookId, calibreBook?.title);
		let noteContent = "";
		let noteHighlights: ParsedMarkdownHighlight[] = [];
		if (targetNoteFile) {
			try {
				noteContent = await app.vault.read(targetNoteFile);
				noteHighlights = extractHighlightsFromMarkdown(noteContent);
			} catch {
				/* ignore unreadable note */
			}
		}

		const dbHighlights = calibre && calibreBook ? calibre.getBookHighlightTexts(calibreBook.bookId) : [];

		interface MergedItem {
			text: string;
			note?: string;
			color?: string;
			refIds: string[];
		}
		const mergedByNorm = new Map<string, MergedItem>();
		for (const item of dbHighlights) {
			const key = normalizeTextKey(item.text);
			if (!key) continue;
			if (!mergedByNorm.has(key)) {
				mergedByNorm.set(key, { text: item.text, note: item.note, color: item.color, refIds: [] });
			}
		}
		for (const item of noteHighlights) {
			const key = normalizeTextKey(item.text);
			if (!key) continue;
			const existing = mergedByNorm.get(key);
			if (existing) {
				if (item.refId && !existing.refIds.includes(item.refId)) {
					existing.refIds.push(item.refId);
				}
				if (item.note && !existing.note) {
					existing.note = item.note;
				}
			} else {
				mergedByNorm.set(key, {
					text: item.text,
					note: item.note,
					refIds: item.refId ? [item.refId] : [],
				});
			}
		}

		const epubIndex = await buildEpubTextIndex(epubPath);
		const highlights: HighlightEntry[] = [];
		const linkByRefId = new Map<string, string>();
		const normSearchTarget = openAt.startsWith("search:") ? normalizeTextKey(openAt.slice(7)) : "";
		let resolvedOpenAt: string | undefined;

		for (const [normKey, item] of mergedByNorm.entries()) {
			const cfiInfo = epubIndex ? findCfiInIndex(epubIndex, item.text) : null;
			if (cfiInfo) {
				const rangeCfi = cfiInfo.rangeCfi || buildRangeCfi(cfiInfo.spineIndex, cfiInfo.startCfi, cfiInfo.endCfi);
				const pointCfi = cfiInfo.fullCfi || buildPointCfi(cfiInfo.spineIndex, cfiInfo.startCfi);
				highlights.push({
					text: item.text,
					range_cfi: rangeCfi,
					point_cfi: pointCfi,
					spine_index: cfiInfo.spineIndex,
					start_cfi: cfiInfo.startCfi,
					end_cfi: cfiInfo.endCfi,
				});

				if (!resolvedOpenAt && normSearchTarget && (normKey.includes(normSearchTarget) || normSearchTarget.includes(normKey))) {
					resolvedOpenAt = pointCfi;
				}
			}

			if (Number.isFinite(bookIdNum) && bookIdNum > 0) {
				const link = calibre && calibreBook
					? calibre.buildDeepLink(calibreBook, item.text, cfiInfo)
					: buildDeepLinkDirect(libraryId, bookIdNum, cfiInfo, item.text);
				for (const refId of item.refIds) {
					linkByRefId.set(refId, link);
				}
			}

			if (calibre && calibreBook && settings.injectCalibreAnnotations) {
				calibre.injectAnnotation(
					calibreBook.bookId,
					"EPUB",
					item.text,
					cfiInfo,
					item.note,
					item.color
				);
			}
		}

		if (!resolvedOpenAt && openAt.startsWith("search:") && epubIndex) {
			const directHit = findCfiInIndex(epubIndex, openAt.slice(7));
			if (directHit) {
				resolvedOpenAt = directHit.fullCfi;
			}
		}

		if (calibre) {
			try {
				await calibre.save();
			} catch (err) {
				dbWarning = err instanceof Error ? err.message : String(err);
			}
		}

		let noteUpdated = false;
		if (targetNoteFile && noteContent && linkByRefId.size > 0) {
			const updatedContent = noteContent.replace(
				/(location:\s*)\[(\d+)\]\(([^)]*)\)\s*\^ref-(\w+)/g,
				(fullMatch, prefix: string, loc: string, existingLink: string, refId: string) => {
					const newLink = linkByRefId.get(refId);
					if (newLink && newLink !== existingLink) {
						return `${prefix}[${loc}](${newLink}) ^ref-${refId}`;
					}
					return fullMatch;
				}
			);
			if (updatedContent !== noteContent) {
				try {
					await app.vault.modify(targetNoteFile, updatedContent);
					noteUpdated = true;
				} catch {
					/* non-fatal if note is locked or read-only */
				}
			}
		}

		const bookRecord: BooksIndexRecord = {
			id: Number.isFinite(bookIdNum) ? bookIdNum : undefined,
			title: calibreBook?.title || titleLabel,
			authors: calibreBook?.authors || "",
			epub_path: epubPath,
			highlights,
		};

		return {
			bookId,
			epubPath,
			converted: conv.converted,
			sourceFormat: conv.sourceFormat,
			bookRecord,
			resolvedOpenAt,
			noteUpdated,
			dbWarning,
		};
	} finally {
		calibre?.close();
	}
}
