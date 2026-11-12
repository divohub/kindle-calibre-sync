import {
    Plugin,
    Workspace,
    WorkspaceLeaf,
    Notice,
    PluginSettingTab,
    App,
    Setting,
    SettingDefinitionItem,
    PaneType,
    OpenViewState,
    MarkdownView,
    EditorPosition
} from "obsidian";
import { spawn, execFileSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { KindleEpubView, VIEW_TYPE_KINDLE_EPUB } from "./view";

interface KindleCalibreSettings {
    pythonPath: string;
    scriptPath: string;
    calibreLibraryPath: string;
    autoOpenReader: boolean;
}

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

interface BooksIndexEntry {
    epub_path?: string;
}

const DEFAULT_SETTINGS: KindleCalibreSettings = {
    pythonPath: "python3",
    scriptPath: "/home/divo/Work/kindle-calibre-sync/kindle_sync.py",
    calibreLibraryPath: "/home/divo/Calibre Library",
    autoOpenReader: true,
};

const CALIBRE_LINK_RE = /(calibre:\/\/view-book\/[^\s)"'>]+|kindle-read:\/\/[^\s)"'>]+)/;

export default class KindleCalibrePlugin extends Plugin {
    settings: KindleCalibreSettings = DEFAULT_SETTINGS;
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
        this.addRibbonIcon("book-open", "Kindle: Sync with Calibre", () => {
            this.runSync();
        });

        // 3. Register Commands
        this.addCommand({
            id: "sync-now",
            name: "Sync highlights with Calibre",
            callback: () => this.runSync(),
        });

        this.addCommand({
            id: "open-reader",
            name: "Open book reader side-by-side",
            callback: () => this.openReaderLeaf(),
        });

        // 4. Intercept Obsidian's 'open-url' event (fired right before OS external browser/viewer is launched)
        this.registerDomEvent(
            window,
            "open-url" as keyof WindowEventMap,
            (evt: Event) => {
                const url = (evt as CustomEvent<{ url?: string }>).detail?.url;
                if (typeof url === "string" && (url.startsWith("calibre://view-book/") || url.startsWith("kindle-read://"))) {
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
                const target = evt.target as HTMLElement | null;
                if (!target) return;

                let linkUrl = "";

                // Direct anchor tag (Reading View or rendered markdown)
                const a = target.closest("a");
                const href = a?.getAttribute("href") || a?.dataset?.href;
                if (href && (href.startsWith("calibre://view-book/") || href.startsWith("kindle-read://"))) {
                    linkUrl = href;
                }

                // Live preview / CodeMirror link element
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
            true // Capture phase: runs before CodeMirror and Obsidian external link handlers
        );

        // 6. Intercept Electron's shell.openExternal (prevents OS from opening calibre-viewer)
        try {
            const win = window as WindowWithRequire;
            const electron = win.require ? win.require("electron") : null;
            if (electron?.shell?.openExternal) {
                this.origOpenExternal = electron.shell.openExternal.bind(electron.shell);
                electron.shell.openExternal = async (url: string, options?: unknown) => {
                    if (typeof url === "string" && (url.startsWith("calibre://view-book/") || url.startsWith("kindle-read://"))) {
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
            if (urlStr.startsWith("calibre://view-book/") || urlStr.startsWith("kindle-read://")) {
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
            if (linktext.startsWith("calibre://view-book/") || linktext.startsWith("kindle-read://")) {
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
        const stored = (await this.loadData()) as Partial<KindleCalibreSettings> | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, stored ?? {});
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    async openReaderLeaf(): Promise<WorkspaceLeaf> {
        // Reuse existing reader leaf if already open
        const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_KINDLE_EPUB);
        if (existingLeaves.length > 0) {
            const leaf = existingLeaves[0];
            void this.app.workspace.revealLeaf(leaf);
            return leaf;
        }

        // Otherwise split vertically next to active note
        const leaf = this.app.workspace.getLeaf("split", "vertical");
        await leaf.setViewState({ type: VIEW_TYPE_KINDLE_EPUB, active: true });
        void this.app.workspace.revealLeaf(leaf);
        return leaf;
    }

    private resolveEpubPath(bookId: string): string | null {
        // 1. Check books_index.json
        const syncDir = path.dirname(this.settings.scriptPath);
        const indexPath = path.join(syncDir, "books_index.json");

        if (fs.existsSync(indexPath)) {
            try {
                const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as Record<string, BooksIndexEntry>;
                const indexedPath = index[bookId]?.epub_path;
                if (indexedPath && fs.existsSync(indexedPath)) {
                    return indexedPath;
                }
            } catch {
                /* fallback to direct Calibre directory scan */
            }
        }

        // 2. Direct folder lookup in Calibre Library
        const libPath = this.settings.calibreLibraryPath;
        if (fs.existsSync(libPath)) {
            try {
                const authors = fs.readdirSync(libPath);
                for (const auth of authors) {
                    const authDir = path.join(libPath, auth);
                    if (!fs.statSync(authDir).isDirectory()) continue;
                    const books = fs.readdirSync(authDir);
                    for (const bk of books) {
                        if (bk.endsWith(`(${bookId})`)) {
                            const bkDir = path.join(authDir, bk);
                            const files = fs.readdirSync(bkDir);
                            const epub = files.find(f => f.toLowerCase().endsWith(".epub"));
                            if (epub) return path.join(bkDir, epub);

                            // Auto-convert non-EPUB formats (fb2, azw3, mobi) on demand
                            const convertible = files.find(f => {
                                const ext = path.extname(f).toLowerCase();
                                return ext === ".fb2" || ext === ".azw3" || ext === ".mobi";
                            });
                            if (convertible) {
                                const srcFile = path.join(bkDir, convertible);
                                const dstEpub = path.join(bkDir, path.basename(convertible, path.extname(convertible)) + ".epub");
                                new Notice("EPUB format missing. Converting book automatically...");
                                try {
                                    execFileSync("ebook-convert", [srcFile, dstEpub]);
                                    if (fs.existsSync(dstEpub)) return dstEpub;
                                } catch (convErr) {
                                    console.error("Auto ebook-convert failed:", convErr);
                                }
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

            // In calibre://view-book/Calibre_Library/5/EPUB:
            // pathParts[0] = "Calibre_Library", pathParts[1] = "5"
            const bookId = pathParts[1];
            let openAt = parsed.searchParams.get("open_at") || "";
            if (openAt) {
                openAt = decodeURIComponent(openAt);
            }

            const epubPath = this.resolveEpubPath(bookId);
            if (!epubPath) {
                new Notice(`Book ID ${bookId} not found in Calibre library in EPUB format`);
                return;
            }

            const leaf = await this.openReaderLeaf();
            const view = leaf.view as KindleEpubView;
            await view.loadBook(epubPath, openAt, bookId, this.settings.scriptPath);
        } catch (err) {
            console.error("Kindle Calibre link error:", err);
            new Notice("Error opening book link: " + String(err));
        }
    }

    runSync(): void {
        new Notice("Kindle: starting sync...");

        const proc = spawn(this.settings.pythonPath, [this.settings.scriptPath]);
        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on("close", (code) => {
            if (code === 0) {
                new Notice("Kindle: sync complete. Calibre and notes updated.", 5000);
            } else {
                console.error("Kindle sync error:", stderr || stdout);
                new Notice("Kindle sync error. Check developer console.", 6000);
            }
        });
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
                name: "Python executable",
                desc: "System path to python3 binary",
                control: {
                    type: "text",
                    key: "pythonPath",
                    defaultValue: DEFAULT_SETTINGS.pythonPath,
                },
            },
            {
                name: "Sync script path",
                desc: "Absolute path to kindle_sync.py",
                control: {
                    type: "text",
                    key: "scriptPath",
                    defaultValue: DEFAULT_SETTINGS.scriptPath,
                },
            },
            {
                name: "Calibre library path",
                desc: "Path to Calibre Library folder containing metadata.db",
                control: {
                    type: "text",
                    key: "calibreLibraryPath",
                    defaultValue: DEFAULT_SETTINGS.calibreLibraryPath,
                },
            },
            {
                name: "Auto-open reader",
                desc: "Open side-by-side book reader when clicking a highlight location",
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

        new Setting(containerEl)
            .setName("Python executable")
            .setDesc("System path to python3 binary")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.pythonPath)
                    .onChange(async (val) => {
                        this.plugin.settings.pythonPath = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Sync script path")
            .setDesc("Absolute path to kindle_sync.py")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.scriptPath)
                    .onChange(async (val) => {
                        this.plugin.settings.scriptPath = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Calibre library path")
            .setDesc("Path to Calibre Library folder containing metadata.db")
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.calibreLibraryPath)
                    .onChange(async (val) => {
                        this.plugin.settings.calibreLibraryPath = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Auto-open reader")
            .setDesc("Open side-by-side book reader when clicking a highlight location")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoOpenReader)
                    .onChange(async (val) => {
                        this.plugin.settings.autoOpenReader = val;
                        await this.plugin.saveSettings();
                    })
            );
    }
}
