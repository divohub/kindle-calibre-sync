import {
	App,
	EditorPosition,
	FileSystemAdapter,
	MarkdownView,
	Modal,
	Notice,
	OpenViewState,
	PaneType,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	TFile,
	Workspace,
	WorkspaceLeaf,
} from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { detectCalibreLibraryPath } from "./sync/calibreDb";
import { isKindleHtmlExport } from "./sync/kindleHtmlParser";
import {
	describeDetectedSyncSources,
	detectSyncSourcesAsync,
	saveKsdkDbCache,
	type DetectedSyncSources,
} from "./sync/ksdkDbReader";
import { resolveHighlightsFolder } from "./sync/obsidianExporter";
import {
	buildBooksIndexFromCalibre,
	prepareBookEpubForViewer,
	runNativeSync,
	type PreparedBookEpubResult,
} from "./sync/syncService";
import type {
	BooksIndex,
	HighlightEntry,
	KindleCalibreSettings,
	StoredPluginData,
} from "./types";
import { KindleEpubView, VIEW_TYPE_KINDLE_EPUB } from "./view";

interface ElectronModule {
	shell?: {
		openExternal?: (url: string, options?: unknown) => Promise<void>;
	};
}

interface WindowWithRequire extends Window {
	require?: (moduleId: string) => ElectronModule;
}

interface EditorWithMouse {
	posAtMouse?: (evt: MouseEvent) => EditorPosition | null;
	getCursor: () => EditorPosition;
	getLine: (line: number) => string;
}

interface SyncSourceBundle {
	clippingsSource: { path: string; content?: string } | null;
	ksdkDb: { path: string; data: Uint8Array } | null;
	htmlSources?: Array<{ path: string; content?: string }>;
	extraKfxDirs: string[];
	label: string;
}

interface PickedFilesOutcome {
	clippingsSource: { path: string; content: string } | null;
	ksdkDb: { path: string; data: Uint8Array } | null;
	htmlSources: Array<{ path: string; content: string }>;
	rememberClippingsPath?: string;
	rememberKsdkPath?: string;
	rememberHtmlPath?: string;
	ignoredHtmlCount: number;
}

async function readPickedSyncFiles(files: FileList, vaultBasePath?: string): Promise<PickedFilesOutcome> {
	let clippingsSource: { path: string; content: string } | null = null;
	let ksdkDb: { path: string; data: Uint8Array } | null = null;
	const htmlSources: Array<{ path: string; content: string }> = [];
	const htmlFsDirs = new Set<string>();
	let singleHtmlFsPath = "";
	let rememberClippingsPath: string | undefined;
	let rememberKsdkPath: string | undefined;
	let ignoredHtmlCount = 0;

	for (const file of Array.from(files)) {
		const lower = file.name.toLowerCase();
		const maybePath = (file as { path?: unknown }).path;
		const fsPath = typeof maybePath === "string" ? maybePath : "";
		const pickedPath = fsPath || file.name;

		if (lower.endsWith(".db")) {
			const buf = await file.arrayBuffer();
			const data = new Uint8Array(buf);
			await saveKsdkDbCache(data, vaultBasePath);
			ksdkDb = { path: pickedPath, data };
			if (fsPath && fs.existsSync(fsPath)) {
				rememberKsdkPath = fsPath;
			}
		} else if (lower.endsWith(".html") || lower.endsWith(".htm")) {
			const content = await file.text();
			if (isKindleHtmlExport(content)) {
				htmlSources.push({ path: pickedPath, content });
				if (fsPath && fs.existsSync(fsPath)) {
					singleHtmlFsPath = fsPath;
					htmlFsDirs.add(path.dirname(fsPath));
				}
			} else {
				ignoredHtmlCount++;
			}
		} else {
			const content = await file.text();
			clippingsSource = { path: pickedPath, content };
			if (fsPath && fs.existsSync(fsPath)) {
				rememberClippingsPath = fsPath;
			}
		}
	}

	let rememberHtmlPath: string | undefined;
	if (htmlSources.length > 1 && htmlFsDirs.size === 1) {
		rememberHtmlPath = Array.from(htmlFsDirs)[0];
	} else if (htmlSources.length === 1 && singleHtmlFsPath) {
		rememberHtmlPath = singleHtmlFsPath;
	}

	return {
		clippingsSource,
		ksdkDb,
		htmlSources,
		rememberClippingsPath,
		rememberKsdkPath,
		rememberHtmlPath,
		ignoredHtmlCount,
	};
}

