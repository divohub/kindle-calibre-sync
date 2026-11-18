import * as fs from "node:fs";
import * as path from "node:path";
import type { Clipping } from "../types";
import { mergeBookClippingsMaps } from "./bookMerge";
import { CalibreDatabase, getSqlJs } from "./calibreDb";
import {
	extractKfxTextRange,
	kfxPidToLocation,
	parseKfxBook,
	readKfxFileMetadata,
	type KfxMetadata,
	type KfxParsedBook,
} from "./kfxReader";
import {
	describeDetectedSyncSources,
	detectSyncSourcesAsync,
	findLocalKsdkDbPath,
	getKsdkCacheFilePath,
	saveKsdkDbCache,
	type DetectSyncSourcesOptions,
	type DetectedSyncSources,
	type SyncSourceKind,
} from "./sourceDetector";
import {
	appendOrMergeNoteText,
	computeRefId,
	isIncrementalTextEdit,
	normalizeAlnumKey,
	normalizeEditCompareText,
	normalizeHighlightDedupKey,
} from "./textUtils";

export {
	normalizeAlnumKey as cleanBookTitleKey,
	normalizeHighlightDedupKey,
	mergeBookClippingsMaps as mergeClippingsAndKsdkBooks,
	describeDetectedSyncSources,
	detectSyncSourcesAsync,
	findLocalKsdkDbPath,
	getKsdkCacheFilePath,
	saveKsdkDbCache,
	type DetectSyncSourcesOptions,
	type DetectedSyncSources,
	type SyncSourceKind,
};

export interface KfxIndexEntry {
	filePath: string;
	meta: KfxMetadata;
}

export interface KsdkParseStats {
	dbRowsTotal: number;
	highlightsParsed: number;
	notesParsed: number;
	matchedBooks: number;
	unresolvedAsins: string[];
}

export interface KsdkParseResult {
	books: Map<string, Clipping[]>;
	stats: KsdkParseStats;
}

export interface KfxResolverContext {
	kfxSearchDirs: string[];
	calibreAuthorByTitle?: Map<string, string>;
}

interface RawPositionJson {
	shortPosition?: unknown;
}

interface RawPayloadJson {
	book_data?: {
		asin?: unknown;
		guid?: unknown;
		contentType?: unknown;
	};
	json_metadata?: unknown;
	created_time?: unknown;
	type?: unknown;
}

interface RawNoteMetaJson {
	note_text?: unknown;
}

interface ParsedHighlightItem {
	asin: string;
	startPid: number;
	endPid: number;
	createdTime: number;
	clipping: Clipping;
}

interface ParsedNoteItem {
	asin: string;
	startPid: number;
	endPid: number;
	createdTime: number;
	noteText: string;
}

function formatIsoDateForClipping(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	try {
		return new Date(ms).toISOString();
	} catch {
		return "";
	}
}

function parseShortPosition(raw: unknown): number | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	try {
		const parsed = JSON.parse(raw) as RawPositionJson;
		return typeof parsed.shortPosition === "number" ? parsed.shortPosition : null;
	} catch {
		return null;
	}
}

function collectKfxFilePaths(dirs: string[]): string[] {
	const seenDirs = new Set<string>();
	const kfxPaths: string[] = [];

	const walk = (dirPath: string, depth: number): void => {
		if (depth > 4) return;
		let realDir: string;
		try {
			realDir = fs.realpathSync(dirPath);
		} catch {
			return;
		}
		if (seenDirs.has(realDir)) return;
		seenDirs.add(realDir);

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dirPath, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);
			let isDir = entry.isDirectory();
			if (!isDir && entry.isSymbolicLink()) {
				try {
					isDir = fs.statSync(fullPath).isDirectory();
				} catch {
					isDir = false;
				}
			}
			if (isDir) {
				walk(fullPath, depth + 1);
			} else if (entry.name.toLowerCase().endsWith(".kfx")) {
				kfxPaths.push(fullPath);
			}
		}
	};

	for (const dir of dirs) {
		if (!dir) continue;
		const resolved = path.resolve(dir);
		if (fs.existsSync(resolved)) {
			walk(resolved, 0);
		}
	}

	return kfxPaths;
}

/**
 * Builds an ASIN/assetId/bookId -> .kfx file path index across local Calibre Library and/or USB/GVFS Kindle.
 */
