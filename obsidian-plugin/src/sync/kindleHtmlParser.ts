import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Clipping, ClippingType } from "../types";
import { mergeBookClippingsMaps } from "./bookMerge";
import { appendOrMergeNoteText, computeRefId } from "./textUtils";

const HTML_ENTITY_MAP: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	laquo: "«",
	raquo: "»",
	hellip: "…",
	middot: "·",
};

const MAX_SCANNED_HTML_FILES = 250;
const NOTE_HEADING_RE = /(?:^|[^\p{L}\p{N}_])(?:note|notes|заметка|заметки|notiz|remarque|nota)(?=$|[^\p{L}\p{N}_])/iu;
const BOOKMARK_HEADING_RE = /(?:^|[^\p{L}\p{N}_])(?:bookmark|bookmarks|закладка|закладки|lesezeichen|signet|marcador)(?=$|[^\p{L}\p{N}_])/iu;
const PAGE_HEADING_RE = /(?:^|[^\p{L}\p{N}_])(?:(?:pages?|страниц[аы]|стр|seiten?|páginas?)\s+|(?:стр\.|p\.)\s*)([\d,]+)/iu;
const LOC_HEADING_RE = /(?:^|[^\p{L}\p{N}_])(?:locations?|позици[яи]|место(?:положение)?|локаци[яи]|position(?:en)?|emplacement|posici[oó]n|loc\.?)\s*([\d,]+)(?:\s*[-–—]\s*([\d,]+))?/iu;
const NEXT_KINDLE_TOKEN_RE = /<[a-zA-Z0-9]+\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:bookTitle|authors?|sectionHeading|noteHeading|noteText)\b[^>]*>|<\/\s*body\b/i;

function decodeHtmlEntities(input: string): string {
	return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code: string) => {
		if (code.startsWith("#x") || code.startsWith("#X")) {
			const cp = Number.parseInt(code.slice(2), 16);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
		}
		if (code.startsWith("#")) {
			const cp = Number.parseInt(code.slice(1), 10);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
		}
		return HTML_ENTITY_MAP[code.toLowerCase()] ?? full;
	});
}

function htmlSliceToPlainText(innerHtml: string): string {
	const withBreaks = innerHtml
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(/<\/\s*(?:p|div|li|h[1-6])\s*>/gi, "\n");
	const stripped = withBreaks.replace(/<[^>]+>/g, "");
	const decoded = decodeHtmlEntities(stripped);
	return decoded
		.split(/\r?\n/)
		.map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
		.filter((line, idx, arr) => line.length > 0 || (idx > 0 && idx < arr.length - 1 && arr[idx - 1].length > 0))
		.join("\n")
		.trim();
}

type KindleHtmlTokenKind = "title" | "author" | "heading" | "text";

interface KindleHtmlToken {
	kind: KindleHtmlTokenKind;
	text: string;
}

const VOID_HTML_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

function findMatchingTagClose(html: string, tagName: string, contentStart: number): number {
	const lowerTag = tagName.toLowerCase();
	if (VOID_HTML_TAGS.has(lowerTag)) return contentStart;

	const tagRe = new RegExp(`<(\\/?)\\s*${lowerTag}\\b([^>]*)>`, "gi");
	tagRe.lastIndex = contentStart;
	let depth = 1;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(html)) !== null) {
		const isClosing = m[1] === "/";
		const attrs = m[2] || "";
		const isSelfClosing = !isClosing && attrs.trimEnd().endsWith("/");
		if (isSelfClosing) continue;
		depth += isClosing ? -1 : 1;
		if (depth === 0) {
			return m.index;
		}
	}
	return -1;
}

function findUnclosedTokenFallbackEnd(html: string, contentStart: number): number {
	const rest = html.slice(contentStart);
	const m = NEXT_KINDLE_TOKEN_RE.exec(rest);
	return m ? contentStart + m.index : html.length;
}

