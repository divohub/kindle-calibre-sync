import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Clipping } from "../types";
import { CalibreDatabase, getSqlJs } from "./calibreDb";
import { computeRefId } from "./clippingsParser";
import {
	extractKfxTextRange,
	kfxPidToLocation,
	parseKfxBook,
	readKfxFileMetadata,
	type KfxMetadata,
	type KfxParsedBook,
} from "./kfxReader";
import { readMtpKindleSources } from "./mtpClient";

const KSDK_CACHE_FILENAME = "ksdk_annotation_v1.cache.db";

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

export function cleanBookTitleKey(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "")
		.trim();
}

export function normalizeHighlightDedupKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/[«»“”„"']/g, '"')
		.replace(/[–—−‐\u00a0]/g, " ")
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
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
				const key = cleanBookTitleKey(book.title);
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

export function getKsdkCacheFilePath(vaultBasePath?: string): string {
	if (vaultBasePath) {
		return path.join(
			vaultBasePath,
			".obsidian",
			"plugins",
			"kindle-calibre-sync",
			KSDK_CACHE_FILENAME
		);
	}
	return path.join(os.homedir(), ".config", "kindle-calibre-sync", KSDK_CACHE_FILENAME);
}

/**
 * Persists a local snapshot of Kindle's ksdk_annotation_v1.db so future syncs can run offline without Kindle attached.
 */
export async function saveKsdkDbCache(dbBytes: Uint8Array, vaultBasePath?: string): Promise<string | null> {
	const target = getKsdkCacheFilePath(vaultBasePath);
	try {
		await fs.promises.mkdir(path.dirname(target), { recursive: true });
		if (fs.existsSync(target)) {
			const existing = await fs.promises.readFile(target);
			if (existing.length === dbBytes.length && Buffer.compare(existing, dbBytes) === 0) {
				return target;
			}
		}
		await fs.promises.writeFile(target, dbBytes);
		return target;
	} catch {
		return null;
	}
}

export function findLocalKsdkDbPath(
	configuredPath?: string,
	vaultBasePath?: string,
	clippingsPath?: string
): string | null {
	const candidates: string[] = [];
	if (configuredPath?.trim()) {
		const expanded = configuredPath.trim().startsWith("~/")
			? path.join(os.homedir(), configuredPath.trim().slice(2))
			: configuredPath.trim();
		candidates.push(path.resolve(expanded));
	}

	const home = os.homedir();
	if (clippingsPath) {
		candidates.push(path.join(path.dirname(clippingsPath), "ksdk_annotation_v1.db"));
	}
	candidates.push(
		path.join(home, "ksdk_annotation_v1.db"),
		path.join(home, "Downloads", "ksdk_annotation_v1.db"),
		path.join(home, "Documents", "ksdk_annotation_v1.db"),
		path.join(home, "Desktop", "ksdk_annotation_v1.db")
	);

	if (vaultBasePath) {
		candidates.push(getKsdkCacheFilePath(vaultBasePath));
	}
	candidates.push(getKsdkCacheFilePath(undefined));

	for (const candidate of candidates) {
		try {
			if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				return candidate;
			}
		} catch {
			/* ignore inaccessible candidates */
		}
	}
	return null;
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
			"SELECT book_id, dataset, start_position, end_position, created_time, serialized_payload FROM nonsyncable_annotations WHERE dataset IN (1, 3) ORDER BY created_time ASC"
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
		const neededAsins = new Set<string>();

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

			neededAsins.add(asin);
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
				const calibreAuthor = ctx.calibreAuthorByTitle?.get(cleanBookTitleKey(title));
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

		// Attach dataset=3 notes to overlapping highlights in the same book, or emit standalone note
		for (const asin of new Set([...highlightsByAsin.keys(), ...notesByAsin.keys()])) {
			const metaInfo = resolvedMetaCache.get(asin);
			const parsed = parsedBookCache.get(asin);
			if (!metaInfo || !parsed) continue;

			const hlItems = highlightsByAsin.get(asin) ?? [];
			const noteItems = notesByAsin.get(asin) ?? [];
			const resultClips: Clipping[] = hlItems.map((h) => h.clipping);

			for (const n of noteItems) {
				let matched: ParsedHighlightItem | null = null;
				for (const h of hlItems) {
					const overlaps = n.endPid >= h.startPid - 30 && n.startPid <= h.endPid + 30;
					if (overlaps) {
						matched = h;
						break;
					}
				}
				if (matched) {
					matched.clipping.note = matched.clipping.note
						? `${matched.clipping.note}\n${n.noteText}`
						: n.noteText;
				} else {
					const contextText = extractKfxTextRange(parsed.chunks, n.startPid, n.endPid);
					const locationStart = kfxPidToLocation(parsed.locationPids, n.startPid);
					const locationEnd = Math.max(
						locationStart,
						kfxPidToLocation(parsed.locationPids, n.endPid)
					);
					const clipText = contextText || n.noteText;
					resultClips.push({
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
					});
				}
			}

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

/**
 * Merges legacy My Clippings.txt highlights with ksdk_annotation_v1.db highlights,
 * preserving legacy entries/refIds without duplication and appending any missing/new highlights & notes.
 */
export function mergeClippingsAndKsdkBooks(
	legacyBooks: Map<string, Clipping[]>,
	ksdkBooks: Map<string, Clipping[]>
): Map<string, Clipping[]> {
	const merged = new Map<string, Clipping[]>();
	const keyToCanonicalTitle = new Map<string, string>();

	for (const [title, clips] of legacyBooks.entries()) {
		merged.set(title, clips.map((c) => ({ ...c })));
		const key = cleanBookTitleKey(title);
		if (key && !keyToCanonicalTitle.has(key)) {
			keyToCanonicalTitle.set(key, title);
		}
	}

	for (const [dbTitle, dbClips] of ksdkBooks.entries()) {
		const dbTitleKey = cleanBookTitleKey(dbTitle);
		const targetTitle = merged.has(dbTitle)
			? dbTitle
			: keyToCanonicalTitle.get(dbTitleKey) || dbTitle;

		const targetList = merged.get(targetTitle);
		if (!targetList) {
			merged.set(
				targetTitle,
				dbClips.map((c) => ({ ...c }))
			);
			if (dbTitleKey) {
				keyToCanonicalTitle.set(dbTitleKey, targetTitle);
			}
			continue;
		}

		// Index existing highlights by normalized text for dedup
		const existingByNorm = new Map<string, Clipping>();
		for (const c of targetList) {
			const norm = normalizeHighlightDedupKey(c.text);
			if (norm) existingByNorm.set(norm, c);
		}

		for (const dbClip of dbClips) {
			const norm = normalizeHighlightDedupKey(dbClip.text);
			if (!norm) continue;

			let duplicateOf = existingByNorm.get(norm);
			if (!duplicateOf && norm.length >= 25) {
				for (const [existingNorm, existingClip] of existingByNorm.entries()) {
					if (
						existingNorm.length >= 25 &&
						(existingNorm.includes(norm) || norm.includes(existingNorm))
					) {
						duplicateOf = existingClip;
						break;
					}
				}
			}

			if (duplicateOf) {
				if (dbClip.note && !duplicateOf.note) {
					duplicateOf.note = dbClip.note;
				}
				continue;
			}

			const clone: Clipping = {
				...dbClip,
				title: targetTitle,
				author: dbClip.author || targetList[0]?.author || "",
			};
			targetList.push(clone);
			existingByNorm.set(norm, clone);
		}
	}

	return merged;
}

export type SyncSourceKind =
	| "kindle-usb"
	| "kindle-mtp"
	| "configured-file"
	| "local-fallback"
	| "missing";

export interface DetectedSyncSources {
	clippingsSource: { path: string; content?: string } | null;
	ksdkDb: { path: string; data: Uint8Array; fromCache: boolean } | null;
	extraKfxDirs: string[];
	sourceKind: SyncSourceKind;
	deviceDetectedNotReady: boolean;
	mtpWarning?: string;
	fallbackClippingsSource: { path: string; content?: string } | null;
	fallbackKsdkDb: { path: string; data: Uint8Array; fromCache: boolean } | null;
}

export interface DetectSyncSourcesOptions {
	clippingsPath?: string;
	ksdkDbPath?: string;
	vaultBasePath?: string;
}

function getUsbMountCandidates(): string[] {
	const platform = os.platform();
	const candidates: string[] = [];

	if (platform === "linux") {
		const user = os.userInfo().username || process.env.USER || "";
		const parentDirs = [
			"/Volumes",
			"/mnt",
			"/media",
			"/run/media",
			user ? `/media/${user}` : "",
			user ? `/run/media/${user}` : "",
		].filter(Boolean);

		for (const parent of parentDirs) {
			try {
				if (!fs.existsSync(parent)) continue;
				const stat = fs.statSync(parent);
				if (!stat.isDirectory()) continue;
				for (const sub of fs.readdirSync(parent, { withFileTypes: true })) {
					if (sub.isDirectory()) {
						candidates.push(path.join(parent, sub.name));
					}
				}
			} catch {
				/* ignore unreadable mount dir */
			}
		}
	} else if (platform === "darwin") {
		try {
			for (const sub of fs.readdirSync("/Volumes", { withFileTypes: true })) {
				if (sub.isDirectory()) {
					candidates.push(path.join("/Volumes", sub.name));
				}
			}
		} catch {
			/* ignore */
		}
	} else if (platform === "win32") {
		for (let code = 68; code <= 90; code++) {
			const drive = `${String.fromCharCode(code)}:\\`;
			try {
				if (fs.existsSync(drive)) {
					candidates.push(drive);
				}
			} catch {
				/* ignore unavailable drive */
			}
		}
	}

	return candidates;
}

function findUsbKsdkDb(rootDir: string): string | null {
	const annDir = path.join(rootDir, "system", "ksdk", ".annotations");
	try {
		if (!fs.existsSync(annDir)) return null;
		let bestPath: string | null = null;
		let bestSize = -1;
		for (const sub of fs.readdirSync(annDir, { withFileTypes: true })) {
			if (!sub.isDirectory()) continue;
			const dbPath = path.join(annDir, sub.name, "ksdk_annotation_v1.db");
			if (!fs.existsSync(dbPath)) continue;
			const st = fs.statSync(dbPath);
			if (st.isFile() && st.size > bestSize) {
				bestSize = st.size;
				bestPath = dbPath;
			}
		}
		return bestPath;
	} catch {
		return null;
	}
}

function findUsbClippingsPath(rootDir: string): string | null {
	const candidates = [
		path.join(rootDir, "documents", "My Clippings.txt"),
		path.join(rootDir, "Documents", "My Clippings.txt"),
		path.join(rootDir, "My Clippings.txt"),
	];
	for (const p of candidates) {
		try {
			if (fs.existsSync(p) && fs.statSync(p).isFile()) {
				return p;
			}
		} catch {
			/* ignore */
		}
	}
	return null;
}

function resolveUserPath(rawPath?: string): string | null {
	const trimmed = rawPath?.trim();
	if (!trimmed) return null;
	const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	return path.resolve(expanded);
}

function findLocalClippingsFile(
	configuredPath?: string,
	vaultBasePath?: string
): { path: string; isConfigured: boolean } | null {
	const configured = resolveUserPath(configuredPath);
	if (configured) {
		try {
			if (fs.existsSync(configured) && fs.statSync(configured).isFile()) {
				return { path: configured, isConfigured: true };
			}
		} catch {
			/* fall through */
		}
	}

	const home = os.homedir();
	const fallbacks = [
		path.join(home, "My Clippings.txt"),
		path.join(home, "Documents", "My Clippings.txt"),
		path.join(home, "Desktop", "My Clippings.txt"),
		path.join(home, "Downloads", "My Clippings.txt"),
		vaultBasePath ? path.join(vaultBasePath, "My Clippings.txt") : "",
	].filter(Boolean);

	for (const candidate of fallbacks) {
		try {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				return { path: candidate, isConfigured: false };
			}
		} catch {
			/* ignore */
		}
	}

	return null;
}

function readLocalKsdkFallback(
	configuredKsdkPath?: string,
	vaultBasePath?: string,
	localClippingsPath?: string
): { ksdkDb: { path: string; data: Uint8Array; fromCache: boolean } | null; isConfigured: boolean } {
	const resolvedCfg = resolveUserPath(configuredKsdkPath);
	const foundPath = findLocalKsdkDbPath(configuredKsdkPath, vaultBasePath, localClippingsPath);
	if (!foundPath) return { ksdkDb: null, isConfigured: false };
	try {
		const data = new Uint8Array(fs.readFileSync(foundPath));
		const isCache = path.basename(foundPath) === KSDK_CACHE_FILENAME;
		const isConfigured = Boolean(resolvedCfg && path.resolve(foundPath) === resolvedCfg);
		return {
			ksdkDb: { path: foundPath, data, fromCache: isCache },
			isConfigured,
		};
	} catch {
		return { ksdkDb: null, isConfigured: false };
	}
}

export function describeDetectedSyncSources(sources: DetectedSyncSources): string {
	const parts: string[] = [];
	if (sources.clippingsSource) {
		parts.push("My Clippings.txt");
	}
	if (sources.ksdkDb) {
		parts.push(
			sources.ksdkDb.fromCache ? "cached ksdk_annotation_v1.db" : "ksdk_annotation_v1.db"
		);
	}
	const detail = parts.length > 0 ? ` (${parts.join(" + ")})` : "";
	switch (sources.sourceKind) {
		case "kindle-usb":
			return `Kindle USB${detail}`;
		case "kindle-mtp":
			return `Kindle MTP${detail}`;
		case "configured-file":
			return `configured local file${detail}`;
		case "local-fallback":
			return `local fallback${detail}`;
		default:
			return "no sources found";
	}
}

/**
 * Detects live Kindle sources (USB Mass Storage / MTP) and local/cached fallbacks
 * for both legacy My Clippings.txt and Kindle's ksdk_annotation_v1.db.
 */
export async function detectSyncSourcesAsync(
	options: DetectSyncSourcesOptions
): Promise<DetectedSyncSources> {
	const { clippingsPath, ksdkDbPath, vaultBasePath } = options;

	// 1. Live USB Mass Storage Kindle
	for (const mountRoot of getUsbMountCandidates()) {
		const isKindleMount =
			/kindle/i.test(path.basename(mountRoot)) ||
			fs.existsSync(path.join(mountRoot, "system", "ksdk")) ||
			fs.existsSync(path.join(mountRoot, "documents", "My Clippings.txt"));
		if (!isKindleMount) continue;

		const usbClip = findUsbClippingsPath(mountRoot);
		const usbDbPath = findUsbKsdkDb(mountRoot);
		if (usbClip || usbDbPath) {
			let ksdkDb: DetectedSyncSources["ksdkDb"] = null;
			if (usbDbPath) {
				const data = new Uint8Array(await fs.promises.readFile(usbDbPath));
				await saveKsdkDbCache(data, vaultBasePath);
				ksdkDb = { path: usbDbPath, data, fromCache: false };
			}
			const localClipFallback = !usbClip
				? findLocalClippingsFile(clippingsPath, vaultBasePath)
				: null;

			const docsDir = path.join(mountRoot, "documents");
			return {
				clippingsSource: usbClip
					? { path: usbClip }
					: localClipFallback
						? { path: localClipFallback.path }
						: null,
				ksdkDb,
				extraKfxDirs: fs.existsSync(docsDir) ? [docsDir] : [],
				sourceKind: "kindle-usb",
				deviceDetectedNotReady: false,
				fallbackClippingsSource: null,
				fallbackKsdkDb: null,
			};
		}
	}

	// 2. Live MTP Kindle (GVFS / GIO / Calibre MTP / libmtp)
	const mtp = await readMtpKindleSources();
	const localClip = findLocalClippingsFile(clippingsPath, vaultBasePath);
	const localDb = readLocalKsdkFallback(ksdkDbPath, vaultBasePath, localClip?.path);

	if (mtp.clippings || mtp.ksdkDb) {
		let ksdkDb: DetectedSyncSources["ksdkDb"] = null;
		if (mtp.ksdkDb) {
			await saveKsdkDbCache(mtp.ksdkDb.data, vaultBasePath);
			ksdkDb = {
				path: mtp.ksdkDb.path,
				data: mtp.ksdkDb.data,
				fromCache: false,
			};
		}

		const extraKfxDirs: string[] = [];
		if (mtp.deviceRootDir) {
			const mtpDocs = path.join(mtp.deviceRootDir, "documents");
			if (fs.existsSync(mtpDocs)) {
				extraKfxDirs.push(mtpDocs);
			}
		}

		return {
			clippingsSource: mtp.clippings
				? { path: mtp.clippings.path, content: mtp.clippings.content }
				: localClip
					? { path: localClip.path }
					: null,
			ksdkDb: ksdkDb ?? localDb.ksdkDb,
			extraKfxDirs,
			sourceKind: "kindle-mtp",
			deviceDetectedNotReady: false,
			fallbackClippingsSource: null,
			fallbackKsdkDb: null,
		};
	}

	if (mtp.warning) {
		return {
			clippingsSource: null,
			ksdkDb: null,
			extraKfxDirs: [],
			sourceKind: "missing",
			deviceDetectedNotReady: true,
			mtpWarning: mtp.warning,
			fallbackClippingsSource: localClip ? { path: localClip.path } : null,
			fallbackKsdkDb: localDb.ksdkDb,
		};
	}

	// 3. Offline ("без киндла"): local My Clippings.txt + configured/local/cached ksdk_annotation_v1.db
	if (localClip || localDb.ksdkDb) {
		const isConfigured = Boolean(localClip?.isConfigured || localDb.isConfigured);
		return {
			clippingsSource: localClip ? { path: localClip.path } : null,
			ksdkDb: localDb.ksdkDb,
			extraKfxDirs: [],
			sourceKind: isConfigured ? "configured-file" : "local-fallback",
			deviceDetectedNotReady: false,
			fallbackClippingsSource: null,
			fallbackKsdkDb: null,
		};
	}

	return {
		clippingsSource: null,
		ksdkDb: null,
		extraKfxDirs: [],
		sourceKind: "missing",
		deviceDetectedNotReady: false,
		fallbackClippingsSource: null,
		fallbackKsdkDb: null,
	};
}

