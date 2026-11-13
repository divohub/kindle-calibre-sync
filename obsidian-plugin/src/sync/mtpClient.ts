import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const AMAZON_USB_VENDOR_HEX = "1949";
const CLIPPINGS_FILENAME = "My Clippings.txt";
const CLIPPINGS_FILENAME_LOWER = "my clippings.txt";
const KSDK_DB_FILENAME = "ksdk_annotation_v1.db";
const KSDK_DB_FILENAME_LOWER = "ksdk_annotation_v1.db";
const MTP_CMD_TIMEOUT_MS = 15000;
const MTP_MAX_BUFFER = 32 * 1024 * 1024;
const CALIBRE_JSON_MARKER = "KINDLE_MTP_JSON:";

export type MtpBackend = "gvfs" | "gio" | "calibre" | "libmtp";

export interface MtpClippingsResult {
	path: string;
	content: string;
	backend: MtpBackend;
}

export interface MtpKsdkDbResult {
	path: string;
	data: Uint8Array;
	backend: MtpBackend;
}

export interface MtpAttemptOutcome {
	result: MtpClippingsResult | null;
	warning?: string;
}

export interface MtpSourcesOutcome {
	clippings: MtpClippingsResult | null;
	ksdkDb: MtpKsdkDbResult | null;
	deviceRootDir?: string;
	warning?: string;
}

interface CalibreMtpPayload {
	ok?: boolean;
	clippings_path?: string | null;
	clippings_content?: string | null;
	ksdk_path?: string | null;
	ksdk_b64?: string | null;
	found_mtp?: boolean;
	error?: string | null;
}

const CALIBRE_MTP_SCRIPT = [
	"import base64, io, json, sys",
	"from types import SimpleNamespace",
	"from calibre.devices.scanner import DeviceScanner",
	"from calibre.devices.mtp.driver import BASE",
	"class ReadOnlyMTP(BASE):",
	"    prefs = {}",
	"MARK = 'KINDLE_MTP_JSON:'",
	"dev = ReadOnlyMTP(None)",
	"dev.startup()",
	"seen = set()",
	"found_mtp = False",
	"last_err = None",
	"try:",
	"    scanner = DeviceScanner()",
	"    scanner.scan()",
	"    all_devs = list(scanner.devices)",
	"    kindle_devs = [d for d in all_devs if getattr(d, 'vendor_id', None) == 0x1949]",
	"    passes = [kindle_devs, all_devs] if kindle_devs else [all_devs]",
	"    for devs in passes:",
	"        while True:",
	"            cd = dev.detect_managed_devices(devs, force_refresh=True)",
	"            if cd is None or cd in seen:",
	"                break",
	"            seen.add(cd)",
	"            found_mtp = True",
	"            try:",
	"                dev.open(cd, None)",
	"            except Exception as exc:",
	"                last_err = f'{type(exc).__name__}: {exc}'",
	"                dev.blacklisted_devices.add(cd)",
	"                continue",
	"            try:",
	"                sids = [s for s in (getattr(dev, '_main_id', None), getattr(dev, '_carda_id', None), getattr(dev, '_cardb_id', None)) if s]",
	"                clip_path, clip_content = None, None",
	"                ksdk_path, ksdk_b64 = None, None",
	"                for sid in sids:",
	"                    parent = SimpleNamespace(is_folder=True, is_storage=True, storage_id=sid, object_id=sid, full_path=('Internal Storage',))",
	"                    if clip_content is None:",
	"                        for rel in (('documents', 'My Clippings.txt'), ('Documents', 'My Clippings.txt'), ('My Clippings.txt',)):",
	"                            try:",
	"                                buf = io.BytesIO()",
	"                                dev.get_mtp_file_by_name(parent, *rel, stream=buf)",
	"                                clip_content = buf.getvalue().decode('utf-8-sig', errors='replace')",
	"                                clip_path = 'mtp://' + '/'.join(rel)",
	"                                break",
	"                            except FileNotFoundError:",
	"                                continue",
	"                            except Exception as exc:",
	"                                last_err = f'{type(exc).__name__}: {exc}'",
	"                    if ksdk_b64 is None:",
	"                        try:",
	"                            entries = dev.list_mtp_folder_by_name(parent, 'system', 'ksdk', '.annotations') or []",
	"                            best_bytes = b''",
	"                            best_name = None",
	"                            for entry in entries:",
	"                                name = entry.get('name', '') if isinstance(entry, dict) else getattr(entry, 'name', '')",
	"                                if not name:",
	"                                    continue",
	"                                try:",
	"                                    db_buf = io.BytesIO()",
	"                                    dev.get_mtp_file_by_name(parent, 'system', 'ksdk', '.annotations', name, 'ksdk_annotation_v1.db', stream=db_buf)",
	"                                    raw = db_buf.getvalue()",
	"                                    if len(raw) > len(best_bytes):",
	"                                        best_bytes = raw",
	"                                        best_name = name",
	"                                except FileNotFoundError:",
	"                                    continue",
	"                            if best_bytes and best_name:",
	"                                ksdk_b64 = base64.b64encode(best_bytes).decode('ascii')",
	"                                ksdk_path = f'mtp://system/ksdk/.annotations/{best_name}/ksdk_annotation_v1.db'",
	"                        except FileNotFoundError:",
	"                            pass",
	"                        except Exception as exc:",
	"                            last_err = f'{type(exc).__name__}: {exc}'",
	"                if clip_content is not None or ksdk_b64 is not None:",
	"                    print(MARK + json.dumps({'ok': True, 'clippings_path': clip_path, 'clippings_content': clip_content, 'ksdk_path': ksdk_path, 'ksdk_b64': ksdk_b64}), flush=True)",
	"                    sys.exit(0)",
	"            finally:",
	"                eject_fn = getattr(dev, 'do_eject', None) or dev.eject",
	"                eject_fn()",
	"    print(MARK + json.dumps({'ok': False, 'found_mtp': found_mtp, 'error': last_err}), flush=True)",
	"finally:",
	"    dev.shutdown()",
].join("\n");

function getCleanChildEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.PYTHONHOME;
	delete env.PYTHONPATH;
	return env;
}

function isKindleIdentifier(text: string): boolean {
	return /kindle|lab126|1949/i.test(text);
}

function classifyMtpError(rawError: string): string {
	const lower = rawError.toLowerCase();
	if (lower.includes("openactionneeded") || lower.includes("no storage") || lower.includes("unlock")) {
		return "Kindle connected over MTP, but storage is locked. Unlock the Kindle screen, then retry.";
	}
	if (
		lower.includes("openfailed") ||
		lower.includes("busy") ||
		lower.includes("already mounted") ||
		lower.includes("unable to open") ||
		lower.includes("claim")
	) {
		return "Kindle connected over MTP, but another app (e.g. Calibre or file manager) holds the USB lock. Close it or unlock Kindle, then retry.";
	}
	return `Kindle MTP read error: ${rawError.trim()}`;
}

async function hasLinuxKindleUsbDevice(): Promise<boolean | null> {
	if (process.platform !== "linux") return null;
	const usbSysDir = "/sys/bus/usb/devices";
	try {
		const entries = await fs.promises.readdir(usbSysDir);
		let readableCount = 0;
		for (const entry of entries) {
			try {
				const vendor = (await fs.promises.readFile(path.join(usbSysDir, entry, "idVendor"), "utf8"))
					.trim()
					.toLowerCase();
				readableCount++;
				if (vendor === AMAZON_USB_VENDOR_HEX) {
					return true;
				}
			} catch {
				/* interface/hub entry without idVendor */
			}
		}
		return readableCount > 0 ? false : null;
	} catch {
		return null;
	}
}

