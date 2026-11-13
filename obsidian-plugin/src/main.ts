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
	Workspace,
	WorkspaceLeaf,
} from "obsidian";
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { detectCalibreLibraryPath } from "./sync/calibreDb";
import { detectKindleClippingsPath } from "./sync/clippingsParser";
import { resolveHighlightsFolder } from "./sync/obsidianExporter";
import { buildBooksIndexFromCalibre, runNativeSync } from "./sync/syncService";
import type {
	BooksIndex,
	HighlightEntry,
	KindleCalibreSettings,
	StoredPluginData,
} from "./types";
import { KindleEpubView, VIEW_TYPE_KINDLE_EPUB } from "./view";

const execFileAsync = promisify(execFile);

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

interface ClippingsSource {
	path: string;
	content?: string;
}

const DEFAULT_SETTINGS: KindleCalibreSettings = {
	calibreLibraryPath: "",
	highlightsFolder: "",
	clippingsPath: "",
	injectCalibreAnnotations: true,
	autoOpenReader: true,
	calibreLibraryId: "Calibre_Library",
};

const CALIBRE_LINK_RE = /(calibre:\/\/view-book\/[^\s)"'>]+|kindle-read:\/\/[^\s)"'>]+)/;

function isCalibreBookLink(url: string): boolean {
	return url.startsWith("calibre://view-book/") || url.startsWith("kindle-read://");
}

class ClippingsPickerModal extends Modal {
	private readonly onSelect: (source: ClippingsSource, rememberPath?: string) => void;
	private readonly onRetryUsb: () => ClippingsSource | null;

	constructor(
		app: App,
		onRetryUsb: () => ClippingsSource | null,
		onSelect: (source: ClippingsSource, rememberPath?: string) => void
	) {
		super(app);
		this.onRetryUsb = onRetryUsb;
		this.onSelect = onSelect;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "Kindle device not detected" });
		contentEl.createEl("p", {
			cls: "kindle-modal-desc",
			text: "Connect your Kindle via USB (looks for documents/My Clippings.txt), or choose a local My Clippings.txt file.",
		});

		const fileInput = contentEl.createEl("input", {
			cls: "kindle-hidden-file-input",
			attr: { type: "file", accept: ".txt,text/plain" },
		});

		fileInput.addEventListener("change", () => {
			const file = fileInput.files?.[0];
			if (!file) return;

			const maybePath = (file as { path?: unknown }).path;
			const fsPath = typeof maybePath === "string" ? maybePath : "";

			void file.text().then((content) => {
				const pickedPath = fsPath || file.name;
				this.close();
				this.onSelect(
					{ path: pickedPath, content },
					fsPath && fs.existsSync(fsPath) ? fsPath : undefined
				);
			});
		});

		const actions = contentEl.createDiv({ cls: "kindle-modal-actions" });

		const retryBtn = actions.createEl("button", { text: "Retry USB detection" });
		retryBtn.addEventListener("click", () => {
			const detected = this.onRetryUsb();
			if (detected) {
				this.close();
				this.onSelect(detected);
			} else {
				new Notice("Still no Kindle USB drive found. Check USB cable or pick My Clippings.txt manually.");
			}
		});

		const pickBtn = actions.createEl("button", {
			cls: "mod-cta",
			text: "Choose My Clippings.txt...",
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
				const href = a?.getAttribute("href") || a?.dataset?.href;
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

	private async resolveEpubPath(bookId: string): Promise<string | null> {
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
					/* fallback to Calibre directory scan */
				}
			}
		}

		// 4. Direct folder lookup in auto-detected or configured Calibre Library (with optional ebook-convert fallback)
		const libPath = detectCalibreLibraryPath(this.settings.calibreLibraryPath);
		if (libPath && fs.existsSync(libPath)) {
			try {
				const authors = fs.readdirSync(libPath);
				for (const auth of authors) {
					const authDir = path.join(libPath, auth);
					if (!fs.statSync(authDir).isDirectory()) continue;
					const books = fs.readdirSync(authDir);
					for (const bk of books) {
						if (!bk.endsWith(`(${bookId})`)) continue;
						const bkDir = path.join(authDir, bk);
						const files = fs.readdirSync(bkDir);
						const epub = files.find((f) => f.toLowerCase().endsWith(".epub"));
						if (epub) return path.join(bkDir, epub);

						const convertible = files.find((f) => {
							const ext = path.extname(f).toLowerCase();
							return ext === ".fb2" || ext === ".azw3" || ext === ".mobi";
						});
						if (convertible) {
							const srcFile = path.join(bkDir, convertible);
							const dstEpub = path.join(bkDir, `${path.basename(convertible, path.extname(convertible))}.epub`);
							new Notice("EPUB format missing. Converting book with Calibre...");
							try {
								await execFileAsync("ebook-convert", [srcFile, dstEpub]);
								if (fs.existsSync(dstEpub)) return dstEpub;
							} catch (convErr) {
								console.error("Auto ebook-convert failed:", convErr);
							}
						}
					}
				}
			} catch {
				/* ignore inaccessible Calibre directory entries */
			}
		}

		return null;
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

			const epubPath = await this.resolveEpubPath(bookId);
			if (!epubPath) {
				new Notice(`Book ID ${bookId} not found in Calibre library in EPUB format.`);
				return;
			}

			const highlights: HighlightEntry[] | undefined = this.booksIndex[bookId]?.highlights;
			const leaf = await this.openReaderLeaf();
			const view = leaf.view as KindleEpubView;
			await view.loadBook(epubPath, openAt, bookId, this.settings.scriptPath || "", highlights);
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

	async runSync(): Promise<void> {
		if (this.syncInProgress) {
			new Notice("Kindle sync is already running.");
			return;
		}

		const vaultBasePath = this.getVaultBasePath();
		const detected = detectKindleClippingsPath(this.settings.clippingsPath, vaultBasePath);

		if (detected) {
			await this.executeSyncWithSource({ path: detected.path });
			return;
		}

		const modal = new ClippingsPickerModal(
			this.app,
			() => {
				const retry = detectKindleClippingsPath(this.settings.clippingsPath, vaultBasePath);
				return retry ? { path: retry.path } : null;
			},
			(source, rememberPath) => {
				if (rememberPath && !this.settings.clippingsPath) {
					this.settings.clippingsPath = rememberPath;
					void this.saveSettings();
				}
				void this.executeSyncWithSource(source);
			}
		);
		modal.open();
	}

	private async executeSyncWithSource(source: ClippingsSource): Promise<void> {
		this.syncInProgress = true;
		const statusNotice = new Notice("Kindle: scanning highlights and matching Calibre books...", 0);

		try {
			const result = await runNativeSync({
				app: this.app,
				settings: this.settings,
				clippingsSource: source,
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

			const msg =
				`Sync complete: ${summary.totalBooks} books (${summary.matchedBooks} in Calibre, ` +
				`${summary.cfiFound} CFIs, ${summary.notesUpdated} updates in "${summary.highlightsFolder}").`;
			new Notice(msg, 6000);

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
				name: "Fallback clippings file path",
				desc: "Optional My Clippings.txt path when no Kindle USB drive is connected",
				control: {
					type: "text",
					key: "clippingsPath",
					defaultValue: DEFAULT_SETTINGS.clippingsPath,
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
			.setName("Fallback clippings file path")
			.setDesc("Optional My Clippings.txt path used when Kindle USB drive is not connected")
			.addText((text) =>
				text
					.setPlaceholder("Auto-detected from Kindle USB or ~/My Clippings.txt")
					.setValue(this.plugin.settings.clippingsPath)
					.onChange(async (val) => {
						this.plugin.settings.clippingsPath = val.trim();
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
			.setDesc("Run a full Kindle -> Calibre -> vault sync now")
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
