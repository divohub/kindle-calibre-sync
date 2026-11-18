import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Clipping, ClippingType } from "../types";
import { readMtpKindleClippings } from "./mtpClient";

export interface DetectedClippings {
	path: string;
	content?: string;
	source: "usb" | "mtp" | "configured" | "fallback";
}

export interface ClippingsDetectionResult {
	detected: DetectedClippings | null;
	mtpWarning?: string;
}

/**
 * Extracts title and author from line 1 of a Kindle clipping block.
 * Format is typically: "Book Title (Author Name)".
 */
export function normalizeTitleAuthor(rawTitleLine: string): { title: string; author: string } {
	const raw = rawTitleLine.replace(/^\ufeff+/, "").trim();
	const match = raw.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
	if (match) {
		return {
			title: match[1].trim(),
			author: match[2].trim(),
		};
	}
	return { title: raw, author: "" };
}

/**
 * Parses metadata line for type, page, location, and date in RU and EN locales.
 */
export function parseMetadataLine(metaLine: string): {
	entryType: ClippingType;
	page: number | null;
	locationStart: number;
	locationEnd: number;
	dateStr: string;
} {
	const meta = metaLine.trim().replace(/^[–-]+/, "").trim();
	const lower = meta.toLowerCase();

	let entryType: ClippingType = "highlight";
	if (lower.includes("выделенный") || lower.includes("highlight")) {
		entryType = "highlight";
	} else if (lower.includes("заметка") || lower.includes("note")) {
		entryType = "note";
	} else if (lower.includes("закладка") || lower.includes("bookmark")) {
		entryType = "bookmark";
	}

	const pageMatch = meta.match(/(?:странице|page)\s*(\d+)/i);
	const page = pageMatch ? parseInt(pageMatch[1], 10) : null;

	const locMatch = meta.match(/(?:место|location)\s*(\d+)(?:[–-](\d+))?/i);
	const locationStart = locMatch ? parseInt(locMatch[1], 10) : 0;
	const locationEnd = locMatch ? (locMatch[2] ? parseInt(locMatch[2], 10) : locationStart) : 0;

	let dateStr = "";
	const ruDateIdx = lower.indexOf("добавлено:");
	if (ruDateIdx >= 0) {
		dateStr = meta.slice(ruDateIdx + "добавлено:".length).trim();
	} else {
		const enDateIdx = lower.indexOf("added on");
		if (enDateIdx >= 0) {
			dateStr = meta.slice(enDateIdx + "added on".length).trim();
		}
	}

	return { entryType, page, locationStart, locationEnd, dateStr };
}

/**
 * Computes deterministic 5-digit ref ID matching obsidian-kindle-plugin / clippings_parser.py.
 */
export function computeRefId(title: string, locationStart: number, text: string): string {
	const digest = crypto.createHash("md5").update(`${title}:${locationStart}:${text}`, "utf8").digest("hex");
	const refHash = parseInt(digest.slice(0, 6), 16);
	return String((refHash % 90000) + 10000);
}

