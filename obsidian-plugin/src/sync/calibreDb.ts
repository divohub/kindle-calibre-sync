import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js-fts5";
import wasmBinary from "sql.js-fts5/dist/sql-wasm.wasm";
import type { BooksIndex, CalibreBook, CfiInfo, HighlightEntry } from "../types";
import { buildPointCfi, buildRangeCfi } from "./epubCfi";
import { cleanMatchText } from "./textUtils";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

export async function getSqlJs(): Promise<SqlJsStatic> {
	if (!sqlJsPromise) {
		const wasmBuffer = wasmBinary.buffer.slice(
			wasmBinary.byteOffset,
			wasmBinary.byteOffset + wasmBinary.byteLength
		) as ArrayBuffer;
		sqlJsPromise = initSqlJs({ wasmBinary: wasmBuffer });
	}
	return sqlJsPromise;
}

export function expandHomePath(inputPath: string): string {
	const trimmed = inputPath.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return trimmed;
}

function getCalibreConfigPaths(): string[] {
	const candidates: string[] = [];
	const envDir = process.env.CALIBRE_CONFIG_DIRECTORY;
	if (envDir) {
		candidates.push(path.join(envDir, "global.py.json"));
	}

	if (process.platform === "linux") {
		const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
		candidates.push(path.join(xdg, "calibre", "global.py.json"));
	} else if (process.platform === "darwin") {
		candidates.push(path.join(os.homedir(), "Library", "Preferences", "calibre", "global.py.json"));
	} else if (process.platform === "win32") {
		const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
		candidates.push(path.join(appData, "calibre", "global.py.json"));
	}

	return candidates;
}

function hasCalibreDb(dirPath: string): boolean {
	try {
		return Boolean(dirPath) && fs.existsSync(path.join(dirPath, "metadata.db"));
	} catch {
		return false;
	}
}

/**
 * Resolves Calibre Library folder automatically using user setting, Calibre config, or OS defaults.
 */
export function detectCalibreLibraryPath(configuredPath?: string): string | null {
	if (configuredPath && configuredPath.trim()) {
		const expanded = path.resolve(expandHomePath(configuredPath));
		if (hasCalibreDb(expanded)) {
			return expanded;
		}
	}

	for (const cfgPath of getCalibreConfigPaths()) {
		try {
			if (!fs.existsSync(cfgPath)) continue;
			const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as { library_path?: unknown };
			if (typeof parsed.library_path === "string" && hasCalibreDb(parsed.library_path)) {
				return parsed.library_path;
			}
		} catch {
			/* ignore unreadable Calibre config */
		}
	}

	const home = os.homedir();
	const commonPaths = [
		path.join(home, "Calibre Library"),
		path.join(home, "Documents", "Calibre Library"),
		path.join(home, "Calibre"),
		path.join(home, "calibre-library"),
	];

	for (const candidate of commonPaths) {
		if (hasCalibreDb(candidate)) {
			return candidate;
		}
	}

	return null;
}

export function cleanTextForSearch(text: string): string {
	return text
		.replace(/[\s\u00a0\u00ad]+/g, " ")
		.trim()
		.replace(/[«»“”]/g, '"')
		.replace(/[–—]/g, "-");
}

