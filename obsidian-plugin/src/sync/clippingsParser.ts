import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Clipping, ClippingType } from "../types";
import { readMtpKindleClippings } from "./mtpClient";
import {
	appendOrMergeNoteText,
	computeRefId,
	isIncrementalTextEdit,
	normalizeEditCompareText,
	parseClippingTimestamp,
} from "./textUtils";

export { computeRefId, isIncrementalTextEdit };

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

const EDIT_BURST_MS = 10 * 60 * 1000;
const REWRITE_BURST_MS = 2 * 60 * 1000;

function areTimestampsWithin(aMs: number | null, bMs: number | null, maxDiffMs: number): boolean {
	return aMs !== null && bMs !== null && Math.abs(bMs - aMs) <= maxDiffMs;
}

function shouldCollapseHighlightPair(
	prev: Clipping,
	cur: Clipping,
	prevTs: number | null,
	curTs: number | null
): "keep-cur" | "keep-prev" | null {
	if (prev.locationStart <= 0 || cur.locationStart <= 0) return null;

	const sameStart = prev.locationStart === cur.locationStart;
	const sameEnd = prev.locationEnd === cur.locationEnd;
	if (!sameStart && !sameEnd) return null;

	const prevNorm = normalizeEditCompareText(prev.text);
	const curNorm = normalizeEditCompareText(cur.text);
	if (!prevNorm || !curNorm) return null;

	if (curNorm === prevNorm && sameStart) {
		return "keep-cur";
	}

	const expandedForward = sameStart && curNorm.startsWith(prevNorm);
	const expandedBackward = sameEnd && curNorm.endsWith(prevNorm);
	if (expandedForward || expandedBackward) {
		return "keep-cur";
	}

	const closeBurst = areTimestampsWithin(prevTs, curTs, EDIT_BURST_MS);
	const shrunkFromEnd = sameStart && prevNorm.startsWith(curNorm);
	const shrunkFromStart = sameEnd && prevNorm.endsWith(curNorm);

	if (shrunkFromEnd || shrunkFromStart) {
		// When timestamps prove user edited the highlight in a short burst, keep the latest choice;
		// otherwise only collapse same-start prefixes keeping the longer quote.
		if (closeBurst) return "keep-cur";
		if (shrunkFromEnd) return "keep-prev";
	}

	// Handle intermediate re-highlight wiggles over the exact same location bounds within 10 minutes
	if (
		closeBurst &&
		sameStart &&
		sameEnd &&
		(prevNorm.includes(curNorm) || curNorm.includes(prevNorm))
	) {
		return "keep-cur";
	}

	return null;
}

function shouldCollapseNoteDrafts(
	prevLoc: number,
	prevPage: number | null,
	prevText: string,
	prevTs: number | null,
	curLoc: number,
	curPage: number | null,
	curText: string,
	curTs: number | null
): boolean {
	const normPrev = normalizeEditCompareText(prevText);
	const normCur = normalizeEditCompareText(curText);
	if (!normPrev || !normCur) return false;

	if (prevLoc > 0 && curLoc > 0) {
		if (prevLoc === curLoc) {
			if (normPrev === normCur) return true;
			if (isIncrementalTextEdit(prevText, curText)) return true;
			return areTimestampsWithin(prevTs, curTs, REWRITE_BURST_MS);
		}
		if (Math.abs(prevLoc - curLoc) <= 2) {
			const minLen = Math.min(normPrev.length, normCur.length);
			return (
				minLen >= 6 &&
				isIncrementalTextEdit(prevText, curText) &&
				(prevTs === null || curTs === null || areTimestampsWithin(prevTs, curTs, EDIT_BURST_MS))
			);
		}
		return false;
	}

	// Page-only entries (locationStart === 0, e.g. PDFs): require matching page + incremental edit
	if (prevPage !== null && curPage !== null && prevPage === curPage) {
		return (
			normPrev === normCur ||
			(isIncrementalTextEdit(prevText, curText) &&
				(prevTs === null || curTs === null || areTimestampsWithin(prevTs, curTs, EDIT_BURST_MS)))
		);
	}

	return false;
}