function normalizeEditCompareText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Returns true if two clipping/note texts look like incremental edits or duplicates of the same entry
 * (e.g. Kindle's progressive auto-save drafts in My Clippings.txt).
 */
export function isIncrementalTextEdit(prevText: string, nextText: string): boolean {
	const a = normalizeEditCompareText(prevText);
	const b = normalizeEditCompareText(nextText);
	if (!a || !b) return false;
	if (a === b || b.startsWith(a) || a.startsWith(b)) return true;

	const minLen = Math.min(a.length, b.length);
	if (minLen >= 4) {
		let common = 0;
		while (common < minLen && a.charCodeAt(common) === b.charCodeAt(common)) {
			common++;
		}
		if (common >= Math.ceil(minLen * 0.65)) {
			return true;
		}
	}
	return false;
}

/**
 * Collapses incremental highlight expansions and note edit logs within one book's clippings,
 * and attaches notes to matching highlights cleanly using the latest edit.
 */
export function collapseAndAttachClippings(clist: Clipping[]): Clipping[] {
	const rawHighlights = clist.filter((c) => c.entryType === "highlight");
	const rawNotes = clist.filter((c) => c.entryType === "note");
	const highlights: Clipping[] = [];

	for (const cur of rawHighlights) {
		let collapsed = false;
		for (let i = highlights.length - 1; i >= 0; i--) {
			const prev = highlights[i];
			if (prev.locationStart > 0 && cur.locationStart > 0 && prev.locationStart === cur.locationStart) {
				const prevNorm = normalizeEditCompareText(prev.text);
				const curNorm = normalizeEditCompareText(cur.text);
				if (curNorm === prevNorm || curNorm.startsWith(prevNorm)) {
					highlights[i] = {
						...cur,
						note: cur.note || prev.note,
					};
					collapsed = true;
					break;
				}
				if (prevNorm.startsWith(curNorm)) {
					if (cur.note && !prev.note) {
						highlights[i] = { ...prev, note: cur.note };
					}
					collapsed = true;
					break;
				}
			}
		}
		if (!collapsed) {
			highlights.push({ ...cur });
		}
	}

	const attachedByIdx = new Map<number, Array<{ locationStart: number; text: string }>>();
	const unmatchedNotes: Clipping[] = [];

	const findBestHighlightIdx = (loc: number): number => {
		for (let i = 0; i < highlights.length; i++) {
			const h = highlights[i];
			if (h.locationStart <= loc && loc <= h.locationEnd) {
				return i;
			}
		}
		for (let i = 0; i < highlights.length; i++) {
			const h = highlights[i];
			if (
				(h.locationStart <= loc && loc <= h.locationEnd + 5) ||
				Math.abs(h.locationStart - loc) <= 5 ||
				Math.abs(h.locationEnd - loc) <= 5
			) {
				return i;
			}
		}
		return -1;
	};

	for (const n of rawNotes) {
		const noteText = n.text.trim();
		if (!noteText) continue;

		const hi = findBestHighlightIdx(n.locationStart);
		if (hi >= 0) {
			let list = attachedByIdx.get(hi);
			if (!list) {
				list = [];
				attachedByIdx.set(hi, list);
			}
			let updatedIdx = -1;
			for (let k = list.length - 1; k >= 0; k--) {
				const existing = list[k];
				const sameLocation = n.locationStart > 0 && existing.locationStart === n.locationStart;
				if (sameLocation || isIncrementalTextEdit(existing.text, noteText)) {
					updatedIdx = k;
					break;
				}
			}
			if (updatedIdx >= 0) {
				list[updatedIdx] = { locationStart: n.locationStart, text: noteText };
			} else {
				list.push({ locationStart: n.locationStart, text: noteText });
			}
			continue;
		}

		let replacedUnmatched = false;
		for (let k = unmatchedNotes.length - 1; k >= 0; k--) {
			const existing = unmatchedNotes[k];
			const sameLoc = n.locationStart > 0 && existing.locationStart === n.locationStart;
			const closeEdit =
				Math.abs(existing.locationStart - n.locationStart) <= 2 &&
				isIncrementalTextEdit(existing.text, noteText);
			if (sameLoc || closeEdit) {
				unmatchedNotes[k] = { ...n, text: noteText };
				replacedUnmatched = true;
				break;
			}
		}
		if (!replacedUnmatched) {
			unmatchedNotes.push({ ...n, text: noteText });
		}
	}

	for (const [hi, list] of attachedByIdx.entries()) {
		const combined = list.map((item) => item.text).filter(Boolean).join("\n");
		if (combined) {
			highlights[hi].note = highlights[hi].note
				? isIncrementalTextEdit(highlights[hi].note, combined)
					? combined
					: `${highlights[hi].note}\n${combined}`
				: combined;
		}
	}

	return [...highlights, ...unmatchedNotes];
}

/**
 * Parses My Clippings.txt text content into a map of book title -> clippings list.
 * Collapses Kindle's progressive note edit logs and links notes to nearby highlights.
 */
export function parseClippingsContent(content: string): Map<string, Clipping[]> {
	const cleanContent = content.replace(/^\ufeff/, "");
	const rawBlocks = cleanContent.split("==========");
	const books = new Map<string, Clipping[]>();

	for (const block of rawBlocks) {
		const lines = block
			.trim()
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0);

		if (lines.length < 2) {
			continue;
		}

		const { title, author } = normalizeTitleAuthor(lines[0]);
		const { entryType, page, locationStart, locationEnd, dateStr } = parseMetadataLine(lines[1]);
		const text = lines.length > 2 ? lines.slice(2).join("\n").trim() : "";

		if (!text && entryType !== "bookmark") {
			continue;
		}

		const clipping: Clipping = {
			title,
			author,
			entryType,
			page,
			locationStart,
			locationEnd,
			dateStr,
			text,
			refId: computeRefId(title, locationStart, text),
		};

		const existing = books.get(title);
		if (existing) {
			existing.push(clipping);
		} else {
			books.set(title, [clipping]);
		}
	}

	const result = new Map<string, Clipping[]>();
	for (const [title, clist] of books.entries()) {
		result.set(title, collapseAndAttachClippings(clist));
	}

	return result;
}

