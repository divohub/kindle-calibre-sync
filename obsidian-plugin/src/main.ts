import {
    Plugin,
    WorkspaceLeaf,
    Notice,
    PluginSettingTab,
    App,
    Setting,
    PaneType,
    OpenViewState,
    MarkdownView
} from "obsidian";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { KindleEpubView, VIEW_TYPE_KINDLE_EPUB } from "./view";

interface KindleCalibreSettings {
    pythonPath: string;
    scriptPath: string;
    calibreLibraryPath: string;
    autoOpenReader: boolean;
}

const DEFAULT_SETTINGS: KindleCalibreSettings = {
    pythonPath: "python3",
    scriptPath: "/home/divo/Work/kindle-calibre-sync/kindle_sync.py",
    calibreLibraryPath: "/home/divo/Calibre Library",
    autoOpenReader: true,
};

export default class KindleCalibrePlugin extends Plugin {
    settings: KindleCalibreSettings = DEFAULT_SETTINGS;
    private origOpenLinkText: any = null;
    private origOpenExternal: any = null;
    private origWindowOpen: any = null;

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
            window as any,
            "open-url",
            (evt: CustomEvent) => {
                const url = evt.detail?.url;
                if (typeof url === "string" && (url.startsWith("calibre://view-book/") || url.startsWith("kindle-read://"))) {
                    evt.preventDefault();
                    this.handleCalibreLink(url);
                }
            }
        );

        // 5. Intercept clicks in capture phase so OS/external viewer is NEVER launched
        this.registerDomEvent(
            window,
            "click",
            (evt: MouseEvent) => {
                const target = evt.target as HTMLElement;
                if (!target) return;

                let linkUrl = "";

                // 1. Direct anchor tag (Reading View or rendered markdown)
                const a = target.closest("a");
                const href = a?.getAttribute("href") || (a as any)?.dataset?.href;
                if (href && (href.startsWith("calibre://view-book/") || href.startsWith("kindle-read://"))) {
                    linkUrl = href;
                }

                // 2. Live preview / CodeMirror link element
                if (!linkUrl) {
                    const cmLink = target.closest(".cm-link, .cm-underline, .cm-url, .external-link");
                    if (cmLink) {
                        try {
                            const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
                            const editor = mdView?.editor;
                            if (editor) {
                                // @ts-ignore
                                const pos = editor.posAtMouse ? (editor as any).posAtMouse(evt) : editor.getCursor();
                                if (pos) {
                                    const lineText = editor.getLine(pos.line) || "";
                                    const m = lineText.match(/(calibre:\/\/view-book\/[^\s\)\"\'\>]+|kindle-read:\/\/[^\s\)\"\'\>]+)/);
                                    if (m) {
                                        linkUrl = m[1];
                                    }
                                }
                            }
                        } catch (e) {}

                        if (!linkUrl) {
                            const lineEl = target.closest(".cm-line");
                            const text = lineEl?.textContent || cmLink.parentElement?.textContent || "";
                            const m = text.match(/(calibre:\/\/view-book\/[^\s\)\"\'\>]+|kindle-read:\/\/[^\s\)\"\'\>]+)/);
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
                    this.handleCalibreLink(linkUrl);
                }
            },
            true // Capture phase: runs before CodeMirror and Obsidian external link handlers!
        );

        // 5. Intercept Electron's shell.openExternal (prevents OS from opening calibre-viewer!)
        try {
            // @ts-ignore
            const electron = (window as any).require ? (window as any).require("electron") : null;
            if (electron?.shell?.openExternal) {
                this.origOpenExternal = electron.shell.openExternal.bind(electron.shell);
                electron.shell.openExternal = async (url: string, options?: any) => {
                    if (typeof url === "string" && (url.startsWith("calibre://view-book/") || url.startsWith("kindle-read://"))) {
                        await this.handleCalibreLink(url);
                        return;
                    }
                    return this.origOpenExternal(url, options);
                };
            }
        } catch (e) {
            console.warn("Could not patch electron.shell.openExternal", e);
        }

        // 6. Intercept window.open
        this.origWindowOpen = window.open;
        window.open = (url?: string | URL, target?: string, features?: string) => {
            const urlStr = url ? url.toString() : "";
            if (urlStr.startsWith("calibre://view-book/") || urlStr.startsWith("kindle-read://")) {
                this.handleCalibreLink(urlStr);
                return null;
            }
            return this.origWindowOpen.call(window, url, target, features);
        };

        // 7. Monkey-patch app.workspace.openLinkText for Live Preview / internal dispatch
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
            return this.origOpenLinkText(linktext, sourcePath, newLeaf, openViewState);
        };

        // 8. Settings Tab
        this.addSettingTab(new KindleCalibreSettingTab(this.app, this));
    }

    async onunload(): Promise<void> {
        if (this.origOpenLinkText) {
            this.app.workspace.openLinkText = this.origOpenLinkText;
        }
        if (this.origWindowOpen) {
            window.open = this.origWindowOpen;
        }
        try {
            // @ts-ignore
            const electron = (window as any).require ? (window as any).require("electron") : null;
            if (this.origOpenExternal && electron?.shell) {
                electron.shell.openExternal = this.origOpenExternal;
            }
        } catch (e) {}
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_KINDLE_EPUB);
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    async openReaderLeaf(): Promise<WorkspaceLeaf> {
        // Reuse existing reader leaf if already open
        const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_KINDLE_EPUB);
        if (existingLeaves.length > 0) {
            const leaf = existingLeaves[0];
            this.app.workspace.revealLeaf(leaf);
            return leaf;
        }

        // Otherwise split vertically next to active note
        const leaf = this.app.workspace.getLeaf("split", "vertical");
        await leaf.setViewState({ type: VIEW_TYPE_KINDLE_EPUB, active: true });
        this.app.workspace.revealLeaf(leaf);
        return leaf;
    }

    private resolveEpubPath(bookId: string): string | null {
        // 1. Check books_index.json
        const syncDir = path.dirname(this.settings.scriptPath);
        const indexPath = path.join(syncDir, "books_index.json");

        if (fs.existsSync(indexPath)) {
            try {
                const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
                if (index[bookId]?.epub_path && fs.existsSync(index[bookId].epub_path)) {
                    return index[bookId].epub_path;
                }
            } catch (e) {}
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
                                    const { execFileSync } = require("child_process");
                                    execFileSync("ebook-convert", [srcFile, dstEpub]);
                                    if (fs.existsSync(dstEpub)) return dstEpub;
                                } catch (convErr) {
                                    console.error("Auto ebook-convert failed:", convErr);
                                }
                            }
                        }
                    }
                }
            } catch (e) {}
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
            new Notice("Error opening book link: " + err);
        }
    }

    runSync(): void {
        new Notice("Kindle: starting sync...");

        const proc = spawn(this.settings.pythonPath, [this.settings.scriptPath]);
        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        proc.stderr.on("data", (data) => {
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