/**
 * Collapses incremental highlight expansions and note edit logs within one book's clippings,
 * and attaches notes to matching highlights using location, timestamp, and file proximity.
 */
export function collapseAndAttachClippings(clist: Clipping[]): Clipping[] {
	interface IndexedClipping {
		clip: Clipping;
		rawIndex: number;
		ts: number | null;
	}

	const rawHighlights: IndexedClipping[] = [];
	const rawNotes: IndexedClipping[] = [];

	for (let idx = 0; idx < clist.length; idx++) {
		const c = clist[idx];
		const item: IndexedClipping = {
			clip: c,
			rawIndex: idx,
			ts: parseClippingTimestamp(c.dateStr),
		};
		if (c.entryType === "highlight") rawHighlights.push(item);
		else if (c.entryType === "note") rawNotes.push(item);
	}

	const highlights: IndexedClipping[] = [];

	for (const curItem of rawHighlights) {
		let collapsed = false;
		for (let i = highlights.length - 1; i >= 0; i--) {
			const prevItem = highlights[i];
			const decision = shouldCollapseHighlightPair(
				prevItem.clip,
				curItem.clip,
				prevItem.ts,
				curItem.ts
			);
			if (!decision) continue;

			if (decision === "keep-cur") {
				highlights[i] = {
					clip: {
						...curItem.clip,
						note: appendOrMergeNoteText(prevItem.clip.note, curItem.clip.note, {
							replaceIncremental: true,
						}),
					},
					rawIndex: curItem.rawIndex,
					ts: curItem.ts,
				};
			} else if (curItem.clip.note) {
				highlights[i] = {
					...prevItem,
					clip: {
						...prevItem.clip,
						note: appendOrMergeNoteText(prevItem.clip.note, curItem.clip.note, {
							replaceIncremental: true,
						}),
					},
				};
			}
			collapsed = true;
			break;
		}
		if (!collapsed) {
			highlights.push({
				clip: { ...curItem.clip },
				rawIndex: curItem.rawIndex,
				ts: curItem.ts,
			});
		}
	}

	interface AttachedNoteEntry {
		locationStart: number;
		page: number | null;
		text: string;
		ts: number | null;
	}

	const attachedByIdx = new Map<number, AttachedNoteEntry[]>();
	const unmatchedNotes: IndexedClipping[] = [];

	const findBestHighlightIdx = (noteItem: IndexedClipping): number => {
		const n = noteItem.clip;
		const loc = n.locationStart;

		const scoreCandidate = (hItem: IndexedClipping, baseScore: number): number => {
			let score = baseScore;
			const h = hItem.clip;
			if (noteItem.ts !== null && hItem.ts !== null) {
				const diffSec = Math.abs(noteItem.ts - hItem.ts) / 1000;
				if (diffSec <= 5) score += 600;
				else if (diffSec <= 60) score += 350;
				else if (diffSec <= 600) score += 150;
			}
			if (loc > 0 && h.locationEnd === loc) {
				score += 15;
			}
			const span = h.locationStart > 0 ? Math.max(0, h.locationEnd - h.locationStart) : 0;
			score -= Math.min(100, span) * 0.1;
			score -= Math.min(50, Math.abs(hItem.rawIndex - noteItem.rawIndex)) * 0.2;
			return score;
		};

		if (loc === 0) {
			let bestIdx = -1;
			let bestScore = -Infinity;
			for (let i = 0; i < highlights.length; i++) {
				const hItem = highlights[i];
				const h = hItem.clip;
				const pageMatch = n.page !== null && h.page !== null && n.page === h.page;
				const unlocatedBurst =
					n.page === null &&
					h.page === null &&
					h.locationStart === 0 &&
					(areTimestampsWithin(noteItem.ts, hItem.ts, EDIT_BURST_MS) ||
						Math.abs(hItem.rawIndex - noteItem.rawIndex) <= 3);
				if (!pageMatch && !unlocatedBurst) continue;

				const score = scoreCandidate(hItem, pageMatch ? 1000 : 200);
				if (score > bestScore) {
					bestScore = score;
					bestIdx = i;
				}
			}
			return bestIdx;
		}

		// Pass 1: strict containment
		let bestStrictIdx = -1;
		let bestStrictScore = -Infinity;
		for (let i = 0; i < highlights.length; i++) {
			const hItem = highlights[i];
			const h = hItem.clip;
			if (h.locationStart > 0 && h.locationStart <= loc && loc <= h.locationEnd) {
				const score = scoreCandidate(hItem, 1000);
				if (score > bestStrictScore) {
					bestStrictScore = score;
					bestStrictIdx = i;
				}
			}
		}
		if (bestStrictIdx >= 0) return bestStrictIdx;

		// Pass 2: +/- 5 location fallback
		let bestNearIdx = -1;
		let bestNearScore = -Infinity;
		for (let i = 0; i < highlights.length; i++) {
			const hItem = highlights[i];
			const h = hItem.clip;
			if (h.locationStart <= 0) continue;
			const dist =
				loc < h.locationStart
					? h.locationStart - loc
					: loc > h.locationEnd
						? loc - h.locationEnd
						: 0;
			if (dist <= 5) {
				const score = scoreCandidate(hItem, 200 - dist * 20);
				if (score > bestNearScore) {
					bestNearScore = score;
					bestNearIdx = i;
				}
			}
		}
		return bestNearIdx;
	};

	for (const noteItem of rawNotes) {
		const n = noteItem.clip;
		const noteText = n.text.trim();
		if (!noteText) continue;

		const hi = findBestHighlightIdx(noteItem);
		if (hi >= 0) {
			let list = attachedByIdx.get(hi);
			if (!list) {
				list = [];
				attachedByIdx.set(hi, list);
			}
			let updatedIdx = -1;
			for (let k = list.length - 1; k >= 0; k--) {
				const existing = list[k];
				if (
					shouldCollapseNoteDrafts(
						existing.locationStart,
						existing.page,
						existing.text,
						existing.ts,
						n.locationStart,
						n.page,
						noteText,
						noteItem.ts
					)
				) {
					updatedIdx = k;
					break;
				}
			}
			const nextEntry: AttachedNoteEntry = {
				locationStart: n.locationStart,
				page: n.page,
				text: noteText,
				ts: noteItem.ts,
			};
			if (updatedIdx >= 0) {
				list[updatedIdx] = nextEntry;
			} else {
				list.push(nextEntry);
			}
			continue;
		}

		let replacedUnmatched = false;
		for (let k = unmatchedNotes.length - 1; k >= 0; k--) {
			const existing = unmatchedNotes[k];
			if (
				shouldCollapseNoteDrafts(
					existing.clip.locationStart,
					existing.clip.page,
					existing.clip.text,
					existing.ts,
					n.locationStart,
					n.page,
					noteText,
					noteItem.ts
				)
			) {
				unmatchedNotes[k] = {
					clip: { ...n, text: noteText },
					rawIndex: noteItem.rawIndex,
					ts: noteItem.ts,
				};
				replacedUnmatched = true;
				break;
			}
		}
		if (!replacedUnmatched) {
			unmatchedNotes.push({
				clip: { ...n, text: noteText },
				rawIndex: noteItem.rawIndex,
				ts: noteItem.ts,
			});
		}
	}

	for (const [hi, list] of attachedByIdx.entries()) {
		let mergedNote = highlights[hi].clip.note;
		for (const item of list) {
			mergedNote = appendOrMergeNoteText(mergedNote, item.text, { replaceIncremental: false });
		}
		if (mergedNote) {
			highlights[hi].clip.note = mergedNote;
		}
	}

	return [...highlights.map((h) => h.clip), ...unmatchedNotes.map((u) => u.clip)];
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
