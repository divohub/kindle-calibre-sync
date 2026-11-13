import * as fs from "fs";
import * as path from "path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import type { CfiInfo } from "../types";

const ALNUM_RE = /[\p{L}\p{N}]/u;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const ELEMENT_NODE = 1;

interface IndexedSection {
	spineIndex: number;
	spineName: string;
	normDoc: string;
	normMap: Array<{ node: Node; charIndex: number }>;
}

export interface EpubTextIndex {
	sections: IndexedSection[];
}

function isAlnum(ch: string): boolean {
	return ALNUM_RE.test(ch);
}

function createSilentXmlParser(): DOMParser {
	return new DOMParser({
		errorHandler: {
			warning: () => undefined,
			error: () => undefined,
			fatalError: () => undefined,
		},
	});
}

function getElementsByLocalName(doc: Document, name: string): Element[] {
	const nsMatches = doc.getElementsByTagNameNS("*", name);
	if (nsMatches && nsMatches.length > 0) {
		return Array.from(nsMatches);
	}
	const plainMatches = doc.getElementsByTagName(name);
	return plainMatches ? Array.from(plainMatches) : [];
}

function collectTextNodes(node: Node, out: Node[]): void {
	const children = node.childNodes;
	if (!children) return;
	for (let i = 0; i < children.length; i++) {
		const ch = children[i];
		if (ch.nodeType === TEXT_NODE || ch.nodeType === CDATA_SECTION_NODE) {
			out.push(ch);
		} else if (ch.nodeType === ELEMENT_NODE) {
			collectTextNodes(ch, out);
		}
	}
}

/**
 * Computes EPUB CFI path relative to document root matching calibre_adapter.py / epub.js conventions:
 * /2/element_steps.../text_step:offset
 */
export function calculateCfiForTextNode(textNode: Node, offset: number): string {
	const parent = textNode.parentNode;
	if (!parent || parent.nodeType !== ELEMENT_NODE) {
		return `/2/1:${offset}`;
	}

	let textIdx = 0;
	let matchedText = false;
	const parentChildren = parent.childNodes;
	for (let i = 0; i < parentChildren.length; i++) {
		const ch = parentChildren[i];
		if (ch.nodeType === TEXT_NODE || ch.nodeType === CDATA_SECTION_NODE) {
			if (ch === textNode) {
				matchedText = true;
				break;
			}
			textIdx++;
		}
	}

	const textStep = 2 * (matchedText ? textIdx : 0) + 1;
	let cfi = `/${textStep}:${offset}`;
	let el: Node | null = parent;

	while (el) {
		const pel: Node | null = el.parentNode;
		if (!pel || pel.nodeType !== ELEMENT_NODE) {
			break;
		}
		let elIdx = 0;
		let matchedEl = false;
		const siblings = pel.childNodes;
		for (let i = 0; i < siblings.length; i++) {
			const ch = siblings[i];
			if (ch.nodeType === ELEMENT_NODE) {
				if (ch === el) {
					matchedEl = true;
					break;
				}
				elIdx++;
			}
		}
		if (!matchedEl) {
			break;
		}
		cfi = `/${2 * (elIdx + 1)}` + cfi;
		el = pel;
	}

	return `/2${cfi}`;
}

export function buildPointCfi(spineIndex: number, startCfi: string): string {
	const spineStep = 2 * (spineIndex + 1);
	return `epubcfi(/${spineStep}${startCfi})`;
}

export function buildRangeCfi(spineIndex: number, startCfi: string, endCfi: string): string {
	const spineStep = 2 * (spineIndex + 1);
	const cleanStart = startCfi.startsWith("/2/") ? startCfi.slice(2) : startCfi;
	const cleanEnd = endCfi.startsWith("/2/") ? endCfi.slice(2) : endCfi;
	return `epubcfi(/6/${spineStep}!,${cleanStart},${cleanEnd})`;
}

function findZipEntry(zip: JSZip, rawPath: string): JSZip.JSZipObject | null {
	const normalized = path.posix.normalize(rawPath).replace(/^\/+/, "");
	const candidates = [rawPath, normalized];
	try {
		candidates.push(decodeURIComponent(rawPath), decodeURIComponent(normalized));
	} catch {
		/* ignore invalid URI sequences */
	}
	for (const c of candidates) {
		const found = zip.file(c);
		if (found) return found;
	}
	return null;
}

/**
 * Loads and indexes an EPUB's spine XHTML text nodes once so multiple highlights resolve quickly.
 */