async function findClippingsFileInRoot(dirPath: string): Promise<string | null> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
	} catch {
		return null;
	}

	const directFile = entries.find(
		(e) => !e.isDirectory() && e.name.toLowerCase() === CLIPPINGS_FILENAME_LOWER
	);
	if (directFile) {
		return path.join(dirPath, directFile.name);
	}

	const docsDir = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === "documents");
	if (docsDir) {
		const docsPath = path.join(dirPath, docsDir.name);
		try {
			const docEntries = await fs.promises.readdir(docsPath, { withFileTypes: true });
			const clippings = docEntries.find(
				(e) => !e.isDirectory() && e.name.toLowerCase() === CLIPPINGS_FILENAME_LOWER
			);
			if (clippings) {
				return path.join(docsPath, clippings.name);
			}
		} catch {
			/* unreadable documents folder */
		}
	}

	return null;
}

async function findKsdkDbInRoot(dirPath: string): Promise<string | null> {
	const annDir = path.join(dirPath, "system", "ksdk", ".annotations");
	let subEntries: fs.Dirent[];
	try {
		subEntries = await fs.promises.readdir(annDir, { withFileTypes: true });
	} catch {
		return null;
	}

	let bestPath: string | null = null;
	let bestSize = -1;

	for (const sub of subEntries) {
		if (!sub.isDirectory()) continue;
		const subDir = path.join(annDir, sub.name);
		try {
			const files = await fs.promises.readdir(subDir, { withFileTypes: true });
			const dbEntry = files.find(
				(f) => !f.isDirectory() && f.name.toLowerCase() === KSDK_DB_FILENAME_LOWER
			);
			if (!dbEntry) continue;
			const full = path.join(subDir, dbEntry.name);
			const st = await fs.promises.stat(full);
			if (st.size > bestSize) {
				bestSize = st.size;
				bestPath = full;
			}
		} catch {
			/* skip unreadable account folder */
		}
	}

	return bestPath;
}

async function tryLinuxGvfsSources(): Promise<MtpSourcesOutcome | null> {
	if (process.platform !== "linux") return null;

	const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
	const gvfsRoots = Array.from(
		new Set([
			process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, "gvfs") : "",
			`/run/user/${uid}/gvfs`,
		].filter(Boolean))
	);

	const mtpMounts: string[] = [];
	for (const gvfsRoot of gvfsRoots) {
		try {
			const entries = await fs.promises.readdir(gvfsRoot, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() && entry.name.startsWith("mtp:")) {
					mtpMounts.push(path.join(gvfsRoot, entry.name));
				}
			}
		} catch {
			/* gvfs dir absent */
		}
	}

	if (mtpMounts.length === 0) return null;

	mtpMounts.sort((a, b) => Number(isKindleIdentifier(b)) - Number(isKindleIdentifier(a)));

	for (const mountDir of mtpMounts) {
		const candidateRoots: string[] = [mountDir];
		try {
			const subdirs = await fs.promises.readdir(mountDir, { withFileTypes: true });
			for (const storage of subdirs) {
				if (storage.isDirectory()) {
					candidateRoots.push(path.join(mountDir, storage.name));
				}
			}
		} catch {
			/* ignore unreadable mount root */
		}

		for (const rootDir of candidateRoots) {
			const clipPath = await findClippingsFileInRoot(rootDir);
			const ksdkPath = await findKsdkDbInRoot(rootDir);
			if (!clipPath && !ksdkPath) continue;

			const clippings: MtpClippingsResult | null = clipPath
				? {
						path: clipPath,
						content: await fs.promises.readFile(clipPath, "utf8"),
						backend: "gvfs",
					}
				: null;

			let ksdkDb: MtpKsdkDbResult | null = null;
			if (ksdkPath) {
				const buf = await fs.promises.readFile(ksdkPath);
				ksdkDb = {
					path: ksdkPath,
					data: new Uint8Array(buf),
					backend: "gvfs",
				};
			}

			return {
				clippings,
				ksdkDb,
				deviceRootDir: rootDir,
			};
		}
	}

	return null;
}