export async function indexKfxFilesByAsin(searchDirs: string[]): Promise<Map<string, KfxIndexEntry>> {
	const files = collectKfxFilePaths(searchDirs);
	const byId = new Map<string, KfxIndexEntry>();

	for (const filePath of files) {
		const meta = await readKfxFileMetadata(filePath);
		if (!meta) continue;
		const entry: KfxIndexEntry = { filePath, meta };
		if (meta.asin && !byId.has(meta.asin)) {
			byId.set(meta.asin, entry);
		}
		if (meta.assetId && !byId.has(meta.assetId)) {
			byId.set(meta.assetId, entry);
		}
		if (meta.bookId && !byId.has(meta.bookId)) {
			byId.set(meta.bookId, entry);
		}
	}

	return byId;
}

/**
 * Builds normalized book title -> author_sort map from Calibre metadata.db when available,
 * so newly created Obsidian notes keep Calibre's `Surname, Name` filename convention.
 */
export async function loadCalibreAuthorMap(calibreLibraryPath: string): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (!calibreLibraryPath) return map;
	try {
		const db = await CalibreDatabase.open(calibreLibraryPath);
		try {
			for (const book of db.getAllBooks()) {
				const key = normalizeAlnumKey(book.title);
				if (key && book.authors && !map.has(key)) {
					map.set(key, book.authors);
				}
			}
		} finally {
			db.close();
		}
	} catch {
		/* optional enrichment only */
	}
	return map;
}

function findBestKsdkHighlightIdx(note: ParsedNoteItem, hlItems: ParsedHighlightItem[]): number {
	let bestIdx = -1;
	let bestScore = -Infinity;

	for (let hi = 0; hi < hlItems.length; hi++) {
		const h = hlItems[hi];
		const strictlyInside = note.startPid >= h.startPid && note.endPid <= h.endPid;
		const overlaps = note.endPid >= h.startPid && note.startPid <= h.endPid;
		const nearFallback = note.endPid >= h.startPid - 30 && note.startPid <= h.endPid + 30;
		if (!nearFallback) continue;

		let score = strictlyInside ? 1000 : overlaps ? 600 : 150;
		if (!overlaps) {
			const dist =
				note.endPid < h.startPid
					? h.startPid - note.endPid
					: note.startPid - h.endPid;
			score -= dist;
		}
		score -= Math.min(2000, Math.max(0, h.endPid - h.startPid)) * 0.01;
		if (note.createdTime > 0 && h.createdTime > 0) {
			const diffSec = Math.abs(note.createdTime - h.createdTime) / 1000;
			if (diffSec <= 5) score += 200;
			else if (diffSec <= 60) score += 100;
		}

		if (score > bestScore) {
			bestScore = score;
			bestIdx = hi;
		}
	}

	return bestIdx;
}

function shouldReplaceKsdkNoteEntry(
	prev: { startPid: number; endPid: number; text: string },
	cur: ParsedNoteItem
): boolean {
	if (prev.startPid === cur.startPid && prev.endPid === cur.endPid) {
		return true;
	}
	if (Math.abs(prev.startPid - cur.startPid) <= 5) {
		return (
			normalizeEditCompareText(prev.text) === normalizeEditCompareText(cur.noteText) ||
			isIncrementalTextEdit(prev.text, cur.noteText)
		);
	}
	return false;
}

/**
 * Parses Kindle's ksdk_annotation_v1.db SQLite database and resolves KFX highlights & notes
 * into standard Clipping entries using local .kfx books.
 */