const DEFAULT_SETTINGS: KindleCalibreSettings = {
	calibreLibraryPath: "",
	highlightsFolder: "",
	clippingsPath: "",
	ksdkDbPath: "",
	kindleHtmlPath: "",
	injectCalibreAnnotations: true,
	autoOpenReader: true,
	calibreLibraryId: "Calibre_Library",
};

const CALIBRE_LINK_RE = /(calibre:\/\/view-book\/[^\s)"'>]+|kindle-read:\/\/[^\s)"'>]+)/;

function isCalibreBookLink(url: string): boolean {
	return url.startsWith("calibre://view-book/") || url.startsWith("kindle-read://");
}

class ClippingsPickerModal extends Modal {
	private readonly onSelect: (
		bundle: SyncSourceBundle,
		rememberClippingsPath?: string,
		rememberKsdkPath?: string,
		rememberHtmlPath?: string
	) => void;
	private readonly onRetryUsb: () => Promise<DetectedSyncSources>;
	private readonly initialResult: DetectedSyncSources;
	private readonly vaultBasePath?: string;
	private readonly htmlOnly: boolean;

	constructor(
		app: App,
		onRetryUsb: () => Promise<DetectedSyncSources>,
		onSelect: (
			bundle: SyncSourceBundle,
			rememberClippingsPath?: string,
			rememberKsdkPath?: string,
			rememberHtmlPath?: string
		) => void,
		initialResult: DetectedSyncSources,
		vaultBasePath?: string,
		htmlOnly = false
	) {
		super(app);
		this.onRetryUsb = onRetryUsb;
		this.onSelect = onSelect;
		this.initialResult = initialResult;
		this.vaultBasePath = vaultBasePath;
		this.htmlOnly = htmlOnly;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", {
			text: this.htmlOnly ? "Import Kindle Notebook export (.html)" : "Kindle device not detected",
		});
		const descEl = contentEl.createEl("p", {
			cls: "kindle-modal-desc",
			text: this.htmlOnly
				? "Select one or more .html files exported from Kindle for Mac / PC (Notebook -> Export)."
				: this.initialResult.mtpWarning ||
					"Connect your Kindle via USB/MTP, unlock its screen, or choose a local My Clippings.txt, ksdk_annotation_v1.db, or Kindle HTML export file.",
		});

		const fileInput = contentEl.createEl("input", {
			cls: "kindle-hidden-file-input",
			attr: {
				type: "file",
				accept: this.htmlOnly ? ".html,.htm,text/html" : ".txt,.db,.html,.htm,text/plain,text/html",
				multiple: "true",
			},
		});

		fileInput.addEventListener("change", () => {
			const files = fileInput.files;
			if (!files || files.length === 0) return;

			void readPickedSyncFiles(files, this.vaultBasePath).then((picked) => {
				if (picked.ignoredHtmlCount > 0 && !picked.clippingsSource && !picked.ksdkDb && picked.htmlSources.length === 0) {
					new Notice("Selected HTML file is not a valid Kindle Notebook export.", 6000);
					return;
				}
				if (!picked.clippingsSource && !picked.ksdkDb && picked.htmlSources.length === 0) {
					return;
				}

				const clip = picked.clippingsSource || (this.htmlOnly ? null : this.initialResult.fallbackClippingsSource);
				const db = picked.ksdkDb || (this.htmlOnly ? null : this.initialResult.fallbackKsdkDb);
				const htmls = picked.htmlSources.length > 0
					? picked.htmlSources
					: this.htmlOnly
						? []
						: this.initialResult.fallbackHtmlSources;

				const labelParts: string[] = [];
				if (picked.clippingsSource) labelParts.push("selected My Clippings.txt");
				else if (clip) labelParts.push("My Clippings.txt");
				if (picked.ksdkDb) labelParts.push("selected ksdk_annotation_v1.db");
				else if (db) labelParts.push("cached ksdk_annotation_v1.db");
				if (htmls.length > 0) labelParts.push(`${htmls.length} HTML export(s)`);

				this.close();
				this.onSelect(
					{
						clippingsSource: clip,
						ksdkDb: db,
						htmlSources: htmls,
						extraKfxDirs: [],
						label: labelParts.join(" + "),
					},
					picked.rememberClippingsPath,
					picked.rememberKsdkPath,
					picked.rememberHtmlPath
				);
			});
		});

		const actions = contentEl.createDiv({ cls: "kindle-modal-actions" });

		if (!this.htmlOnly) {
			const retryBtn = actions.createEl("button", { text: "Retry Kindle detection" });
			retryBtn.addEventListener("click", () => {
				retryBtn.disabled = true;
				retryBtn.textContent = "Checking...";
				void this.onRetryUsb()
					.then((result) => {
						if (result.clippingsSource || result.ksdkDb || result.htmlSources.length > 0) {
							this.close();
							this.onSelect({
								clippingsSource: result.clippingsSource,
								ksdkDb: result.ksdkDb,
								htmlSources: result.htmlSources,
								extraKfxDirs: result.extraKfxDirs,
								label: describeDetectedSyncSources(result),
							});
							return;
						}
						if (result.mtpWarning) {
							descEl.textContent = result.mtpWarning;
							new Notice(result.mtpWarning, 6000);
						} else {
							new Notice(
								"Still no Kindle device found. Unlock Kindle screen, check USB cable, or pick local .txt / .db / .html files."
							);
						}
					})
					.catch((err) => {
						new Notice(`Detection error: ${err instanceof Error ? err.message : String(err)}`);
					})
					.finally(() => {
						retryBtn.disabled = false;
						retryBtn.textContent = "Retry Kindle detection";
					});
			});

			if (
				this.initialResult.fallbackClippingsSource ||
				this.initialResult.fallbackKsdkDb ||
				this.initialResult.fallbackHtmlSources.length > 0
			) {
				const fallbackBtn = actions.createEl("button", {
					text: "Use local/cached files",
				});
				fallbackBtn.addEventListener("click", () => {
					const parts: string[] = [];
					if (this.initialResult.fallbackClippingsSource) parts.push("My Clippings.txt");
					if (this.initialResult.fallbackKsdkDb) {
						parts.push(
							this.initialResult.fallbackKsdkDb.fromCache
								? "cached ksdk_annotation_v1.db"
								: "ksdk_annotation_v1.db"
						);
					}
					if (this.initialResult.fallbackHtmlSources.length > 0) {
						parts.push(`${this.initialResult.fallbackHtmlSources.length} HTML export(s)`);
					}
					this.close();
					this.onSelect({
						clippingsSource: this.initialResult.fallbackClippingsSource,
						ksdkDb: this.initialResult.fallbackKsdkDb,
						htmlSources: this.initialResult.fallbackHtmlSources,
						extraKfxDirs: [],
						label: `local fallback (${parts.join(" + ")})`,
					});
				});
			}
		}

		const pickBtn = actions.createEl("button", {
			cls: "mod-cta",
			text: this.htmlOnly ? "Choose .html file(s)..." : "Choose .txt / .db / .html...",
		});
		pickBtn.addEventListener("click", () => {
			fileInput.click();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export default class KindleCalibrePlugin extends Plugin {
	settings: KindleCalibreSettings = { ...DEFAULT_SETTINGS };
	booksIndex: BooksIndex = {};
	private syncInProgress = false;
	private detectingSource = false;
	private preparingBooks = new Map<string, Promise<PreparedBookEpubResult | null>>();
	private origOpenLinkText: Workspace["openLinkText"] | null = null;
	private origOpenExternal: ((url: string, options?: unknown) => Promise<void>) | null = null;
	private origWindowOpen: typeof window.open | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// 1. Register Side-by-Side EPUB View
		this.registerView(
			VIEW_TYPE_KINDLE_EPUB,
			(leaf: WorkspaceLeaf) => new KindleEpubView(leaf)
		);

		// 2. Add Ribbon Icon
		this.addRibbonIcon("book-open", "Sync Kindle highlights with Calibre", () => {
			void this.runSync();
		});

		// 3. Register Commands
		this.addCommand({
			id: "sync-now",
			name: "Sync highlights with Calibre",
			callback: () => {
				void this.runSync();
			},
		});

		this.addCommand({
			id: "open-reader",
			name: "Open book reader side-by-side",
			callback: () => {
				void this.openReaderLeaf();
			},
		});

		this.addCommand({
			id: "import-kindle-html",
			name: "Import Kindle Desktop / App export (.html)",
			callback: () => {
				void this.runHtmlImport();
			},
		});

		// 4. Intercept Obsidian's 'open-url' event (fired right before OS external viewer is launched)
		this.registerDomEvent(
			window,
			"open-url" as keyof WindowEventMap,
			(evt: Event) => {
				if (!this.settings.autoOpenReader) return;
				const url = (evt as CustomEvent<{ url?: string }>).detail?.url;
				if (typeof url === "string" && isCalibreBookLink(url)) {
					evt.preventDefault();
					void this.handleCalibreLink(url);
				}
			}
		);

		// 5. Intercept clicks in capture phase so OS/external viewer is NEVER launched
		this.registerDomEvent(
			window,
			"click",
			(evt: MouseEvent) => {
				if (!this.settings.autoOpenReader) return;
				const target = evt.target as HTMLElement | null;
				if (!target) return;

				let linkUrl = "";

				const a = target.closest("a");
				const dataHrefEl = target.closest("[data-href]") as HTMLElement | null;
				const href = a?.getAttribute("href") || a?.dataset?.href || dataHrefEl?.dataset?.href;
				if (href && isCalibreBookLink(href)) {
					linkUrl = href;
				}

				if (!linkUrl) {
					const cmLink = target.closest(".cm-link, .cm-underline, .cm-url, .external-link");
					if (cmLink) {
						try {
							const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
							const editor = mdView?.editor as unknown as EditorWithMouse | undefined;
							if (editor) {
								const pos = editor.posAtMouse ? editor.posAtMouse(evt) : editor.getCursor();
								if (pos) {
									const lineText = editor.getLine(pos.line) || "";
									const m = lineText.match(CALIBRE_LINK_RE);
									if (m) {
										linkUrl = m[1];
									}
								}
							}
						} catch {
							/* fallback to DOM line text inspection below */
						}

						if (!linkUrl) {
							const lineEl = target.closest(".cm-line");
							const text = lineEl?.textContent || cmLink.parentElement?.textContent || "";
							const m = text.match(CALIBRE_LINK_RE);
							if (m) {
								linkUrl = m[1];
							}
						}
					}
				}

				if (linkUrl) {
					evt.preventDefault();
					evt.stopPropagation();
					evt.stopImmediatePropagation();
					void this.handleCalibreLink(linkUrl);
				}
			},
			true
		);

		// 6. Intercept Electron's shell.openExternal (prevents OS from opening calibre-viewer)
		try {
			const win = window as WindowWithRequire;
			const electron = win.require ? win.require("electron") : null;
			if (electron?.shell?.openExternal) {
				this.origOpenExternal = electron.shell.openExternal.bind(electron.shell);
				electron.shell.openExternal = async (url: string, options?: unknown) => {
					if (this.settings.autoOpenReader && typeof url === "string" && isCalibreBookLink(url)) {
						await this.handleCalibreLink(url);
						return;
					}
					if (this.origOpenExternal) {
						return this.origOpenExternal(url, options);
					}
				};
			}
		} catch (err) {
			console.warn("Could not patch electron.shell.openExternal", err);
		}

		// 7. Intercept window.open
		this.origWindowOpen = window.open.bind(window);
		window.open = (url?: string | URL, target?: string, features?: string) => {
			const urlStr = url ? url.toString() : "";
			if (this.settings.autoOpenReader && isCalibreBookLink(urlStr)) {
				void this.handleCalibreLink(urlStr);
				return null;
			}
			return this.origWindowOpen ? this.origWindowOpen(url, target, features) : null;
		};

		// 8. Monkey-patch app.workspace.openLinkText for Live Preview / internal dispatch
		this.origOpenLinkText = this.app.workspace.openLinkText.bind(this.app.workspace);
		this.app.workspace.openLinkText = async (
			linktext: string,
			sourcePath: string,
			newLeaf?: boolean | PaneType,
			openViewState?: OpenViewState
		) => {
			if (this.settings.autoOpenReader && isCalibreBookLink(linktext)) {
				await this.handleCalibreLink(linktext);
				return;
			}
			if (this.origOpenLinkText) {
				return this.origOpenLinkText(linktext, sourcePath, newLeaf, openViewState);
			}
		};

		// 9. Settings Tab
		this.addSettingTab(new KindleCalibreSettingTab(this.app, this));
	}

	onunload(): void {
		if (this.origOpenLinkText) {
			this.app.workspace.openLinkText = this.origOpenLinkText;
		}
		if (this.origWindowOpen) {
			window.open = this.origWindowOpen;
		}
		try {
			const win = window as WindowWithRequire;
			const electron = win.require ? win.require("electron") : null;
			if (this.origOpenExternal && electron?.shell) {
				electron.shell.openExternal = this.origOpenExternal;
			}
		} catch {
			/* ignore if electron shell is unavailable during unload */
		}
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as (StoredPluginData & Partial<KindleCalibreSettings>) | null;
		if (!raw) {
			this.settings = { ...DEFAULT_SETTINGS };
			this.booksIndex = {};
			return;
		}

		if (raw.settings && typeof raw.settings === "object") {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings);
			this.booksIndex = raw.booksIndex ?? {};
		} else {
			// Migrate flat data.json from v1.0.x seamlessly
			this.settings = Object.assign({}, DEFAULT_SETTINGS, {
				calibreLibraryPath: typeof raw.calibreLibraryPath === "string" ? raw.calibreLibraryPath : "",
				autoOpenReader: typeof raw.autoOpenReader === "boolean" ? raw.autoOpenReader : true,
				scriptPath: typeof raw.scriptPath === "string" ? raw.scriptPath : undefined,
			});
			this.booksIndex = {};
		}
	}

	async saveSettings(): Promise<void> {
		const payload: StoredPluginData = {
			settings: this.settings,
			booksIndex: this.booksIndex,
		};
		await this.saveData(payload);
	}

	private getVaultBasePath(): string | undefined {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
	}

	private async ensureBooksIndexLoaded(forceRefresh = false): Promise<void> {
		if (!forceRefresh && Object.keys(this.booksIndex).length > 0) {
			return;
		}
		const { booksIndex } = await buildBooksIndexFromCalibre(this.settings);
		if (booksIndex) {
			this.booksIndex = booksIndex;
			await this.saveSettings();
		}
	}

	async openReaderLeaf(): Promise<WorkspaceLeaf> {
		const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_KINDLE_EPUB);
		if (existingLeaves.length > 0) {
			const leaf = existingLeaves[0];
			void this.app.workspace.revealLeaf(leaf);
			return leaf;
		}

		const leaf = this.app.workspace.getLeaf("split", "vertical");
		await leaf.setViewState({ type: VIEW_TYPE_KINDLE_EPUB, active: true });
		void this.app.workspace.revealLeaf(leaf);
		return leaf;
	}

	private async resolveFallbackEpubPath(bookId: string): Promise<string | null> {
		// 1. Check in-memory / stored booksIndex
		const cachedPath = this.booksIndex[bookId]?.epub_path;
		if (cachedPath && fs.existsSync(cachedPath)) {
			return cachedPath;
		}

		// 2. Refresh index directly from Calibre SQLite (plug-and-play before first sync)
		await this.ensureBooksIndexLoaded(true);
		const refreshedPath = this.booksIndex[bookId]?.epub_path;
		if (refreshedPath && fs.existsSync(refreshedPath)) {
			return refreshedPath;
		}

		// 3. Optional legacy books_index.json if scriptPath was configured previously
		if (this.settings.scriptPath) {
			const indexPath = path.join(path.dirname(this.settings.scriptPath), "books_index.json");
			if (fs.existsSync(indexPath)) {
				try {
					const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as BooksIndex;
					const indexedPath = index[bookId]?.epub_path;
					if (indexedPath && fs.existsSync(indexedPath)) {
						return indexedPath;
					}
				} catch {
					/* ignore malformed legacy books_index.json */
				}
			}
		}

		return null;
	}

	private async prepareBookWithNotice(
		bookId: string,
		openAt: string,
		noteFile: TFile | null
	): Promise<PreparedBookEpubResult | null> {
		const statusNotice = new Notice("Preparing EPUB for reader...", 0);
		const task = (async (): Promise<PreparedBookEpubResult | null> => {
			try {
				const prepared = await prepareBookEpubForViewer({
					app: this.app,
					settings: this.settings,
					bookId,
					openAt,
					noteFile,
					onStatus: (msg) => {
						statusNotice.setMessage(msg);
					},
				});

				if (prepared) {
					this.booksIndex[bookId] = prepared.bookRecord;
					await this.saveSettings();
					this.refreshOpenReaderHighlights();
					statusNotice.hide();

					const hlCount = prepared.bookRecord.highlights?.length ?? 0;
					if (prepared.converted) {
						new Notice(
							`EPUB ready: "${prepared.bookRecord.title}" (${hlCount} highlights indexed).`,
							5000
						);
					} else if (prepared.noteUpdated) {
						new Notice(
							`Updated EPUB links & indexed ${hlCount} highlights for "${prepared.bookRecord.title}".`,
							4000
						);
					}

					if (prepared.dbWarning) {
						new Notice(prepared.dbWarning, 7000);
					}
				}
				return prepared;
			} finally {
				this.preparingBooks.delete(bookId);
				statusNotice.hide();
			}
		})();

		this.preparingBooks.set(bookId, task);
		return task;
	}

	async handleCalibreLink(url: string): Promise<void> {
		try {
			const parsed = new URL(url);
			const pathParts = parsed.pathname.replace(/^\/+/, "").split("/");
			if (pathParts.length < 2) return;

			const bookId = pathParts[1];
			let openAt = parsed.searchParams.get("open_at") || "";
			if (openAt) {
				openAt = decodeURIComponent(openAt);
			}

			let epubPath = "";
			let targetOpenAt = openAt;
			let highlights: HighlightEntry[] | undefined = this.booksIndex[bookId]?.highlights;

			// Fast path: EPUB exists, highlights are indexed, and link already uses an EPUB CFI
			const cachedRec = this.booksIndex[bookId];
			const cachedPath = cachedRec?.epub_path;
			if (
				cachedPath &&
				fs.existsSync(cachedPath) &&
				(cachedRec?.highlights?.length ?? 0) > 0 &&
				!openAt.startsWith("search:")
			) {
				epubPath = cachedPath;
				highlights = cachedRec.highlights;
			} else {
				const existingPrep = this.preparingBooks.get(bookId);
				let prepared: PreparedBookEpubResult | null = null;
				if (existingPrep) {
					const waitNotice = new Notice("Waiting for ongoing EPUB preparation...", 0);
					try {
						prepared = await existingPrep;
					} finally {
						waitNotice.hide();
					}
					if (prepared) {
						epubPath = prepared.epubPath;
						highlights = this.booksIndex[bookId]?.highlights ?? prepared.bookRecord.highlights;
					}
				} else {
					const activeFile = this.app.workspace.getActiveFile();
					prepared = await this.prepareBookWithNotice(
						bookId,
						openAt,
						activeFile instanceof TFile ? activeFile : null
					);
					if (prepared) {
						epubPath = prepared.epubPath;
						highlights = prepared.bookRecord.highlights;
						if (prepared.resolvedOpenAt) {
							targetOpenAt = prepared.resolvedOpenAt;
						}
					}
				}

				if (!epubPath) {
					epubPath = (await this.resolveFallbackEpubPath(bookId)) || "";
					highlights = this.booksIndex[bookId]?.highlights;
				}
			}

			if (!epubPath) {
				new Notice(`Book ID ${bookId} not found in Calibre library or cannot be converted to EPUB.`);
				return;
			}

			const leaf = await this.openReaderLeaf();
			const view = leaf.view as KindleEpubView;
			await view.loadBook(epubPath, targetOpenAt, bookId, this.settings.scriptPath || "", highlights);
		} catch (err) {
			console.error("Kindle Calibre link error:", err);
			new Notice(`Error opening book link: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private refreshOpenReaderHighlights(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_KINDLE_EPUB)) {
			const view = leaf.view;
			if (!(view instanceof KindleEpubView)) continue;
			for (const [bookId, rec] of Object.entries(this.booksIndex)) {
				if (rec?.highlights) {
					view.updateBookHighlights(bookId, rec.highlights);
				}
			}
		}
	}

	private openSourcePickerModal(
		detection: DetectedSyncSources,
		vaultBasePath: string | undefined,
		htmlOnly: boolean
	): void {
		const modal = new ClippingsPickerModal(
			this.app,
			() =>
				detectSyncSourcesAsync({
					clippingsPath: this.settings.clippingsPath,
					ksdkDbPath: this.settings.ksdkDbPath,
					kindleHtmlPath: this.settings.kindleHtmlPath,
					vaultBasePath,
				}),
			(bundle, rememberClipPath, rememberKsdkPath, rememberHtmlPath) => {
				let changed = false;
				if (rememberClipPath && !this.settings.clippingsPath) {
					this.settings.clippingsPath = rememberClipPath;
					changed = true;
				}
				if (rememberKsdkPath && !this.settings.ksdkDbPath) {
					this.settings.ksdkDbPath = rememberKsdkPath;
					changed = true;
				}
				if (rememberHtmlPath && !this.settings.kindleHtmlPath) {
					this.settings.kindleHtmlPath = rememberHtmlPath;
					changed = true;
				}
				if (changed) {
					void this.saveSettings();
				}
				void this.executeSyncWithSource(bundle);
			},
			detection,
			vaultBasePath,
			htmlOnly
		);
		modal.open();
	}

	async runHtmlImport(): Promise<void> {
		if (this.syncInProgress || this.detectingSource) {
			new Notice("Kindle sync is already running.");
			return;
		}
		const vaultBasePath = this.getVaultBasePath();
		const emptyDetection: DetectedSyncSources = {
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
		this.openSourcePickerModal(emptyDetection, vaultBasePath, true);
	}

	async runSync(): Promise<void> {
		if (this.syncInProgress || this.detectingSource) {
			new Notice("Kindle sync is already running.");
			return;
		}

		const vaultBasePath = this.getVaultBasePath();
		this.detectingSource = true;
		const detectNotice = new Notice("Checking connected Kindle (USB/MTP)...", 0);
		let detection: DetectedSyncSources;
		try {
			detection = await detectSyncSourcesAsync({
				clippingsPath: this.settings.clippingsPath,
				ksdkDbPath: this.settings.ksdkDbPath,
				kindleHtmlPath: this.settings.kindleHtmlPath,
				vaultBasePath,
			});
		} finally {
			detectNotice.hide();
			this.detectingSource = false;
		}

		if (detection.clippingsSource || detection.ksdkDb || detection.htmlSources.length > 0) {
			await this.executeSyncWithSource({
				clippingsSource: detection.clippingsSource,
				ksdkDb: detection.ksdkDb,
				htmlSources: detection.htmlSources,
				extraKfxDirs: detection.extraKfxDirs,
				label: describeDetectedSyncSources(detection),
			});
			return;
		}

		this.openSourcePickerModal(detection, vaultBasePath, false);
	}

	private async executeSyncWithSource(bundle: SyncSourceBundle): Promise<void> {
		this.syncInProgress = true;
		const sourceLabel = bundle.label || "My Clippings.txt";
		const statusNotice = new Notice(
			`Kindle (${sourceLabel}): scanning highlights and matching Calibre books...`,
			0
		);

		try {
			const result = await runNativeSync({
				app: this.app,
				settings: this.settings,
				clippingsSource: bundle.clippingsSource,
				ksdkDb: bundle.ksdkDb,
				htmlSources: bundle.htmlSources,
				extraKfxDirs: bundle.extraKfxDirs,
				autoConvertToEpub: true,
				onProgress: (msg) => {
					statusNotice.setMessage(msg);
				},
			});

			if (result.booksIndex) {
				this.booksIndex = result.booksIndex;
			}
			await this.saveSettings();
			this.refreshOpenReaderHighlights();

			const { summary } = result;
			statusNotice.hide();

			const convPart =
				summary.epubsConverted && summary.epubsConverted > 0
					? `, ${summary.epubsConverted} converted to EPUB`
					: "";
			const msg =
				`Sync complete (${sourceLabel}): ${summary.totalBooks} books (${summary.matchedBooks} in Calibre${convPart}, ` +
				`${summary.cfiFound} CFIs, ${summary.notesUpdated} updates in "${summary.highlightsFolder}").`;
			new Notice(msg, 6000);

			if (summary.epubConversionWarnings?.length) {
				new Notice(
					`EPUB conversion warnings: ${summary.epubConversionWarnings.slice(0, 3).join("; ")}`,
					8000
				);
			}

			if (summary.calibreWarning) {
				new Notice(summary.calibreWarning, 7000);
			}
		} catch (err) {
			statusNotice.hide();
			console.error("Kindle native sync failed:", err);
			new Notice(`Kindle sync failed: ${err instanceof Error ? err.message : String(err)}`, 7000);
		} finally {
			this.syncInProgress = false;
		}
	}
}

class KindleCalibreSettingTab extends PluginSettingTab {
	plugin: KindleCalibrePlugin;

	constructor(app: App, plugin: KindleCalibrePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Calibre library path",
				desc: "Leave blank to auto-detect from Calibre config or ~/Calibre Library",
				control: {
					type: "text",
					key: "calibreLibraryPath",
					defaultValue: DEFAULT_SETTINGS.calibreLibraryPath,
				},
			},
			{
				name: "Highlights folder",
				desc: "Vault folder for synced book notes (leave blank to auto-detect or use Kindle Highlights)",
				control: {
					type: "text",
					key: "highlightsFolder",
					defaultValue: DEFAULT_SETTINGS.highlightsFolder,
				},
			},
			{
				name: "Legacy clippings file path",
				desc: "Optional My Clippings.txt path when no Kindle USB drive is connected",
				control: {
					type: "text",
					key: "clippingsPath",
					defaultValue: DEFAULT_SETTINGS.clippingsPath,
				},
			},
			{
				name: "Kindle annotation DB path (ksdk_annotation_v1.db)",
				desc: "Optional offline ksdk_annotation_v1.db path (auto-detected via Kindle MTP/USB and cached locally)",
				control: {
					type: "text",
					key: "ksdkDbPath",
					defaultValue: DEFAULT_SETTINGS.ksdkDbPath,
				},
			},
			{
				name: "Kindle Notebook HTML path or folder",
				desc: "Optional .html file or folder of Notebook -> Export files from Kindle for Mac/PC",
				control: {
					type: "text",
					key: "kindleHtmlPath",
					defaultValue: DEFAULT_SETTINGS.kindleHtmlPath,
				},
			},
			{
				name: "Inject highlights into Calibre",
				desc: "Write matched Kindle highlights and notes directly into Calibre metadata.db",
				control: {
					type: "toggle",
					key: "injectCalibreAnnotations",
					defaultValue: DEFAULT_SETTINGS.injectCalibreAnnotations,
				},
			},
			{
				name: "Open reader side-by-side",
				desc: "Open embedded EPUB reader next to note when clicking highlight locations",
				control: {
					type: "toggle",
					key: "autoOpenReader",
					defaultValue: DEFAULT_SETTINGS.autoOpenReader,
				},
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof KindleCalibreSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const detectedCalibre = detectCalibreLibraryPath(this.plugin.settings.calibreLibraryPath);
		const detectedFolder = resolveHighlightsFolder(this.app, this.plugin.settings.highlightsFolder);

		new Setting(containerEl)
			.setName("Calibre library path")
			.setDesc("Leave blank to auto-detect from Calibre config or ~/Calibre Library")
			.addText((text) =>
				text
					.setPlaceholder(detectedCalibre ? `Auto: ${detectedCalibre}` : "~/Calibre Library")
					.setValue(this.plugin.settings.calibreLibraryPath)
					.onChange(async (val) => {
						this.plugin.settings.calibreLibraryPath = val.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Highlights folder")
			.setDesc("Vault folder for synced book notes (leave blank to auto-detect existing Kindle notes)")
			.addText((text) =>
				text
					.setPlaceholder(`Auto: ${detectedFolder}`)
					.setValue(this.plugin.settings.highlightsFolder)
					.onChange(async (val) => {
						this.plugin.settings.highlightsFolder = val.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Legacy clippings file path")
			.setDesc("Optional My Clippings.txt path used when Kindle is not connected")
			.addText((text) =>
				text
					.setPlaceholder("Auto-detected from Kindle USB/MTP or ~/My Clippings.txt")
					.setValue(this.plugin.settings.clippingsPath)
					.onChange(async (val) => {
						this.plugin.settings.clippingsPath = val.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Kindle annotation DB path (ksdk_annotation_v1.db)")
			.setDesc("Optional offline ksdk_annotation_v1.db path (auto-detected via Kindle MTP/USB and cached locally)")
			.addText((text) =>
				text
					.setPlaceholder("Auto: Kindle MTP/USB or cached DB")
					.setValue(this.plugin.settings.ksdkDbPath || "")
					.onChange(async (val) => {
						this.plugin.settings.ksdkDbPath = val.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Kindle Notebook HTML path or folder")
			.setDesc("Optional .html file or folder of Notebook -> Export files from Kindle for Mac/PC")
			.addText((text) =>
				text
					.setPlaceholder("Auto: <vault>/Kindle Exports or ~/Documents/Kindle Exports")
					.setValue(this.plugin.settings.kindleHtmlPath || "")
					.onChange(async (val) => {
						this.plugin.settings.kindleHtmlPath = val.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Inject highlights into Calibre")
			.setDesc("Also save highlights and notes directly into Calibre metadata.db")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.injectCalibreAnnotations)
					.onChange(async (val) => {
						this.plugin.settings.injectCalibreAnnotations = val;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Open reader side-by-side")
			.setDesc("Open embedded EPUB reader next to note when clicking highlight locations")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoOpenReader)
					.onChange(async (val) => {
						this.plugin.settings.autoOpenReader = val;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync highlights")
			.setDesc("Run a full Kindle -> Calibre -> vault sync or import Kindle Desktop .html exports")
			.addButton((btn) =>
				btn
					.setButtonText("Import .html...")
					.onClick(() => {
						void this.plugin.runHtmlImport();
					})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Sync now")
					.setCta()
					.onClick(() => {
						void this.plugin.runSync();
					})
			);
	}
}
