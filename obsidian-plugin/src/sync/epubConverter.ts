import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const CONVERTIBLE_FORMAT_PRIORITY: Array<{ suffix: string; label: string }> = [
	{ suffix: ".fb2", label: "FB2" },
	{ suffix: ".fb2.zip", label: "FB2.ZIP" },
	{ suffix: ".azw3", label: "AZW3" },
	{ suffix: ".mobi", label: "MOBI" },
	{ suffix: ".rtf", label: "RTF" },
	{ suffix: ".docx", label: "DOCX" },
	{ suffix: ".html", label: "HTML" },
	{ suffix: ".htm", label: "HTM" },
	{ suffix: ".xhtml", label: "XHTML" },
	{ suffix: ".txt", label: "TXT" },
	{ suffix: ".odt", label: "ODT" },
	{ suffix: ".lit", label: "LIT" },
	{ suffix: ".prc", label: "PRC" },
	{ suffix: ".kfx", label: "KFX" },
];

export interface EnsureEpubResult {
	epubPath: string;
	converted: boolean;
	sourceFormat: string | null;
}

const inFlightConversions = new Map<string, Promise<EnsureEpubResult>>();

/**
 * Resolves the `ebook-convert` CLI binary shipped with Calibre across Linux/macOS/Windows.
 */
export function findEbookConvertBinary(): string {
	const candidates: string[] = [];
	if (process.platform === "linux") {
		candidates.push("/usr/bin/ebook-convert", "/usr/local/bin/ebook-convert", "/opt/calibre/ebook-convert");
	} else if (process.platform === "darwin") {
		candidates.push("/Applications/calibre.app/Contents/MacOS/ebook-convert", "/usr/local/bin/ebook-convert");
	} else if (process.platform === "win32") {
		const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
		const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
		candidates.push(
			path.join(programFiles, "Calibre2", "ebook-convert.exe"),
			path.join(programFiles, "Calibre", "ebook-convert.exe"),
			path.join(programFilesX86, "Calibre2", "ebook-convert.exe")
		);
	}

	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		} catch {
			/* ignore inaccessible path */
		}
	}

	return "ebook-convert";
}

/**
 * Finds an existing non-empty `.epub` file inside a Calibre book folder.
 */
export function findExistingEpubInDir(bookDir: string): string | null {
	try {
		if (!bookDir || !fs.existsSync(bookDir) || !fs.statSync(bookDir).isDirectory()) {
			return null;
		}
		const entries = fs.readdirSync(bookDir);
		for (const entry of entries) {
			const lower = entry.toLowerCase();
			if (!lower.endsWith(".epub") || entry.startsWith(".converting-")) {
				continue;
			}
			const fullPath = path.join(bookDir, entry);
			try {
				const st = fs.statSync(fullPath);
				if (st.isFile() && st.size > 0) {
					return fullPath;
				}
			} catch {
				/* ignore unreadable entry */
			}
		}
	} catch {
		/* ignore inaccessible dir */
	}
	return null;
}

/**
 * Picks the highest-priority convertible source file in a Calibre book folder.
 */
export function findBestConvertibleSourceInDir(
	bookDir: string
): { filePath: string; format: string } | null {
	try {
		if (!bookDir || !fs.existsSync(bookDir) || !fs.statSync(bookDir).isDirectory()) {
			return null;
		}
		const entries = fs.readdirSync(bookDir);
		for (const { suffix, label } of CONVERTIBLE_FORMAT_PRIORITY) {
			const match = entries.find((f) => {
				if (f.startsWith(".")) return false;
				return f.toLowerCase().endsWith(suffix);
			});
			if (match) {
				const fullPath = path.join(bookDir, match);
				try {
					const st = fs.statSync(fullPath);
					if (st.isFile() && st.size > 0) {
						return { filePath: fullPath, format: label };
					}
				} catch {
					/* skip unreadable candidate */
				}
			}
		}
	} catch {
		/* ignore inaccessible dir */
	}
	return null;
}

/**
 * Scans a Calibre Library directory for the folder belonging to numeric `bookId`.
 */
export function findBookDirectoryById(libraryPath: string, bookId: string): string | null {
	if (!libraryPath || !bookId || !fs.existsSync(libraryPath)) {
		return null;
	}
	const suffix = `(${bookId})`;
	try {
		for (const authorName of fs.readdirSync(libraryPath)) {
			const authorDir = path.join(libraryPath, authorName);
			try {
				if (!fs.statSync(authorDir).isDirectory()) continue;
			} catch {
				continue;
			}
			for (const bookName of fs.readdirSync(authorDir)) {
				if (!bookName.endsWith(suffix)) continue;
				const bookDir = path.join(authorDir, bookName);
				try {
					if (fs.statSync(bookDir).isDirectory()) {
						return bookDir;
					}
				} catch {
					continue;
				}
			}
		}
	} catch {
		return null;
	}
	return null;
}

function deriveEpubTargetPath(bookDir: string, sourceFilePath: string): string {
	const fileName = path.basename(sourceFilePath);
	const lower = fileName.toLowerCase();
	const baseName = lower.endsWith(".fb2.zip")
		? fileName.slice(0, -".fb2.zip".length)
		: path.basename(fileName, path.extname(fileName));
	return path.join(bookDir, `${baseName}.epub`);
}

/**
 * Ensures a Calibre book directory contains an `.epub` file, converting the best
 * available source format via `ebook-convert` into a temporary file before renaming.
 * Concurrent calls for the same book folder share a single conversion process.
 */
export async function ensureBookDirHasEpub(
	bookDir: string,
	options?: { timeoutMs?: number }
): Promise<EnsureEpubResult> {
	const resolvedDir = path.resolve(bookDir);

	const existing = findExistingEpubInDir(resolvedDir);
	if (existing) {
		return { epubPath: existing, converted: false, sourceFormat: null };
	}

	const pending = inFlightConversions.get(resolvedDir);
	if (pending) {
		return pending;
	}

	const task = (async (): Promise<EnsureEpubResult> => {
		const recheck = findExistingEpubInDir(resolvedDir);
		if (recheck) {
			return { epubPath: recheck, converted: false, sourceFormat: null };
		}

		const source = findBestConvertibleSourceInDir(resolvedDir);
		if (!source) {
			throw new Error(`No convertible format (FB2/AZW3/MOBI/RTF/KFX/...) found in ${resolvedDir}`);
		}

		const dstEpub = deriveEpubTargetPath(resolvedDir, source.filePath);
		const tmpEpub = path.join(resolvedDir, `.converting-${process.pid}-${Date.now()}.epub`);
		const binary = findEbookConvertBinary();
		const timeoutMs = options?.timeoutMs ?? 180_000;

		try {
			await execFileAsync(binary, [source.filePath, tmpEpub], {
				timeout: timeoutMs,
				maxBuffer: 16 * 1024 * 1024,
			});

			if (!fs.existsSync(tmpEpub) || fs.statSync(tmpEpub).size === 0) {
				throw new Error("ebook-convert completed without producing a valid EPUB file");
			}

			await fs.promises.rename(tmpEpub, dstEpub);
			return {
				epubPath: dstEpub,
				converted: true,
				sourceFormat: source.format,
			};
		} finally {
			try {
				if (fs.existsSync(tmpEpub)) {
					fs.unlinkSync(tmpEpub);
				}
			} catch {
				/* ignore temp cleanup failure */
			}
		}
	})();

	inFlightConversions.set(resolvedDir, task);
	try {
		return await task;
	} finally {
		if (inFlightConversions.get(resolvedDir) === task) {
			inFlightConversions.delete(resolvedDir);
		}
	}
}
