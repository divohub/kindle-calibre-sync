import { App } from "obsidian";
import type { BooksIndex, CalibreBook, KindleCalibreSettings, SyncSummary } from "../types";
import { CalibreDatabase, detectCalibreLibraryPath } from "./calibreDb";
import { parseClippingsContent, parseClippingsFile } from "./clippingsParser";
import { buildEpubTextIndex, findCfiInIndex, type EpubTextIndex } from "./epubCfi";
import { resolveHighlightsFolder, VaultExporter } from "./obsidianExporter";

export interface SyncRunOptions {
	app: App;
	settings: KindleCalibreSettings;
	clippingsSource: { path: string; content?: string };
	onProgress?: (message: string) => void;
}

export interface SyncRunResult {
	summary: SyncSummary;
	booksIndex: BooksIndex | null;
	resolvedCalibrePath: string | null;
	resolvedFolder: string;
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
 * parse My Clippings.txt -> match Calibre books -> compute EPUB CFIs ->
 * inject annotations into Calibre DB -> export/update vault markdown notes -> refresh BooksIndex.
 */
export async function runNativeSync(options: SyncRunOptions): Promise<SyncRunResult> {
	const { app, settings, clippingsSource, onProgress } = options;

	const booksClippings =
		typeof clippingsSource.content === "string"
			? parseClippingsContent(clippingsSource.content)
			: parseClippingsFile(clippingsSource.path);

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

	const epubIndexCache = new Map<string, EpubTextIndex | null>();

	try {
		let bookIdx = 0;
		const totalBooks = booksClippings.size;

		for (const [title, clippings] of booksClippings.entries()) {
			bookIdx++;
			if (onProgress) {
				onProgress(`Syncing (${bookIdx}/${totalBooks}): ${title}`);
			}

			const author = clippings[0]?.author || "";
			let calibreBook: CalibreBook | null = null;
			const calibreLinks = new Map<string, string>();

			if (calibre) {
				calibreBook = calibre.findBook(title, author);
			}

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

				const fmt = calibreBook.formats.includes("EPUB")
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

		if (calibre && settings.injectCalibreAnnotations) {
			try {
				await calibre.save();
			} catch (err) {
				calibreWarning = err instanceof Error ? err.message : String(err);
			}
		}

		const booksIndex = calibre ? calibre.exportBooksIndex() : null;

		return {
			summary: {
				clippingsPath: clippingsSource.path,
				totalBooks: booksClippings.size,
				totalClips,
				matchedBooks,
				cfiFound,
				injectedAnnots,
				notesUpdated,
				highlightsFolder: resolvedFolder,
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