interface GioMtpTarget {
	uri: string;
	isKindle: boolean;
}

function parseGioMtpTargets(output: string): GioMtpTarget[] {
	const targets: GioMtpTarget[] = [];
	const seenUris = new Set<string>();
	const blocks = output.split(/\n(?=\s*(?:Drive|Volume|Mount)\(\d+\):)/);

	for (const block of blocks) {
		const match = block.match(/mtp:\/\/[^\s'"]+/);
		if (!match) continue;
		const uri = match[0];
		if (seenUris.has(uri)) continue;
		seenUris.add(uri);
		targets.push({ uri, isKindle: isKindleIdentifier(block) });
	}

	targets.sort((a, b) => Number(b.isKindle) - Number(a.isKindle));
	return targets;
}

async function listGioChildUris(parentUri: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("gio", ["list", "-u", parentUri], {
			timeout: 8000,
			maxBuffer: 4 * 1024 * 1024,
			env: getCleanChildEnv(),
		});
		return stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function uriBasename(uri: string): string {
	const stripped = uri.replace(/\/+$/, "");
	const lastSlash = stripped.lastIndexOf("/");
	const raw = lastSlash >= 0 ? stripped.slice(lastSlash + 1) : stripped;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

async function readGioFileText(fileUri: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("gio", ["cat", fileUri], {
			timeout: MTP_CMD_TIMEOUT_MS,
			maxBuffer: MTP_MAX_BUFFER,
			env: getCleanChildEnv(),
		});
		return stdout;
	} catch {
		return null;
	}
}

async function readGioFileBytes(fileUri: string): Promise<Uint8Array | null> {
	try {
		const { stdout } = await execFileAsync("gio", ["cat", fileUri], {
			timeout: MTP_CMD_TIMEOUT_MS,
			maxBuffer: MTP_MAX_BUFFER,
			encoding: "buffer",
			env: getCleanChildEnv(),
		});
		return new Uint8Array(stdout);
	} catch {
		return null;
	}
}

async function findAndReadSourcesViaGioList(
	rootUri: string
): Promise<{ clippings: MtpClippingsResult | null; ksdkDb: MtpKsdkDbResult | null; storageCount: number }> {
	const storageUris = await listGioChildUris(rootUri);
	const dirsToCheck = [rootUri, ...storageUris];

	let clippings: MtpClippingsResult | null = null;
	let ksdkDb: MtpKsdkDbResult | null = null;

	for (const baseUri of dirsToCheck) {
		const children = await listGioChildUris(baseUri);

		if (!clippings) {
			const directFile = children.find(
				(u) => uriBasename(u).toLowerCase() === CLIPPINGS_FILENAME_LOWER
			);
			if (directFile) {
				const content = await readGioFileText(directFile);
				if (content !== null) {
					clippings = { path: directFile, content, backend: "gio" };
				}
			}

			if (!clippings) {
				const docsUri = children.find((u) => uriBasename(u).toLowerCase() === "documents");
				if (docsUri) {
					const docChildren = await listGioChildUris(docsUri);
					const targetFile = docChildren.find(
						(u) => uriBasename(u).toLowerCase() === CLIPPINGS_FILENAME_LOWER
					);
					if (targetFile) {
						const content = await readGioFileText(targetFile);
						if (content !== null) {
							clippings = { path: targetFile, content, backend: "gio" };
						}
					}
				}
			}
		}

		if (!ksdkDb) {
			const sysUri = children.find((u) => uriBasename(u).toLowerCase() === "system");
			if (sysUri) {
				const sysChildren = await listGioChildUris(sysUri);
				const ksdkUri = sysChildren.find((u) => uriBasename(u).toLowerCase() === "ksdk");
				if (ksdkUri) {
					const ksdkChildren = await listGioChildUris(ksdkUri);
					const annUri = ksdkChildren.find((u) => uriBasename(u) === ".annotations");
					if (annUri) {
						const acctUris = await listGioChildUris(annUri);
						let bestData: Uint8Array | null = null;
						let bestUri = "";
						for (const acctUri of acctUris) {
							const acctFiles = await listGioChildUris(acctUri);
							const dbUri = acctFiles.find(
								(u) => uriBasename(u).toLowerCase() === KSDK_DB_FILENAME_LOWER
							);
							if (!dbUri) continue;
							const data = await readGioFileBytes(dbUri);
							if (data && (!bestData || data.length > bestData.length)) {
								bestData = data;
								bestUri = dbUri;
							}
						}
						if (bestData && bestUri) {
							ksdkDb = { path: bestUri, data: bestData, backend: "gio" };
						}
					}
				}
			}
		}
	}

	return { clippings, ksdkDb, storageCount: storageUris.length };
}

async function tryLinuxGioSources(): Promise<MtpSourcesOutcome & { handledByGio?: boolean }> {
	if (process.platform !== "linux") return { clippings: null, ksdkDb: null };

	let mountListOutput = "";
	try {
		const { stdout } = await execFileAsync("gio", ["mount", "-li"], {
			timeout: 6000,
			maxBuffer: 4 * 1024 * 1024,
			env: getCleanChildEnv(),
		});
		mountListOutput = stdout;
	} catch {
		return { clippings: null, ksdkDb: null };
	}

	const targets = parseGioMtpTargets(mountListOutput);
	if (targets.length === 0) return { clippings: null, ksdkDb: null };

	let warning: string | undefined;
	let handledByGio = false;
	for (const target of targets) {
		try {
			await execFileAsync("gio", ["mount", target.uri], {
				timeout: MTP_CMD_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
				env: getCleanChildEnv(),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!/already mounted/i.test(msg) && target.isKindle) {
				warning = classifyMtpError(msg);
			}
		}

		const mountedGvfs = await tryLinuxGvfsSources();
		if (mountedGvfs && (mountedGvfs.clippings || mountedGvfs.ksdkDb)) {
			return { ...mountedGvfs, handledByGio: true };
		}

		const gioRead = await findAndReadSourcesViaGioList(target.uri);
		if (gioRead.clippings || gioRead.ksdkDb) {
			return {
				clippings: gioRead.clippings,
				ksdkDb: gioRead.ksdkDb,
				handledByGio: true,
			};
		}

		if (target.isKindle) {
			handledByGio = true;
			if (gioRead.storageCount > 0) {
				warning =
					"Kindle connected via MTP, but neither documents/My Clippings.txt nor ksdk_annotation_v1.db was found.";
			} else if (!warning) {
				warning =
					"Kindle connected via MTP, but storage appears locked or empty. Unlock the Kindle screen, then retry.";
			}
		}
	}

	return { clippings: null, ksdkDb: null, warning, handledByGio };
}

function getCalibreDebugCandidates(): string[] {
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA || "";
		return [
			"calibre-debug.exe",
			"calibre-debug",
			"C:\\Program Files\\Calibre2\\calibre-debug.exe",
			"C:\\Program Files (x86)\\Calibre2\\calibre-debug.exe",
			localAppData ? path.join(localAppData, "calibre", "calibre-debug.exe") : "",
		].filter(Boolean);
	}
	if (process.platform === "darwin") {
		return [
			"/Applications/calibre.app/Contents/MacOS/calibre-debug",
			"/opt/homebrew/bin/calibre-debug",
			"/usr/local/bin/calibre-debug",
			"calibre-debug",
		];
	}
	return [
		"/usr/bin/calibre-debug",
		"/usr/local/bin/calibre-debug",
		"/opt/calibre/calibre-debug",
		"calibre-debug",
	];
}

async function tryCalibreMtpSources(): Promise<MtpSourcesOutcome> {
	const env = getCleanChildEnv();

	for (const bin of getCalibreDebugCandidates()) {
		if (path.isAbsolute(bin) && !fs.existsSync(bin)) {
			continue;
		}
		try {
			const { stdout } = await execFileAsync(bin, ["-c", CALIBRE_MTP_SCRIPT], {
				timeout: 20000,
				maxBuffer: MTP_MAX_BUFFER,
				env,
			});
			const markerLine = stdout
				.split(/\r?\n/)
				.find((line) => line.startsWith(CALIBRE_JSON_MARKER));
			if (!markerLine) {
				return { clippings: null, ksdkDb: null };
			}
			const payload = JSON.parse(markerLine.slice(CALIBRE_JSON_MARKER.length)) as CalibreMtpPayload;
			if (payload.ok) {
				const clippings: MtpClippingsResult | null =
					typeof payload.clippings_content === "string"
						? {
								path: payload.clippings_path || `mtp://documents/${CLIPPINGS_FILENAME}`,
								content: payload.clippings_content,
								backend: "calibre",
							}
						: null;

				let ksdkDb: MtpKsdkDbResult | null = null;
				if (typeof payload.ksdk_b64 === "string" && payload.ksdk_b64.length > 0) {
					ksdkDb = {
						path: payload.ksdk_path || `mtp://system/ksdk/.annotations/${KSDK_DB_FILENAME}`,
						data: new Uint8Array(Buffer.from(payload.ksdk_b64, "base64")),
						backend: "calibre",
					};
				}

				if (clippings || ksdkDb) {
					return { clippings, ksdkDb };
				}
			}
			if (payload.found_mtp && payload.error) {
				return { clippings: null, ksdkDb: null, warning: classifyMtpError(payload.error) };
			}
			return { clippings: null, ksdkDb: null };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				continue;
			}
			const msg = err instanceof Error ? err.message : String(err);
			return { clippings: null, ksdkDb: null, warning: classifyMtpError(msg) };
		}
	}

	return { clippings: null, ksdkDb: null };
}

function parseLibmtpFileId(filesOutput: string, lowerFilename: string): number | null {
	const idMatches: Array<{ id: number; size: number }> = [];
	const blocks = filesOutput.split(/(?=^File ID:\s*\d+)/m);

	for (const block of blocks) {
		const idMatch = block.match(/^File ID:\s*(\d+)/m);
		const nameMatch = block.match(/^\s*Filename:\s*(.+)$/m);
		if (!idMatch || !nameMatch) continue;
		if (nameMatch[1].trim().toLowerCase() !== lowerFilename) continue;

		const sizeMatch = block.match(/^\s*File size\s+(\d+)/m);
		const size = sizeMatch ? Number.parseInt(sizeMatch[1], 10) : 0;
		idMatches.push({ id: Number.parseInt(idMatch[1], 10), size });
	}

	if (idMatches.length === 0) return null;
	idMatches.sort((a, b) => b.size - a.size);
	return idMatches[0].id;
}

async function fetchLibmtpFile(fileId: number, ext: string): Promise<Uint8Array | null> {
	const tempPath = path.join(
		os.tmpdir(),
		`kindle-mtp-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
	);
	try {
		await execFileAsync("mtp-getfile", [String(fileId), tempPath], {
			timeout: MTP_CMD_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
			env: getCleanChildEnv(),
		});
		const buf = await fs.promises.readFile(tempPath);
		return new Uint8Array(buf);
	} finally {
		await fs.promises.unlink(tempPath).catch(() => undefined);
	}
}

async function tryLibmtpCliSources(): Promise<MtpSourcesOutcome> {
	if (process.platform === "win32") return { clippings: null, ksdkDb: null };

	let stdout = "";
	try {
		const res = await execFileAsync("mtp-files", [], {
			timeout: MTP_CMD_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
			env: getCleanChildEnv(),
		});
		stdout = res.stdout;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { clippings: null, ksdkDb: null };
		const msg = err instanceof Error ? err.message : String(err);
		if (/unable to open|busy|claim|no storage/i.test(msg)) {
			return { clippings: null, ksdkDb: null, warning: classifyMtpError(msg) };
		}
		return { clippings: null, ksdkDb: null };
	}

	if (/unable to open/i.test(stdout)) {
		return { clippings: null, ksdkDb: null, warning: classifyMtpError(stdout) };
	}

	const clippingsId = parseLibmtpFileId(stdout, CLIPPINGS_FILENAME_LOWER);
	const ksdkId = parseLibmtpFileId(stdout, KSDK_DB_FILENAME_LOWER);
	if (clippingsId === null && ksdkId === null) {
		return { clippings: null, ksdkDb: null };
	}

	try {
		let clippings: MtpClippingsResult | null = null;
		let ksdkDb: MtpKsdkDbResult | null = null;

		if (clippingsId !== null) {
			const bytes = await fetchLibmtpFile(clippingsId, "txt");
			if (bytes) {
				clippings = {
					path: `mtp://documents/${CLIPPINGS_FILENAME}`,
					content: Buffer.from(bytes).toString("utf8"),
					backend: "libmtp",
				};
			}
		}
		if (ksdkId !== null) {
			const bytes = await fetchLibmtpFile(ksdkId, "db");
			if (bytes) {
				ksdkDb = {
					path: `mtp://system/ksdk/.annotations/${KSDK_DB_FILENAME}`,
					data: bytes,
					backend: "libmtp",
				};
			}
		}

		return { clippings, ksdkDb };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { clippings: null, ksdkDb: null, warning: classifyMtpError(msg) };
	}
}