export function parseClippingsFile(filePath: string): Map<string, Clipping[]> {
	const content = fs.readFileSync(filePath, "utf8");
	return parseClippingsContent(content);
}

function expandHome(inputPath: string): string {
	const trimmed = inputPath.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return trimmed;
}

function getMountRoots(): string[] {
	const platform = process.platform;
	const mounts: string[] = [];

	const listSubdirs = (dir: string): string[] => {
		try {
			if (!fs.existsSync(dir)) return [];
			return fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => path.join(dir, d.name));
		} catch {
			return [];
		}
	};

	if (platform === "linux") {
		const user = os.userInfo().username;
		for (const base of ["/run/media", "/media"]) {
			mounts.push(...listSubdirs(path.join(base, user)));
			mounts.push(...listSubdirs(base));
		}
		mounts.push(...listSubdirs("/mnt"));
	} else if (platform === "darwin") {
		mounts.push(...listSubdirs("/Volumes"));
	} else if (platform === "win32") {
		// Probe common external drive letters D: through Z:
		for (let code = 68; code <= 90; code++) {
			mounts.push(`${String.fromCharCode(code)}:\\`);
		}
	}

	return mounts;
}

function detectUsbMassStorageClippings(): DetectedClippings | null {
	for (const mount of getMountRoots()) {
		for (const rel of [path.join("documents", "My Clippings.txt"), "My Clippings.txt"]) {
			const candidate = path.join(mount, rel);
			try {
				if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
					return { path: candidate, source: "usb" };
				}
			} catch {
				/* ignore inaccessible mount */
			}
		}
	}
	return null;
}

function detectLocalFallbackClippings(
	customFallback?: string,
	vaultBasePath?: string
): DetectedClippings | null {
	if (customFallback && customFallback.trim()) {
		const expanded = expandHome(customFallback);
		try {
			if (fs.existsSync(expanded) && fs.statSync(expanded).isFile()) {
				return { path: expanded, source: "configured" };
			}
		} catch {
			/* ignore */
		}
	}

	const fallbackCandidates = [
		vaultBasePath ? path.join(vaultBasePath, "My Clippings.txt") : "",
		path.join(os.homedir(), "My Clippings.txt"),
		path.join(os.homedir(), "Downloads", "My Clippings.txt"),
		path.join(os.homedir(), "Desktop", "My Clippings.txt"),
	].filter(Boolean);

	for (const candidate of fallbackCandidates) {
		try {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				return { path: candidate, source: "fallback" };
			}
		} catch {
			/* ignore */
		}
	}

	return null;
}

/**
 * Synchronously checks mounted USB Mass Storage drives, configured path, and local fallbacks.
 */
export function detectKindleClippingsPath(customFallback?: string, vaultBasePath?: string): DetectedClippings | null {
	return detectUsbMassStorageClippings() ?? detectLocalFallbackClippings(customFallback, vaultBasePath);
}

/**
 * Auto-detects My Clippings.txt prioritizing live connected Kindle devices (USB Mass Storage, then MTP)
 * before falling back to configured/local files.
 */
export async function detectKindleClippingsAsync(
	customFallback?: string,
	vaultBasePath?: string
): Promise<ClippingsDetectionResult> {
	const usb = detectUsbMassStorageClippings();
	if (usb) {
		return { detected: usb };
	}

	const mtp = await readMtpKindleClippings();
	if (mtp.result) {
		return {
			detected: {
				path: mtp.result.path,
				content: mtp.result.content,
				source: "mtp",
			},
		};
	}

	// If an MTP Kindle is connected right now but locked/busy, do not silently sync a stale local file.
	if (mtp.warning) {
		return { detected: null, mtpWarning: mtp.warning };
	}

	return {
		detected: detectLocalFallbackClippings(customFallback, vaultBasePath),
	};
}