function encodeCalibreQueryValue(value: string, keepOpenParen: boolean): string {
	let encoded = encodeURIComponent(value)
		.replace(/!/g, "%21")
		.replace(/'/g, "%27")
		.replace(/\)/g, "%29")
		.replace(/\*/g, "%2A");
	if (!keepOpenParen) {
		encoded = encoded.replace(/\(/g, "%28");
	}
	return encoded;
}

export class CalibreDatabase {
	readonly libraryPath: string;
	readonly libraryId: string;
	readonly dbPath: string;
	private db: Database;
	private dirty = false;

	private constructor(libraryPath: string, libraryId: string, dbPath: string, db: Database) {
		this.libraryPath = libraryPath;
		this.libraryId = libraryId;
		this.dbPath = dbPath;
		this.db = db;
	}

	static async open(libraryPath: string, libraryId = "Calibre_Library"): Promise<CalibreDatabase> {
		const absLibraryPath = path.resolve(expandHomePath(libraryPath));
		const dbPath = path.join(absLibraryPath, "metadata.db");
		if (!fs.existsSync(dbPath)) {
			throw new Error(`Calibre metadata.db not found at: ${dbPath}`);
		}
		const SQL = await getSqlJs();
		const bytes = await fs.promises.readFile(dbPath);
		const db = new SQL.Database(bytes);
		return new CalibreDatabase(absLibraryPath, libraryId || "Calibre_Library", dbPath, db);
	}

	close(): void {
		this.db.close();
	}

	hasAnnotationsTables(): boolean {
		const res = this.db.exec(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('annotations', 'annotations_dirtied')"
		);
		const names = res[0]?.values.map((row) => String(row[0])) ?? [];
		return names.includes("annotations") && names.includes("annotations_dirtied");
	}

	getAllBooks(): CalibreBook[] {
		const res = this.db.exec(`
			SELECT b.id, b.title, b.path, b.author_sort, GROUP_CONCAT(d.format) as formats
			FROM books b
			LEFT JOIN data d ON b.id = d.book
			GROUP BY b.id
		`);

		const rows = res[0]?.values ?? [];
		return rows.map((row) => {
			const rawFormats = typeof row[4] === "string" ? row[4] : "";
			const formats = rawFormats
				.split(",")
				.map((f) => f.trim().toUpperCase())
				.filter(Boolean);
			return {
				bookId: Number(row[0]),
				title: String(row[1] ?? ""),
				path: String(row[2] ?? ""),
				authors: String(row[3] ?? ""),
				formats,
			};
		});
	}

	getBookEpubPath(book: CalibreBook): string | null {
		if (!book.formats.includes("EPUB")) {
			return null;
		}
		const bookDir = path.join(this.libraryPath, book.path);
		try {
			if (!fs.existsSync(bookDir) || !fs.statSync(bookDir).isDirectory()) {
				return null;
			}
			const epubFile = fs.readdirSync(bookDir).find((f) => f.toLowerCase().endsWith(".epub"));
			return epubFile ? path.join(bookDir, epubFile) : null;
		} catch {
			return null;
		}
	}

	findBook(title: string, author = ""): CalibreBook | null {
		const allBooks = this.getAllBooks();
		const cleanTargetTitle = cleanMatchText(title);
		const cleanTargetAuthor = cleanMatchText(author);

		let bestMatch: CalibreBook | null = null;
		let bestScore = 0;

		for (const book of allBooks) {
			const cleanBookTitle = cleanMatchText(book.title);
			const cleanBookAuthor = cleanMatchText(book.authors);

			let score = 0;
			if (cleanTargetTitle === cleanBookTitle) {
				score += 100;
			} else if (
				(cleanBookTitle && cleanTargetTitle.includes(cleanBookTitle)) ||
				(cleanTargetTitle && cleanBookTitle.includes(cleanTargetTitle))
			) {
				score += 60;
			}

			if (cleanTargetAuthor && cleanBookAuthor) {
				if (cleanTargetAuthor.includes(cleanBookAuthor) || cleanBookAuthor.includes(cleanTargetAuthor)) {
					score += 30;
				}
			}

			if (score > bestScore && score >= 60) {
				bestScore = score;
				bestMatch = book;
			}
		}

		return bestMatch;
	}

	getBookById(bookId: number): CalibreBook | null {
		if (!Number.isFinite(bookId) || bookId <= 0) return null;
		const stmt = this.db.prepare(`
			SELECT b.id, b.title, b.path, b.author_sort, GROUP_CONCAT(d.format) as formats
			FROM books b
			LEFT JOIN data d ON b.id = d.book
			WHERE b.id = ?
			GROUP BY b.id
		`);
		stmt.bind([bookId]);
		try {
			if (!stmt.step()) return null;
			const row = stmt.get();
			const rawFormats = typeof row[4] === "string" ? row[4] : "";
			const formats = rawFormats
				.split(",")
				.map((f) => f.trim().toUpperCase())
				.filter(Boolean);
			return {
				bookId: Number(row[0]),
				title: String(row[1] ?? ""),
				path: String(row[2] ?? ""),
				authors: String(row[3] ?? ""),
				formats,
			};
		} finally {
			stmt.free();
		}
	}

	ensureEpubFormatRecord(bookId: number, epubPath: string): boolean {
		try {
			if (!epubPath || !fs.existsSync(epubPath)) return false;
			const st = fs.statSync(epubPath);
			if (!st.isFile() || st.size <= 0) return false;

			const baseName = path.basename(epubPath, path.extname(epubPath));
			const checkStmt = this.db.prepare(
				"SELECT uncompressed_size, name FROM data WHERE book = ? AND UPPER(format) = 'EPUB'"
			);
			checkStmt.bind([bookId]);
			let existingSize = -1;
			let existingName = "";
			const exists = checkStmt.step();
			if (exists) {
				const row = checkStmt.get();
				existingSize = Number(row[0] ?? -1);
				existingName = String(row[1] ?? "");
			}
			checkStmt.free();

			if (exists && existingSize === st.size && existingName === baseName) {
				return false;
			}

			const stmt = this.db.prepare(
				"INSERT OR REPLACE INTO data (book, format, uncompressed_size, name) VALUES (?, 'EPUB', ?, ?)"
			);
			stmt.run([bookId, st.size, baseName]);
			stmt.free();
			this.dirty = true;
			return true;
		} catch {
			return false;
		}
	}

	getBookHighlightTexts(bookId: number): Array<{ text: string; note?: string; color?: string }> {
		if (!this.hasAnnotationsTables()) return [];
		const stmt = this.db.prepare(
			"SELECT format, annot_data FROM annotations WHERE book = ? AND annot_type = 'highlight'"
		);
		stmt.bind([bookId]);
		const rows: Array<{ fmt: string; text: string; note?: string; color?: string }> = [];
		try {
			while (stmt.step()) {
				const r = stmt.get();
				const fmt = String(r[0] ?? "").toUpperCase();
				try {
					const data = JSON.parse(String(r[1] ?? "{}")) as {
						highlighted_text?: unknown;
						notes?: unknown;
						style?: { which?: unknown };
					};
					const text = typeof data.highlighted_text === "string" ? data.highlighted_text.trim() : "";
					if (!text) continue;
					const note = typeof data.notes === "string" && data.notes.trim() ? data.notes.trim() : undefined;
					const color = typeof data.style?.which === "string" ? data.style.which : undefined;
					rows.push({ fmt, text, note, color });
				} catch {
					/* ignore malformed annotation payload */
				}
			}
		} finally {
			stmt.free();
		}

		// Prefer EPUB annotations first so any updated notes/colors take priority
		rows.sort((a, b) => (a.fmt === "EPUB" ? -1 : 0) - (b.fmt === "EPUB" ? -1 : 0));
		const seen = new Set<string>();
		const unique: Array<{ text: string; note?: string; color?: string }> = [];
		for (const item of rows) {
			const norm = cleanMatchText(item.text);
			if (!norm || seen.has(norm)) continue;
			seen.add(norm);
			unique.push({ text: item.text, note: item.note, color: item.color });
		}
		return unique;
	}

	injectAnnotation(
		bookId: number,
		bookFormat: string,
		highlightText: string,
		cfiInfo: CfiInfo | null = null,
		note?: string,
		color = "yellow"
	): string | null {
		if (!this.hasAnnotationsTables()) {
			return null;
		}

		const fmt = bookFormat.toUpperCase();
		const annotUuid = crypto.randomUUID();
		const nowTs = Date.now() / 1000;
		const nowIso = new Date().toISOString().replace("Z", "+00:00");

		const startCfi = cfiInfo ? cfiInfo.startCfi : "/2/4/2/1:0";
		const endCfi = cfiInfo ? cfiInfo.endCfi : "/2/4/2/1:100";
		const spineIndex = cfiInfo ? cfiInfo.spineIndex : 0;
		const spineName = cfiInfo ? cfiInfo.spineName : "";

		const annotData: Record<string, unknown> = {
			format_version: 1,
			uuid: annotUuid,
			type: "highlight",
			timestamp: nowIso,
			highlighted_text: highlightText,
			start_cfi: startCfi,
			end_cfi: endCfi,
			spine_index: spineIndex,
			spine_name: spineName,
			style: {
				which: color,
				type: "builtin",
				kind: "color",
			},
		};
		if (note) {
			annotData.notes = note;
		}

		const searchableText = note ? `${highlightText}\n\x1f\n${note}` : highlightText;

		let existingAnnotId: string | null = null;
		if (highlightText.length >= 25) {
			const stmt = this.db.prepare(
				"SELECT annot_id FROM annotations WHERE book = ? AND format = ? AND (searchable_text = ? OR searchable_text LIKE ?)"
			);
			stmt.bind([bookId, fmt, searchableText, `${highlightText.slice(0, 60)}%`]);
			if (stmt.step()) {
				existingAnnotId = String(stmt.get()[0]);
			}
			stmt.free();
		} else {
			const stmt = this.db.prepare(
				"SELECT annot_id FROM annotations WHERE book = ? AND format = ? AND searchable_text = ?"
			);
			stmt.bind([bookId, fmt, searchableText]);
			if (stmt.step()) {
				existingAnnotId = String(stmt.get()[0]);
			}
			stmt.free();
		}

		if (existingAnnotId) {
			if (cfiInfo) {
				const updateStmt = this.db.prepare(
					"UPDATE annotations SET annot_data = ?, searchable_text = ? WHERE book = ? AND format = ? AND annot_id = ?"
				);
				updateStmt.run([JSON.stringify(annotData), searchableText, bookId, fmt, existingAnnotId]);
				updateStmt.free();

				const dirtStmt = this.db.prepare("INSERT OR IGNORE INTO annotations_dirtied (book) VALUES (?)");
				dirtStmt.run([bookId]);
				dirtStmt.free();
				this.dirty = true;
			}
			return existingAnnotId;
		}

		const insertStmt = this.db.prepare(`
			INSERT OR REPLACE INTO annotations (
				book, format, user_type, user, timestamp, annot_id, annot_type, annot_data, searchable_text
			) VALUES (?, ?, 'local', 'viewer', ?, ?, 'highlight', ?, ?)
		`);
		insertStmt.run([bookId, fmt, nowTs, annotUuid, JSON.stringify(annotData), searchableText]);
		insertStmt.free();

		const dirtStmt = this.db.prepare("INSERT OR IGNORE INTO annotations_dirtied (book) VALUES (?)");
		dirtStmt.run([bookId]);
		dirtStmt.free();
		this.dirty = true;

		return annotUuid;
	}

	buildDeepLink(book: CalibreBook, highlightText: string, cfiInfo: CfiInfo | null = null): string {
		const fmt = book.formats.includes("EPUB") ? "EPUB" : book.formats[0] || "EPUB";
		const baseUrl = `calibre://view-book/${this.libraryId}/${book.bookId}/${fmt}`;

		if (cfiInfo && cfiInfo.fullCfi) {
			const encodedCfi = encodeCalibreQueryValue(cfiInfo.fullCfi, true);
			return `${baseUrl}?open_at=${encodedCfi}`;
		}

		const snippet = cleanTextForSearch(highlightText).slice(0, 60);
		const encodedQuery = encodeCalibreQueryValue(`search:${snippet}`, false);
		return `${baseUrl}?open_at=${encodedQuery}`;
	}

	exportBooksIndex(): BooksIndex {
		const books = this.getAllBooks();
		const annotsByBook = new Map<string, HighlightEntry[]>();

		if (this.hasAnnotationsTables()) {
			try {
				const res = this.db.exec("SELECT book, annot_data FROM annotations WHERE format = 'EPUB'");
				for (const row of res[0]?.values ?? []) {
					const bId = String(row[0]);
					try {
						const data = JSON.parse(String(row[1])) as {
							start_cfi?: string;
							end_cfi?: string;
							spine_index?: number;
							highlighted_text?: string;
						};
						const startCfi = data.start_cfi || "";
						const endCfi = data.end_cfi || "";
						const spineIndex = typeof data.spine_index === "number" ? data.spine_index : 0;

						const entry: HighlightEntry = {
							text: data.highlighted_text || "",
							range_cfi: buildRangeCfi(spineIndex, startCfi, endCfi),
							point_cfi: buildPointCfi(spineIndex, startCfi),
							spine_index: spineIndex,
							start_cfi: startCfi,
							end_cfi: endCfi,
						};
						const list = annotsByBook.get(bId);
						if (list) {
							list.push(entry);
						} else {
							annotsByBook.set(bId, [entry]);
						}
					} catch {
						/* ignore malformed annotation JSON */
					}
				}
			} catch {
				/* ignore annotations query error */
			}
		}

		const index: BooksIndex = {};
		for (const book of books) {
			const epubPath = this.getBookEpubPath(book);
			if (!epubPath) continue;
			const idStr = String(book.bookId);
			index[idStr] = {
				id: book.bookId,
				title: book.title,
				authors: book.authors,
				epub_path: epubPath,
				highlights: annotsByBook.get(idStr) ?? [],
			};
		}

		return index;
	}

	async save(): Promise<boolean> {
		if (!this.dirty) {
			return false;
		}

		const journalPath = `${this.dbPath}-journal`;
		const walPath = `${this.dbPath}-wal`;
		const hasActiveJournal = fs.existsSync(journalPath);
		let hasActiveWal = false;
		try {
			hasActiveWal = fs.existsSync(walPath) && fs.statSync(walPath).size > 0;
		} catch {
			hasActiveWal = false;
		}

		if (hasActiveJournal || hasActiveWal) {
			throw new Error("Calibre database is currently busy (journal/WAL active). Close Calibre and retry.");
		}

		const exported = this.db.export();
		const tmpPath = `${this.dbPath}.tmp-${process.pid}-${Date.now()}`;
		await fs.promises.writeFile(tmpPath, Buffer.from(exported));
		await fs.promises.rename(tmpPath, this.dbPath);
		this.dirty = false;
		return true;
	}
}
