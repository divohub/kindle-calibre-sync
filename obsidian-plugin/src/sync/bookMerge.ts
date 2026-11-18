import type { Clipping } from "../types";
import {
	appendOrMergeNoteText,
	cleanMatchText,
	isClippingLimitPlaceholder,
	normalizeAlnumKey,
	normalizeEditCompareText,
	normalizeHighlightDedupKey,
} from "./textUtils";

function extractBookBaseTitle(title: string): string {
	return title.split(/\s*[:(\-–—]\s*/)[0]?.trim() || title.trim();
}

function authorsCompatible(authorA: string, authorB: string): boolean {
	const aTokens = cleanMatchText(authorA).split(/\s+/).filter((t) => t.length >= 2);
	const bTokens = cleanMatchText(authorB).split(/\s+/).filter((t) => t.length >= 2);
	if (aTokens.length === 0 || bTokens.length === 0) return true;
	const bSet = new Set(bTokens);
	return aTokens.some((tok) => bSet.has(tok));
}

function resolveCanonicalTitle(
	incomingTitle: string,
	incomingAuthor: string,
	merged: Map<string, Clipping[]>,
	keyToCanonicalTitle: Map<string, string>
): string {
	if (merged.has(incomingTitle)) return incomingTitle;

	const exactKey = normalizeAlnumKey(incomingTitle);
	const exactHit = keyToCanonicalTitle.get(exactKey);
	if (exactHit) return exactHit;

	const baseKey = normalizeAlnumKey(extractBookBaseTitle(incomingTitle));
	for (const [existingTitle, existingClips] of merged.entries()) {
		const existingFullKey = normalizeAlnumKey(existingTitle);
		const existingBaseKey = normalizeAlnumKey(extractBookBaseTitle(existingTitle));
		const existingAuthor = existingClips.find((c) => c.author)?.author || "";

		// Match "Title" with "Title: Subtitle" only when the shorter title equals the base title
		const shortMatchesBase =
			(exactKey.length >= 5 && exactKey === existingBaseKey) ||
			(baseKey.length >= 5 && baseKey === existingFullKey);

		if (shortMatchesBase && authorsCompatible(incomingAuthor, existingAuthor)) {
			return existingTitle;
		}
	}

	return incomingTitle;
}

function getClipDedupKey(text: string): string {
	const alnum = normalizeHighlightDedupKey(text);
	return alnum || normalizeEditCompareText(text);
}

function areClipsLocationCompatible(a: Clipping, b: Clipping, maxLocDelta: number): boolean {
	if (a.page !== null && b.page !== null && a.page === b.page) {
		return true;
	}
	if (a.locationStart === 0 || b.locationStart === 0) {
		return true;
	}
	return Math.abs(a.locationStart - b.locationStart) <= maxLocDelta;
}

function indexBookClips(list: Clipping[]): Map<string, Clipping[]> {
	const byNorm = new Map<string, Clipping[]>();
	for (const c of list) {
		const norm = getClipDedupKey(c.text);
		if (!norm) continue;
		const arr = byNorm.get(norm);
		if (arr) arr.push(c);
		else byNorm.set(norm, [c]);
	}
	return byNorm;
}

function findMatchingExistingClip(
	dbClip: Clipping,
	norm: string,
	existingByNorm: Map<string, Clipping[]>
): Clipping | undefined {
	const exactCandidates = existingByNorm.get(norm);
	if (exactCandidates && exactCandidates.length > 0) {
		const isShort = norm.length < 25;
		let best: Clipping | undefined;
		let bestDelta = Infinity;
		for (const candidate of exactCandidates) {
			if (isShort && !areClipsLocationCompatible(candidate, dbClip, 15)) {
				continue;
			}
			const delta =
				candidate.locationStart > 0 && dbClip.locationStart > 0
					? Math.abs(candidate.locationStart - dbClip.locationStart)
					: 0;
			if (delta < bestDelta) {
				bestDelta = delta;
				best = candidate;
			}
		}
		if (best) return best;
	}

	if (norm.length >= 25) {
		for (const [existingNorm, candidates] of existingByNorm.entries()) {
			if (existingNorm.length < 25) continue;
			if (!existingNorm.includes(norm) && !norm.includes(existingNorm)) continue;

			const minLen = Math.min(existingNorm.length, norm.length);
			const maxLen = Math.max(existingNorm.length, norm.length);
			const strongRatio = minLen >= 40 && minLen / maxLen >= 0.55;

			for (const candidate of candidates) {
				if (strongRatio || areClipsLocationCompatible(candidate, dbClip, 30)) {
					return candidate;
				}
			}
		}
	}

	return undefined;
}

/**
 * Merges book clipping maps across sources (e.g. My Clippings.txt, ksdk DB, Kindle HTML),
 * resolving subtitle variants, replacing DRM clipping-limit placeholders when real text exists,
 * and merging notes without losing distinct short quotes.
 */
export function mergeBookClippingsMaps(
	baseBooks: Map<string, Clipping[]>,
	incomingBooks: Map<string, Clipping[]>
): Map<string, Clipping[]> {
	const merged = new Map<string, Clipping[]>();
	const keyToCanonicalTitle = new Map<string, string>();

	for (const [title, clips] of baseBooks.entries()) {
		merged.set(title, clips.map((c) => ({ ...c })));
		const key = normalizeAlnumKey(title);
		if (key && !keyToCanonicalTitle.has(key)) {
			keyToCanonicalTitle.set(key, title);
		}
	}

	for (const [incomingTitle, incomingClips] of incomingBooks.entries()) {
		const incomingAuthor = incomingClips.find((c) => c.author)?.author || "";
		const targetTitle = resolveCanonicalTitle(
			incomingTitle,
			incomingAuthor,
			merged,
			keyToCanonicalTitle
		);

		let targetList = merged.get(targetTitle);
		if (!targetList) {
			merged.set(
				targetTitle,
				incomingClips.map((c) => ({ ...c }))
			);
			const key = normalizeAlnumKey(targetTitle);
			if (key && !keyToCanonicalTitle.has(key)) {
				keyToCanonicalTitle.set(key, targetTitle);
			}
			continue;
		}

		let existingByNorm = indexBookClips(targetList);

		for (const incClip of incomingClips) {
			const norm = getClipDedupKey(incClip.text);
			if (!norm) continue;

			const incIsPlaceholder = isClippingLimitPlaceholder(incClip.text);

			// Replace legacy <clipping limit> placeholders covered by KFX/HTML quote range while preserving notes
			if (!incIsPlaceholder && incClip.locationStart > 0) {
				const matchedIndices: number[] = [];
				for (let idx = 0; idx < targetList.length; idx++) {
					const existing = targetList[idx];
					if (
						isClippingLimitPlaceholder(existing.text) &&
						existing.locationStart > 0 &&
						existing.locationStart >= incClip.locationStart - 5 &&
						existing.locationEnd <= incClip.locationEnd + 5
					) {
						matchedIndices.push(idx);
					}
				}
				if (matchedIndices.length > 0) {
					let mergedNote: string | undefined;
					let fallbackAuthor = "";
					for (const idx of matchedIndices) {
						const oldPh = targetList[idx];
						if (!fallbackAuthor && oldPh.author) fallbackAuthor = oldPh.author;
						mergedNote = appendOrMergeNoteText(mergedNote, oldPh.note, {
							replaceIncremental: false,
						});
					}
					mergedNote = appendOrMergeNoteText(mergedNote, incClip.note, {
						replaceIncremental: true,
					});

					const firstIdx = matchedIndices[0];
					targetList[firstIdx] = {
						...incClip,
						title: targetTitle,
						author: incClip.author || fallbackAuthor || "",
						note: mergedNote,
					};
					if (matchedIndices.length > 1) {
						const dropSet = new Set(matchedIndices.slice(1));
						targetList = targetList.filter((_, idx) => !dropSet.has(idx));
						merged.set(targetTitle, targetList);
					}
					existingByNorm = indexBookClips(targetList);
					continue;
				}
			}

			// Skip incoming placeholder if real text already covers that location
			if (incIsPlaceholder && incClip.locationStart > 0) {
				const hasRealAtLoc = targetList.some(
					(existing) =>
						!isClippingLimitPlaceholder(existing.text) &&
						existing.locationStart > 0 &&
						existing.locationStart - 5 <= incClip.locationStart &&
						incClip.locationEnd <= existing.locationEnd + 5
				);
				if (hasRealAtLoc) continue;
			}

			const duplicateOf = findMatchingExistingClip(incClip, norm, existingByNorm);
			if (duplicateOf) {
				const mergedNote = appendOrMergeNoteText(duplicateOf.note, incClip.note, {
					replaceIncremental: true,
				});
				if (mergedNote) {
					duplicateOf.note = mergedNote;
				}
				continue;
			}

			const clone: Clipping = {
				...incClip,
				title: targetTitle,
				author: incClip.author || targetList[0]?.author || "",
			};
			targetList.push(clone);
			const arr = existingByNorm.get(norm);
			if (arr) arr.push(clone);
			else existingByNorm.set(norm, [clone]);
		}
	}

	return merged;
}
