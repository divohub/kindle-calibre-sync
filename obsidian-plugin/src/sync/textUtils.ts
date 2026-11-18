import * as crypto from "crypto";

const RU_MONTHS: Record<string, number> = {
	январ: 0,
	феврал: 1,
	март: 2,
	апрел: 3,
	ма: 4,
	июн: 5,
	июл: 6,
	август: 7,
	сентябр: 8,
	октябр: 9,
	ноябр: 10,
	декабр: 11,
};

const CLIPPING_LIMIT_RE = /you have reached the clipping limit for this item|достигнут предел/i;

/**
 * Computes deterministic 5-digit ref ID matching obsidian-kindle-plugin / clippings_parser.py.
 */
export function computeRefId(title: string, locationStart: number, text: string): string {
	const digest = crypto.createHash("md5").update(`${title}:${locationStart}:${text}`, "utf8").digest("hex");
	const refHash = parseInt(digest.slice(0, 6), 16);
	return String((refHash % 90000) + 10000);
}

/**
 * Lowercases text while keeping Unicode letters, digits, underscores, and spaces for fuzzy title/quote matching.
 */
export function cleanMatchText(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, "").trim();
}

/**
 * Strips all non-alphanumeric Unicode characters for strict normalized title/highlight keys.
 */
export function normalizeAlnumKey(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").trim();
}

/**
 * Collapses whitespace and lowercases text for progressive edit comparisons.
 */
export function normalizeEditCompareText(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Normalizes quote typography and strips punctuation for cross-source highlight deduplication.
 */
export function normalizeHighlightDedupKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/[«»“”„"']/g, '"')
		.replace(/[–—−‐\u00a0]/g, " ")
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Returns true if the clipping text is Kindle's DRM clipping-limit placeholder rather than real book text.
 */
export function isClippingLimitPlaceholder(text: string): boolean {
	return CLIPPING_LIMIT_RE.test(text);
}

/**
 * Parses Kindle EN/RU/ISO clipping timestamps into epoch milliseconds, or null when unparseable.
 */
export function parseClippingTimestamp(dateStr: string): number | null {
	const raw = dateStr.trim();
	if (!raw) return null;

	const ruMatch = raw.match(
		/(\d{1,2})\s+([а-яё]+)\s+(\d{4})(?:\s*г\.?)?(?:\s+в)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/iu
	);
	if (ruMatch) {
		const day = Number.parseInt(ruMatch[1], 10);
		const monthWord = ruMatch[2].toLowerCase();
		const year = Number.parseInt(ruMatch[3], 10);
		const hour = Number.parseInt(ruMatch[4], 10);
		const min = Number.parseInt(ruMatch[5], 10);
		const sec = ruMatch[6] ? Number.parseInt(ruMatch[6], 10) : 0;

		let monthIdx: number | undefined;
		for (const [prefix, idx] of Object.entries(RU_MONTHS)) {
			if (monthWord.startsWith(prefix)) {
				monthIdx = idx;
				break;
			}
		}
		if (monthIdx !== undefined) {
			return new Date(year, monthIdx, day, hour, min, sec).getTime();
		}
	}

	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Computes normalized common prefix length between two already-normalized strings.
 */
export function commonPrefixLength(a: string, b: string): number {
	const minLen = Math.min(a.length, b.length);
	let common = 0;
	while (common < minLen && a.charCodeAt(common) === b.charCodeAt(common)) {
		common++;
	}
	return common;
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
		const common = commonPrefixLength(a, b);
		if (common >= Math.ceil(minLen * 0.65)) {
			return true;
		}
	}
	return false;
}

/**
 * Combines existing and incoming note strings while deduplicating identical lines
 * and optionally collapsing incremental edits.
 */
export function appendOrMergeNoteText(
	existingNote: string | undefined,
	incomingNote: string | undefined,
	options?: { replaceIncremental?: boolean }
): string | undefined {
	const cur = existingNote?.trim() ?? "";
	const inc = incomingNote?.trim() ?? "";
	if (!cur) return inc || undefined;
	if (!inc) return cur;

	const curNorm = normalizeEditCompareText(cur);
	const incNorm = normalizeEditCompareText(inc);
	if (curNorm === incNorm) return inc;

	if (options?.replaceIncremental && isIncrementalTextEdit(cur, inc)) {
		return inc;
	}

	const existingLines = cur.split(/\r?\n/).map((l) => normalizeEditCompareText(l));
	if (existingLines.includes(incNorm)) {
		return cur;
	}

	return `${cur}\n${inc}`;
}