function extractKindleHtmlTokens(html: string): KindleHtmlToken[] {
	const tokens: KindleHtmlToken[] = [];
	const openRe = /<([a-zA-Z0-9]+)\b[^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*>/gi;
	let m: RegExpExecArray | null;

	while ((m = openRe.exec(html)) !== null) {
		const tagName = m[1];
		const classList = m[2].split(/\s+/).map((c) => c.trim());
		let kind: KindleHtmlTokenKind | null = null;
		if (classList.includes("bookTitle")) kind = "title";
		else if (classList.includes("authors") || classList.includes("author")) kind = "author";
		else if (classList.includes("noteHeading")) kind = "heading";
		else if (classList.includes("noteText")) kind = "text";

		if (!kind) continue;

		const contentStart = openRe.lastIndex;
		const matchedClose = findMatchingTagClose(html, tagName, contentStart);
		const sliceEnd = matchedClose >= 0 ? matchedClose : findUnclosedTokenFallbackEnd(html, contentStart);

		const text = htmlSliceToPlainText(html.slice(contentStart, sliceEnd));
		if (text) {
			tokens.push({ kind, text });
		}
		openRe.lastIndex = sliceEnd;
	}

	return tokens;
}

function cleanAuthorValue(raw: string): string {
	return raw.replace(/^by\s+/i, "").trim();
}

function parseIntWithCommas(raw: string | undefined): number {
	if (!raw) return 0;
	const num = Number.parseInt(raw.replace(/,/g, ""), 10);
	return Number.isFinite(num) ? num : 0;
}

interface ParsedHtmlHeading {
	entryType: ClippingType;
	page: number | null;
	locationStart: number;
	locationEnd: number;
	hasExplicitLocation: boolean;
}

function parseKindleHtmlHeading(heading: string): ParsedHtmlHeading {
	const prefix = (heading.split(/\s*[-–—]\s*/)[0] || heading).toLowerCase();
	let entryType: ClippingType = "highlight";
	if (NOTE_HEADING_RE.test(prefix)) {
		entryType = "note";
	} else if (BOOKMARK_HEADING_RE.test(prefix)) {
		entryType = "bookmark";
	}

	const pageMatch = heading.match(PAGE_HEADING_RE);
	const page = pageMatch ? parseIntWithCommas(pageMatch[1]) : null;

	const locMatch = heading.match(LOC_HEADING_RE);
	const hasExplicitLocation = Boolean(locMatch);
	let locationStart = locMatch ? parseIntWithCommas(locMatch[1]) : 0;
	let locationEnd = locMatch && locMatch[2] ? parseIntWithCommas(locMatch[2]) : locationStart;

	if (!hasExplicitLocation && page && page > 0) {
		locationStart = page;
		locationEnd = page;
	}

	return {
		entryType,
		page,
		locationStart,
		locationEnd: Math.max(locationStart, locationEnd),
		hasExplicitLocation,
	};
}

function isHtmlNoteAttachedToHighlight(
	noteMeta: ParsedHtmlHeading,
	lastHl: { clip: Clipping; hasExplicitLocation: boolean } | undefined
): boolean {
	if (!lastHl) return false;

	if (noteMeta.hasExplicitLocation && lastHl.hasExplicitLocation) {
		return (
			noteMeta.locationStart >= lastHl.clip.locationStart - 5 &&
			noteMeta.locationStart <= lastHl.clip.locationEnd + 5
		);
	}
	if (!noteMeta.hasExplicitLocation && !lastHl.hasExplicitLocation) {
		if (noteMeta.page !== null) {
			return lastHl.clip.page === noteMeta.page;
		}
		return lastHl.clip.page === null;
	}
	return noteMeta.page !== null && lastHl.clip.page !== null && noteMeta.page === lastHl.clip.page;
}

/**
 * Checks whether an HTML string matches Amazon Kindle's Notebook export format
 * (Kindle for Mac, Kindle for PC, Kindle iOS/Android HTML exports).
 */
export function isKindleHtmlExport(content: string): boolean {
	if (!content || !content.includes("<")) return false;
	return (
		/\bclass\s*=\s*["'][^"']*\bnoteHeading\b/i.test(content) &&
		(/\bclass\s*=\s*["'][^"']*\bnoteText\b/i.test(content) ||
			/\bclass\s*=\s*["'][^"']*\bbookTitle\b/i.test(content))
	);
}

/**
 * Parses an exported Kindle Desktop/Mobile Notebook HTML file into per-book Clippings.
 * Attaches notes directly to their preceding highlight in document order without draft-collapse heuristics.
 */
export function parseKindleHtmlContent(content: string, fallbackFilename = ""): Map<string, Clipping[]> {
	const books = new Map<string, Clipping[]>();
	if (!isKindleHtmlExport(content)) {
		return books;
	}

	const tokens = extractKindleHtmlTokens(content);
	if (tokens.length === 0) {
		return books;
	}

	let title = "";
	let author = "";
	for (const tok of tokens) {
		if (tok.kind === "title" && !title) title = tok.text;
		else if (tok.kind === "author" && !author) author = cleanAuthorValue(tok.text);
		if (title && author) break;
	}

	if (!title && fallbackFilename) {
		title = path
			.basename(fallbackFilename, path.extname(fallbackFilename))
			.replace(/\s*[-–_]\s*Notebook$/i, "")
			.trim();
	}
	if (!title) {
		title = "Unknown Kindle Book";
	}

	let seenBookTitleToken = false;
	let pendingHeading: ParsedHtmlHeading | null = null;
	const lastHighlightByBook = new Map<string, { clip: Clipping; hasExplicitLocation: boolean }>();

	for (const tok of tokens) {
		if (tok.kind === "title") {
			if (seenBookTitleToken && tok.text !== title) {
				author = "";
			}
			title = tok.text;
			seenBookTitleToken = true;
			pendingHeading = null;
			continue;
		}
		if (tok.kind === "author") {
			author = cleanAuthorValue(tok.text);
			const currentList = books.get(title);
			if (currentList) {
				for (const item of currentList) {
					if (!item.author) item.author = author;
				}
			}
			continue;
		}
		if (tok.kind === "heading") {
			pendingHeading = parseKindleHtmlHeading(tok.text);
			continue;
		}
		if (tok.kind === "text" && pendingHeading) {
			const meta = pendingHeading;
			pendingHeading = null;

			if (meta.entryType === "bookmark") {
				continue;
			}
			const text = tok.text.trim();
			if (!text) continue;

			let bookClips = books.get(title);
			if (!bookClips) {
				bookClips = [];
				books.set(title, bookClips);
			}

			if (meta.entryType === "note") {
				const lastHl = lastHighlightByBook.get(title);
				if (lastHl && isHtmlNoteAttachedToHighlight(meta, lastHl)) {
					lastHl.clip.note = appendOrMergeNoteText(lastHl.clip.note, text, {
						replaceIncremental: false,
					});
					continue;
				}
			}

			const clip: Clipping = {
				title,
				author,
				entryType: meta.entryType,
				page: meta.page,
				locationStart: meta.locationStart,
				locationEnd: meta.locationEnd,
				dateStr: "",
				text,
				refId: computeRefId(title, meta.locationStart, text),
			};
			bookClips.push(clip);

			if (meta.entryType === "highlight") {
				lastHighlightByBook.set(title, { clip, hasExplicitLocation: meta.hasExplicitLocation });
			}
		}
	}

	return books;
}

export function parseKindleHtmlSources(
	sources: Array<{ path: string; content?: string }>
): Map<string, Clipping[]> {
	let merged = new Map<string, Clipping[]>();
	for (const src of sources) {
		let html = src.content;
		if (typeof html !== "string" && src.path && fs.existsSync(src.path)) {
			try {
				html = fs.readFileSync(src.path, "utf8");
			} catch {
				continue;
			}
		}
		if (!html) continue;
		const parsed = parseKindleHtmlContent(html, src.path);
		merged = mergeBookClippingsMaps(merged, parsed);
	}
	return merged;
}

function resolveHtmlUserPath(rawPath?: string): string | null {
	const trimmed = rawPath?.trim();
	if (!trimmed) return null;
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return path.resolve(path.join(os.homedir(), trimmed.slice(2)));
	}
	return path.resolve(trimmed);
}

/**
 * Scans configured file/folder and standard Kindle export directories for valid Kindle Notebook HTML exports.
 */
export function detectKindleHtmlExports(
	configuredPath?: string,
	vaultBasePath?: string
): Array<{ path: string; content: string }> {
	const results: Array<{ path: string; content: string }> = [];
	const seenFiles = new Set<string>();
	let scannedCount = 0;

	const tryReadHtmlFile = (filePath: string): void => {
		if (scannedCount >= MAX_SCANNED_HTML_FILES) return;
		scannedCount++;
		try {
			const real = fs.realpathSync(filePath);
			if (seenFiles.has(real)) return;
			const st = fs.statSync(real);
			if (!st.isFile() || st.size <= 0 || st.size > 25 * 1024 * 1024) return;
			const content = fs.readFileSync(real, "utf8");
			if (isKindleHtmlExport(content)) {
				seenFiles.add(real);
				results.push({ path: filePath, content });
			}
		} catch {
			/* ignore inaccessible or malformed file */
		}
	};

	const scanDir = (dirPath: string, depth: number): void => {
		if (depth > 2 || scannedCount >= MAX_SCANNED_HTML_FILES) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dirPath, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (scannedCount >= MAX_SCANNED_HTML_FILES) break;
			if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
			const full = path.join(dirPath, ent.name);
			if (ent.isDirectory()) {
				scanDir(full, depth + 1);
			} else if (ent.isFile() && /\.(?:html|htm)$/i.test(ent.name)) {
				tryReadHtmlFile(full);
			}
		}
	};

	const candidates = [
		resolveHtmlUserPath(configuredPath) || "",
		vaultBasePath ? path.join(vaultBasePath, "Kindle Exports") : "",
		path.join(os.homedir(), "Documents", "Kindle Exports"),
		path.join(os.homedir(), "Kindle Exports"),
	].filter(Boolean);

	for (const candidate of candidates) {
		try {
			if (!fs.existsSync(candidate)) continue;
			const st = fs.statSync(candidate);
			if (st.isFile()) {
				tryReadHtmlFile(candidate);
			} else if (st.isDirectory()) {
				scanDir(candidate, 0);
			}
		} catch {
			/* ignore inaccessible candidate */
		}
	}

	return results;
}
