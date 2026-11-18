import * as crypto from "crypto";
import { App, normalizePath, TFile } from "obsidian";
import type { Clipping } from "../types";
import { isIncrementalTextEdit } from "./clippingsParser";

export const DEFAULT_HIGHLIGHTS_FOLDER = "Kindle Highlights";

export function sanitizeFilename(name: string): string {
	return name.replace(/[\\/*?:"<>|]/g, "").trim();
}

export function getNoteFilename(title: string, author: string): string {
	const cleanTitle = sanitizeFilename(title);
	if (author) {
		const authorParts = author.replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
		const surname = authorParts[0] || author;
		return `${sanitizeFilename(surname)}-${cleanTitle}.md`;
	}
	return `${cleanTitle}.md`;
}

function cleanMatchText(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, "").trim();
}

function deterministicFallbackBookId(title: string): string {
	const digest = crypto.createHash("md5").update(title, "utf8").digest("hex");
	return String(parseInt(digest.slice(0, 6), 16) % 100000);
}

/**
 * Resolves vault folder for Kindle highlights:
 * 1. Explicit non-empty configured folder
 * 2. Folder of existing vault notes carrying `kindle-title` or `kindle-bookId` frontmatter
 * 3. Default "Kindle Highlights"
 */
export function resolveHighlightsFolder(app: App, configuredFolder?: string): string {
	if (configuredFolder && configuredFolder.trim()) {
		return normalizePath(configuredFolder.trim());
	}

	const counts = new Map<string, number>();
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (fm && (fm["kindle-title"] !== undefined || fm["kindle-bookId"] !== undefined)) {
			const folder = file.parent?.path && file.parent.path !== "/" ? file.parent.path : "";
			if (folder) {
				counts.set(folder, (counts.get(folder) ?? 0) + 1);
			}
		}
	}

	let bestFolder = "";
	let bestCount = 0;
	for (const [folder, count] of counts.entries()) {
		if (count > bestCount) {
			bestCount = count;
			bestFolder = folder;
		}
	}

	return bestFolder || DEFAULT_HIGHLIGHTS_FOLDER;
}

function looksLikeRepeatedEditHistory(oldNote: string, latestNote: string): boolean {
	const lines = oldNote
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length < 2) return false;
	const latestNorm = latestNote.trim().toLowerCase().replace(/\s+/g, " ");
	const lastNorm = lines[lines.length - 1].toLowerCase().replace(/\s+/g, " ");
	let editPairs = 0;
	for (let i = 0; i < lines.length - 1; i++) {
		if (isIncrementalTextEdit(lines[i], lines[i + 1])) {
			editPairs++;
		}
	}
	if (editPairs > 0 && lastNorm === latestNorm) return true;
	if (editPairs === lines.length - 1) return true;
	return lines.every((l) => isIncrementalTextEdit(l, latestNote));
}

export class VaultExporter {
	readonly app: App;
	readonly folderPath: string;

	constructor(app: App, folderPath: string) {
		this.app = app;
		this.folderPath = normalizePath(folderPath || DEFAULT_HIGHLIGHTS_FOLDER);
	}

	async ensureFolderExists(): Promise<void> {
		if (!this.folderPath) return;
		const existing = this.app.vault.getAbstractFileByPath(this.folderPath);
		if (!existing) {
			await this.app.vault.createFolder(this.folderPath);
		}
	}

	private getFolderMarkdownFiles(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((file) => {
			const parentPath = file.parent?.path === "/" ? "" : file.parent?.path || "";
			return parentPath === this.folderPath;
		});
	}

	async findExistingNoteFile(
		title: string,
		author = "",
		alternateTitle?: string | null
	): Promise<TFile | null> {
		const titles = [title, alternateTitle || ""].filter(Boolean);
		const cleanTitles = titles.map((t) => cleanMatchText(t));

		const possibleNames = new Set<string>();
		for (const t of titles) {
			possibleNames.add(getNoteFilename(t, "").toLowerCase());
			if (author) {
				const parts = author.replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
				if (parts.length > 0) {
					for (const part of [parts[0], parts[parts.length - 1]]) {
						possibleNames.add(`${sanitizeFilename(part)}-${sanitizeFilename(t)}.md`.toLowerCase());
					}
				}
			}
		}

		const files = this.getFolderMarkdownFiles();

		// Pass 1: Exact filename match
		for (const file of files) {
			if (possibleNames.has(file.name.toLowerCase())) {
				return file;
			}
		}

		// Pass 2: Exact frontmatter kindle-title match
		for (const file of files) {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (frontmatter && typeof frontmatter["kindle-title"] === "string") {
				if (cleanTitles.includes(cleanMatchText(frontmatter["kindle-title"]))) {
					return file;
				}
			}
			try {
				const text = await this.app.vault.cachedRead(file);
				const header = text.split("\n").slice(0, 15).join("\n");
				const fmMatch = header.match(/kindle-title:\s*(.+)/i);
				if (fmMatch && cleanTitles.includes(cleanMatchText(fmMatch[1]))) {
					return file;
				}
			} catch {
				/* ignore unreadable file */
			}
		}

		// Pass 3: Title as whole word sequence in filename
		for (const ct of cleanTitles) {
			if (!ct) continue;
			for (const file of files) {
				const words = file.name.toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, " ").trim().split(/\s+/).join(" ");
				if (words.split(" ").includes(ct)) {
					return file;
				}
			}
		}

		// Pass 4: Substring match (titles >= 4 chars)
		for (const ct of cleanTitles) {
			if (ct.length < 4) continue;
			for (const file of files) {
				const cleanFn = cleanMatchText(file.name);
				if (cleanFn.includes(ct)) {
					return file;
				}
			}
		}

		return null;
	}

	private renderHighlightBlock(clip: Clipping, link: string): string {
		const locStr = link ? `[${clip.locationStart}](${link})` : `[${clip.locationStart}]()`;
		let block = `${clip.text} — location: ${locStr} ^ref-${clip.refId}`;
		if (clip.note) {
			block += `\n\n*Note*: ${clip.note}`;
		}
		return block;
	}

	private renderNewNote(
		title: string,
		author: string,
		clippings: Clipping[],
		calibreLinks: Map<string, string>,
		bookId?: string | null
	): string {
		const bId = bookId || deterministicFallbackBookId(title);
		const authorDisplay = author || "Unknown";

		const lines: string[] = [
			"---",
			`kindle-bookId: '${bId}'`,
			`kindle-title: ${title}`,
			`kindle-author: '${authorDisplay}'`,
			`kindle-highlightsCount: ${clippings.length}`,
			"---",
			`# ${title}`,
			"## Metadata",
			`* Author: [[${authorDisplay}]]`,
			"",
			"## Highlights",
		];

		for (const clip of clippings) {
			const link = calibreLinks.get(clip.refId) || "";
			lines.push(this.renderHighlightBlock(clip, link));
			lines.push("");
			lines.push("---");
		}

		return `${lines.join("\n")}\n`;
	}

	async exportOrUpdateBook(
		title: string,
		author: string,
		clippings: Clipping[],
		calibreLinks: Map<string, string>,
		bookId?: string | null,
		alternateTitle?: string | null
	): Promise<{ filePath: string; updatedCount: number }> {
		await this.ensureFolderExists();
		const existing = await this.findExistingNoteFile(title, author, alternateTitle);

		if (!existing) {
			const fname = getNoteFilename(title, author);
			const targetPath = normalizePath(this.folderPath ? `${this.folderPath}/${fname}` : fname);
			const content = this.renderNewNote(title, author, clippings, calibreLinks, bookId);
			await this.app.vault.create(targetPath, content);
			return { filePath: targetPath, updatedCount: clippings.length };
		}

		const originalContent = await this.app.vault.read(existing);
		let content = originalContent;
		let updatedCount = 0;

		const existingRefs = new Set<string>();
		for (const m of content.matchAll(/\^ref-(\w+)/g)) {
			existingRefs.add(m[1]);
		}

		const clipByRefId = new Map<string, Clipping>();
		const clipsByLoc = new Map<string, Clipping[]>();
		for (const c of clippings) {
			clipByRefId.set(c.refId, c);
			const locKey = String(c.locationStart);
			const locList = clipsByLoc.get(locKey);
			if (locList) locList.push(c);
			else clipsByLoc.set(locKey, [c]);
		}

		content = content.replace(
			/(location:\s*)\[(\d+)\]\((.*?)\)\s*\^ref-(\w+)/g,
			(fullMatch, prefix: string, loc: string, existingLink: string, refId: string) => {
				let targetLink = calibreLinks.get(refId);
				if (!targetLink) {
					for (const c of clippings) {
						if (String(c.locationStart) === loc && calibreLinks.has(c.refId)) {
							targetLink = calibreLinks.get(c.refId);
							break;
						}
					}
				}

				if (targetLink && targetLink !== existingLink) {
					updatedCount++;
					return `${prefix}[${loc}](${targetLink}) ^ref-${refId}`;
				}
				return fullMatch;
			}
		);

		content = content.replace(
			/(\[(\d+)\]\([^)]*\)\s*\^ref-(\w+))[ \t]*((?:\r?\n[ \t]*)+\*Note\*:[ \t]*([\s\S]*?))?(?=(?:\r?\n[ \t]*)+---(?:\r?\n|$)|(?:\r?\n[ \t]*)+[^\n]*\^ref-\w+|\s*$)/g,
			(fullMatch, anchorPart: string, loc: string, refId: string, _noteSection?: string, existingNote?: string) => {
				let matchedClip = clipByRefId.get(refId);
				if (!matchedClip) {
					const locCandidates = clipsByLoc.get(loc);
					if (locCandidates && locCandidates.length === 1) {
						matchedClip = locCandidates[0];
					}
				}
				const latestNote = matchedClip?.note?.trim();
				if (!latestNote) {
					return fullMatch;
				}

				if (existingNote === undefined) {
					updatedCount++;
					return `${anchorPart}\n\n*Note*: ${latestNote}`;
				}

				const prevNote = existingNote.trim();
				const prevNorm = prevNote.toLowerCase().replace(/\s+/g, " ");
				const latestNorm = latestNote.toLowerCase().replace(/\s+/g, " ");
				if (
					prevNorm !== latestNorm &&
					(looksLikeRepeatedEditHistory(prevNote, latestNote) || latestNorm.startsWith(prevNorm))
				) {
					updatedCount++;
					return `${anchorPart}\n\n*Note*: ${latestNote}`;
				}

				return fullMatch;
			}
		);

		const newBlocks: string[] = [];
		for (const clip of clippings) {
			if (!existingRefs.has(clip.refId)) {
				const cleanSnippet = clip.text.slice(0, 40);
				if (cleanSnippet && !content.includes(cleanSnippet)) {
					const link = calibreLinks.get(clip.refId) || "";
					newBlocks.push(this.renderHighlightBlock(clip, link));
					updatedCount++;
				}
			}
		}

		if (newBlocks.length > 0) {
			if (!content.endsWith("\n")) {
				content += "\n";
			}
			for (const block of newBlocks) {
				content += `\n${block}\n\n---\n`;
			}
		}

		const finalRefs = new Set<string>();
		for (const m of content.matchAll(/\^ref-(\w+)/g)) {
			finalRefs.add(m[1]);
		}
		content = content.replace(/kindle-highlightsCount:\s*\d+/, `kindle-highlightsCount: ${finalRefs.size}`);

		if (content !== originalContent) {
			await this.app.vault.modify(existing, content);
		}
		return { filePath: existing.path, updatedCount };
	}
}