export async function buildEpubTextIndex(epubPath: string): Promise<EpubTextIndex | null> {
	try {
		const rawBytes = await fs.promises.readFile(epubPath);
		const zip = await JSZip.loadAsync(rawBytes);
		const parser = createSilentXmlParser();

		const containerEntry = findZipEntry(zip, "META-INF/container.xml");
		if (!containerEntry) return null;

		const containerDoc = parser.parseFromString(await containerEntry.async("string"), "text/xml");
		const rootfiles = getElementsByLocalName(containerDoc, "rootfile");
		const opfPath = rootfiles[0]?.getAttribute("full-path") || "";
		if (!opfPath) return null;

		const opfEntry = findZipEntry(zip, opfPath);
		if (!opfEntry) return null;

		const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
		const opfDoc = parser.parseFromString(await opfEntry.async("string"), "text/xml");

		const manifest = new Map<string, string>();
		for (const item of getElementsByLocalName(opfDoc, "item")) {
			const id = item.getAttribute("id");
			const href = item.getAttribute("href");
			if (id && href) {
				manifest.set(id, href);
			}
		}

		const spineIds = getElementsByLocalName(opfDoc, "itemref")
			.map((el) => el.getAttribute("idref") || "")
			.filter(Boolean);

		const sections: IndexedSection[] = [];
		for (let spineIndex = 0; spineIndex < spineIds.length; spineIndex++) {
			const href = manifest.get(spineIds[spineIndex]);
			if (!href) continue;

			const filePath = opfDir ? `${opfDir}/${href}` : href;
			const sectionEntry = findZipEntry(zip, filePath);
			if (!sectionEntry) continue;

			const rawContent = await sectionEntry.async("string");
			const doc = parser.parseFromString(rawContent, "application/xhtml+xml");

			const bodies = getElementsByLocalName(doc, "body");
			const root: Node | null = bodies[0] || doc.documentElement;
			if (!root) continue;

			const textNodes: Node[] = [];
			collectTextNodes(root, textNodes);
			if (!textNodes.length) continue;

			const normChars: string[] = [];
			const normMap: Array<{ node: Node; charIndex: number }> = [];

			for (const tn of textNodes) {
				const txt = tn.nodeValue || "";
				for (let ci = 0; ci < txt.length; ci++) {
					const ch = txt[ci];
					if (isAlnum(ch)) {
						normChars.push(ch.toLowerCase());
						normMap.push({ node: tn, charIndex: ci });
					}
				}
			}

			if (normMap.length > 0) {
				sections.push({
					spineIndex,
					spineName: filePath,
					normDoc: normChars.join(""),
					normMap,
				});
			}
		}

		return { sections };
	} catch {
		return null;
	}
}

/**
 * Searches a pre-indexed EPUB for highlightText and computes exact EPUB CFI coordinates.
 */
export function findCfiInIndex(index: EpubTextIndex, highlightText: string): CfiInfo | null {
	const cleanTarget = Array.from(highlightText)
		.filter(isAlnum)
		.map((ch) => ch.toLowerCase())
		.join("");
	if (!cleanTarget) return null;

	const prefix = cleanTarget.length > 45 ? cleanTarget.slice(0, 45) : cleanTarget;

	for (const sec of index.sections) {
		let matchIdx = sec.normDoc.indexOf(cleanTarget);
		let matchLen = cleanTarget.length;

		if (matchIdx < 0 && prefix.length >= 15) {
			matchIdx = sec.normDoc.indexOf(prefix);
			if (matchIdx >= 0) {
				matchLen = Math.min(cleanTarget.length, sec.normDoc.length - matchIdx);
			}
		}

		if (matchIdx < 0) continue;

		const startEntry = sec.normMap[matchIdx];
		const endEntry = sec.normMap[Math.min(sec.normMap.length - 1, matchIdx + matchLen - 1)];

		let startOffset = startEntry.charIndex;
		const startNodeText = startEntry.node.nodeValue || "";
		if (startOffset > 0 && highlightText && !isAlnum(highlightText[0])) {
			if (startNodeText[startOffset - 1] === highlightText[0]) {
				startOffset -= 1;
			}
		}

		const endNodeText = endEntry.node.nodeValue || "";
		let endOffset = Math.min(endNodeText.length, endEntry.charIndex + 1);
		if (endOffset < endNodeText.length && highlightText && !isAlnum(highlightText[highlightText.length - 1])) {
			if (endNodeText[endOffset] === highlightText[highlightText.length - 1]) {
				endOffset += 1;
			}
		}

		const startCfi = calculateCfiForTextNode(startEntry.node, startOffset);
		const endCfi = calculateCfiForTextNode(endEntry.node, endOffset);

		return {
			startCfi,
			endCfi,
			spineIndex: sec.spineIndex,
			spineName: sec.spineName,
			fullCfi: buildPointCfi(sec.spineIndex, startCfi),
			rangeCfi: buildRangeCfi(sec.spineIndex, startCfi, endCfi),
		};
	}

	return null;
}

export async function findTextCfiInEpub(epubPath: string, highlightText: string): Promise<CfiInfo | null> {
	const index = await buildEpubTextIndex(epubPath);
	if (!index) return null;
	return findCfiInIndex(index, highlightText);
}