/**
 * Attempts to read live My Clippings.txt and ksdk_annotation_v1.db from a connected MTP Kindle
 * across Linux (gvfs/gio), Calibre's bundled MTP driver (cross-platform), and libmtp CLI.
 */
export async function readMtpKindleSources(): Promise<MtpSourcesOutcome> {
	const gvfsResult = await tryLinuxGvfsSources();
	if (gvfsResult && (gvfsResult.clippings || gvfsResult.ksdkDb)) {
		return gvfsResult;
	}

	const linuxUsbDetected = await hasLinuxKindleUsbDevice();
	if (linuxUsbDetected === false) {
		return { clippings: null, ksdkDb: null };
	}

	let firstWarning: string | undefined;

	if (process.platform === "linux") {
		const gioOutcome = await tryLinuxGioSources();
		if (gioOutcome.clippings || gioOutcome.ksdkDb) {
			return {
				clippings: gioOutcome.clippings,
				ksdkDb: gioOutcome.ksdkDb,
				deviceRootDir: gioOutcome.deviceRootDir,
			};
		}
		if (gioOutcome.handledByGio && gioOutcome.warning) {
			return { clippings: null, ksdkDb: null, warning: gioOutcome.warning };
		}
		if (gioOutcome.warning) firstWarning = gioOutcome.warning;
	}

	const calibreOutcome = await tryCalibreMtpSources();
	if (calibreOutcome.clippings || calibreOutcome.ksdkDb) {
		return calibreOutcome;
	}
	if (!firstWarning && calibreOutcome.warning) {
		firstWarning = calibreOutcome.warning;
	}

	const libmtpOutcome = await tryLibmtpCliSources();
	if (libmtpOutcome.clippings || libmtpOutcome.ksdkDb) {
		return libmtpOutcome;
	}
	if (!firstWarning && libmtpOutcome.warning) {
		firstWarning = libmtpOutcome.warning;
	}

	if (!firstWarning && linuxUsbDetected === true) {
		firstWarning =
			"Kindle USB device detected (MTP), but annotation files could not be read automatically. Unlock the Kindle screen or close Calibre/file manager, then retry.";
	}

	return { clippings: null, ksdkDb: null, warning: firstWarning };
}

/**
 * Backward-compatible wrapper returning live My Clippings.txt from a connected MTP Kindle.
 */
export async function readMtpKindleClippings(): Promise<MtpAttemptOutcome> {
	const outcome = await readMtpKindleSources();
	return {
		result: outcome.clippings,
		warning: outcome.warning,
	};
}