export async function parseKsdkAnnotationsDb(
	dbBytes: Uint8Array,
	ctx: KfxResolverContext
): Promise<KsdkParseResult> {
	const SQL = await getSqlJs();
	const db = new SQL.Database(dbBytes);

	const stats: KsdkParseStats = {
		dbRowsTotal: 0,
		highlightsParsed: 0,
		notesParsed: 0,
		matchedBooks: 0,
		unresolvedAsins: [],
	};
	const books = new Map<string, Clipping[]>();

	try {
		const tableCheck = db.exec(
			"SELECT name FROM sqlite_master WHERE type='table' AND name='nonsyncable_annotations'"
		);
		if (!tableCheck[0]?.values?.length) {
			return { books, stats };
		}

		const res = db.exec(
			"SELECT book_id, dataset, start_position, end_position, created_time, serialized_payload FROM nonsyncable_annotations WHERE dataset IN (1, 3) ORDER BY created_time ASC, rowid ASC"
		);
		const rows = res[0]?.values ?? [];
		stats.dbRowsTotal = rows.length;
		if (rows.length === 0) {
			return { books, stats };
		}

		interface PendingRow {
			asin: string;
			dataset: number;
			startPid: number;
			endPid: number;
			createdTime: number;
			noteText: string;
		}

		const pendingRows: PendingRow[] = [];

		for (const row of rows) {
			const bookIdCol = String(row[0] ?? "");
			const dataset = Number(row[1] ?? 0);
			const startPid = parseShortPosition(row[2]);
			const endPid = parseShortPosition(row[3]);
			const createdTime = Number(row[4] ?? 0);
			const payloadStr = typeof row[5] === "string" ? row[5] : "";

			if (startPid === null || endPid === null || !payloadStr) continue;

			let payload: RawPayloadJson;
			try {
				payload = JSON.parse(payloadStr) as RawPayloadJson;
			} catch {
				continue;
			}

			const asinFromPayload =
				typeof payload.book_data?.asin === "string" ? payload.book_data.asin : "";
			const asinFromBookId = bookIdCol.split(/-(?:PDOC|EBOK)-/)[0] || "";
			const asin = asinFromPayload || asinFromBookId;
			if (!asin) continue;

			let noteText = "";
			if (dataset === 3 && typeof payload.json_metadata === "string") {
				try {
					const metaObj = JSON.parse(payload.json_metadata) as RawNoteMetaJson;
					if (typeof metaObj.note_text === "string") {
						noteText = metaObj.note_text.trim();
					}
				} catch {
					/* ignore malformed note metadata */
				}
			}

			const rowCreated =
				typeof payload.created_time === "number" ? payload.created_time : createdTime;

			pendingRows.push({
				asin,
				dataset,
				startPid,
				endPid: Math.max(startPid, endPid),
				createdTime: rowCreated,
				noteText,
			});
		}

		if (pendingRows.length === 0) {
			return { books, stats };
		}

		const kfxIndex = await indexKfxFilesByAsin(ctx.kfxSearchDirs);
		const parsedBookCache = new Map<string, KfxParsedBook>();
		const resolvedMetaCache = new Map<string, { title: string; author: string }>();
		const missingAsins = new Set<string>();

		const getParsedBookForAsin = (
			asin: string
		): { parsed: KfxParsedBook; title: string; author: string } | null => {
			if (missingAsins.has(asin)) return null;
			const cachedParsed = parsedBookCache.get(asin);
			const cachedMeta = resolvedMetaCache.get(asin);
			if (cachedParsed && cachedMeta) {
				return { parsed: cachedParsed, ...cachedMeta };
			}

			const idxEntry = kfxIndex.get(asin);
			if (!idxEntry) {
				missingAsins.add(asin);
				return null;
			}

			try {
				const rawBytes = new Uint8Array(fs.readFileSync(idxEntry.filePath));
				const parsed = parseKfxBook(rawBytes);
				const title = parsed.metadata.title || idxEntry.meta.title || asin;
				const calibreAuthor = ctx.calibreAuthorByTitle?.get(normalizeAlnumKey(title));
				const author =
					calibreAuthor ||
					(parsed.metadata.authors.length > 0
						? parsed.metadata.authors.join(", ")
						: idxEntry.meta.authors.join(", "));
				parsedBookCache.set(asin, parsed);
				resolvedMetaCache.set(asin, { title, author });
				return { parsed, title, author };
			} catch {
				missingAsins.add(asin);
				return null;
			}
		};

		const highlightsByAsin = new Map<string, ParsedHighlightItem[]>();
		const notesByAsin = new Map<string, ParsedNoteItem[]>();

		for (const row of pendingRows) {
			const bookData = getParsedBookForAsin(row.asin);
			if (!bookData) continue;

			const { parsed, title, author } = bookData;

			if (row.dataset === 1) {
				const text = extractKfxTextRange(parsed.chunks, row.startPid, row.endPid);
				if (!text) continue;
				const locationStart = kfxPidToLocation(parsed.locationPids, row.startPid);
				const locationEnd = Math.max(
					locationStart,
					kfxPidToLocation(parsed.locationPids, row.endPid)
				);
				const item: ParsedHighlightItem = {
					asin: row.asin,
					startPid: row.startPid,
					endPid: row.endPid,
					createdTime: row.createdTime,
					clipping: {
						title,
						author,
						entryType: "highlight",
						page: null,
						locationStart,
						locationEnd,
						dateStr: formatIsoDateForClipping(row.createdTime),
						text,
						refId: computeRefId(title, locationStart, text),
					},
				};
				const list = highlightsByAsin.get(row.asin);
				if (list) list.push(item);
				else highlightsByAsin.set(row.asin, [item]);
				stats.highlightsParsed++;
			} else if (row.dataset === 3 && row.noteText) {
				const noteItem: ParsedNoteItem = {
					asin: row.asin,
					startPid: row.startPid,
					endPid: row.endPid,
					createdTime: row.createdTime,
					noteText: row.noteText,
				};
				const list = notesByAsin.get(row.asin);
				if (list) list.push(noteItem);
				else notesByAsin.set(row.asin, [noteItem]);
				stats.notesParsed++;
			}
		}

		// Attach dataset=3 notes to best-matching highlights in the same book, or emit deduplicated standalone note
		for (const asin of new Set([...highlightsByAsin.keys(), ...notesByAsin.keys()])) {
			const metaInfo = resolvedMetaCache.get(asin);
			const parsed = parsedBookCache.get(asin);
			if (!metaInfo || !parsed) continue;

			const hlItems = highlightsByAsin.get(asin) ?? [];
			const noteItems = notesByAsin.get(asin) ?? [];
			const attachedNotesByHl = new Map<
				number,
				Array<{ startPid: number; endPid: number; text: string }>
			>();
			const standaloneEntries: Array<{ item: ParsedNoteItem; clip: Clipping }> = [];

			for (const n of noteItems) {
				const matchedIdx = findBestKsdkHighlightIdx(n, hlItems);
				if (matchedIdx >= 0) {
					let noteList = attachedNotesByHl.get(matchedIdx);
					if (!noteList) {
						noteList = [];
						attachedNotesByHl.set(matchedIdx, noteList);
					}
					let replacedIdx = -1;
					for (let k = noteList.length - 1; k >= 0; k--) {
						if (shouldReplaceKsdkNoteEntry(noteList[k], n)) {
							replacedIdx = k;
							break;
						}
					}
					const entry = { startPid: n.startPid, endPid: n.endPid, text: n.noteText };
					if (replacedIdx >= 0) {
						noteList[replacedIdx] = entry;
					} else {
						noteList.push(entry);
					}
				} else {
					const contextText = extractKfxTextRange(parsed.chunks, n.startPid, n.endPid);
					const locationStart = kfxPidToLocation(parsed.locationPids, n.startPid);
					const locationEnd = Math.max(
						locationStart,
						kfxPidToLocation(parsed.locationPids, n.endPid)
					);
					const clipText = contextText || n.noteText;
					const clip: Clipping = {
						title: metaInfo.title,
						author: metaInfo.author,
						entryType: "note",
						page: null,
						locationStart,
						locationEnd,
						dateStr: formatIsoDateForClipping(n.createdTime),
						text: clipText,
						refId: computeRefId(metaInfo.title, locationStart, clipText),
						note: contextText ? n.noteText : undefined,
					};

					let replacedStandalone = false;
					for (let k = standaloneEntries.length - 1; k >= 0; k--) {
						const prev = standaloneEntries[k].item;
						if (
							shouldReplaceKsdkNoteEntry(
								{ startPid: prev.startPid, endPid: prev.endPid, text: prev.noteText },
								n
							)
						) {
							standaloneEntries[k] = { item: n, clip };
							replacedStandalone = true;
							break;
						}
					}
					if (!replacedStandalone) {
						standaloneEntries.push({ item: n, clip });
					}
				}
			}

			for (const [hi, noteList] of attachedNotesByHl.entries()) {
				let combinedNote = hlItems[hi].clipping.note;
				for (const entry of noteList) {
					combinedNote = appendOrMergeNoteText(combinedNote, entry.text, {
						replaceIncremental: false,
					});
				}
				if (combinedNote) {
					hlItems[hi].clipping.note = combinedNote;
				}
			}

			const resultClips: Clipping[] = [
				...hlItems.map((h) => h.clipping),
				...standaloneEntries.map((s) => s.clip),
			];

			if (resultClips.length > 0) {
				const existing = books.get(metaInfo.title);
				if (existing) {
					existing.push(...resultClips);
				} else {
					books.set(metaInfo.title, resultClips);
				}
			}
		}

		stats.matchedBooks = books.size;
		stats.unresolvedAsins = Array.from(missingAsins);
		return { books, stats };
	} finally {
		db.close();
	}
}
