import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectKindleHtmlExports } from "./kindleHtmlParser";
import { readMtpKindleSources } from "./mtpClient";

export const KSDK_CACHE_FILENAME = "ksdk_annotation_v1.cache.db";

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
	const resolvedCfg = resolveUserPath(configuredPath);
	if (resolvedCfg) {
		candidates.push(resolvedCfg);
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

export type SyncSourceKind =
	| "kindle-usb"
	| "kindle-mtp"
	| "configured-file"
	| "local-fallback"
	| "missing";

export interface DetectedSyncSources {
	clippingsSource: { path: string; content?: string } | null;
	ksdkDb: { path: string; data: Uint8Array; fromCache: boolean } | null;
	htmlSources: Array<{ path: string; content: string }>;
	extraKfxDirs: string[];
	sourceKind: SyncSourceKind;
	deviceDetectedNotReady: boolean;
	mtpWarning?: string;
	fallbackClippingsSource: { path: string; content?: string } | null;
	fallbackKsdkDb: { path: string; data: Uint8Array; fromCache: boolean } | null;
	fallbackHtmlSources: Array<{ path: string; content: string }>;
}

export interface DetectSyncSourcesOptions {
	clippingsPath?: string;
	ksdkDbPath?: string;
	kindleHtmlPath?: string;
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
	if (trimmed === "~") return os.homedir();
	const expanded =
		trimmed.startsWith("~/") || trimmed.startsWith("~\\")
			? path.join(os.homedir(), trimmed.slice(2))
			: trimmed;
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
	if (sources.htmlSources?.length > 0) {
		parts.push(`${sources.htmlSources.length} HTML export(s)`);
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
 * Detects live Kindle sources (USB Mass Storage / MTP), Kindle Notebook HTML exports,
 * and local/cached fallbacks for both My Clippings.txt and Kindle's ksdk_annotation_v1.db.
 */
export async function detectSyncSourcesAsync(
	options: DetectSyncSourcesOptions
): Promise<DetectedSyncSources> {
	const { clippingsPath, ksdkDbPath, kindleHtmlPath, vaultBasePath } = options;
	const htmlSources = detectKindleHtmlExports(kindleHtmlPath, vaultBasePath);

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
				htmlSources,
				extraKfxDirs: fs.existsSync(docsDir) ? [docsDir] : [],
				sourceKind: "kindle-usb",
				deviceDetectedNotReady: false,
				fallbackClippingsSource: null,
				fallbackKsdkDb: null,
				fallbackHtmlSources: [],
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
			htmlSources,
			extraKfxDirs,
			sourceKind: "kindle-mtp",
			deviceDetectedNotReady: false,
			fallbackClippingsSource: null,
			fallbackKsdkDb: null,
			fallbackHtmlSources: [],
		};
	}

	if (mtp.warning) {
		return {
			clippingsSource: null,
			ksdkDb: null,
			htmlSources: [],
			extraKfxDirs: [],
			sourceKind: "missing",
			deviceDetectedNotReady: true,
			mtpWarning: mtp.warning,
			fallbackClippingsSource: localClip ? { path: localClip.path } : null,
			fallbackKsdkDb: localDb.ksdkDb,
			fallbackHtmlSources: htmlSources,
		};
	}

	// 3. Offline ("без киндла"): local My Clippings.txt + cached/local ksdk DB + Kindle HTML exports
	if (localClip || localDb.ksdkDb || htmlSources.length > 0) {
		const isConfigured = Boolean(
			localClip?.isConfigured ||
			localDb.isConfigured ||
			(kindleHtmlPath?.trim() && htmlSources.length > 0)
		);
		return {
			clippingsSource: localClip ? { path: localClip.path } : null,
			ksdkDb: localDb.ksdkDb,
			htmlSources,
			extraKfxDirs: [],
			sourceKind: isConfigured ? "configured-file" : "local-fallback",
			deviceDetectedNotReady: false,
			fallbackClippingsSource: null,
			fallbackKsdkDb: null,
			fallbackHtmlSources: [],
		};
	}

	return {
		clippingsSource: null,
		ksdkDb: null,
		htmlSources: [],
		extraKfxDirs: [],
		sourceKind: "missing",
		deviceDetectedNotReady: false,
		fallbackClippingsSource: null,
		fallbackKsdkDb: null,
		fallbackHtmlSources: [],
	};
}
