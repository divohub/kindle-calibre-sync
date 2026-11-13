import { ItemView, WorkspaceLeaf, setIcon, Notice } from "obsidian";
import ePub, { Book, Rendition } from "epubjs";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import type { BooksIndexRecord, HighlightEntry } from "./types";

export const VIEW_TYPE_KINDLE_EPUB = "kindle-epub-reader-view";

interface EpubQueue {
    dequeue: () => unknown;
    _patchedSafety?: boolean;
    running?: boolean;
    run: () => void;
}

interface ResolvablePromise {
    resolve: () => void;
}

interface CfiTerminal {
    offset?: number;
}

interface CfiSegment {
    steps: unknown[];
    terminal: CfiTerminal;
}

interface EpubCfiInstance {
    range?: boolean;
    path: CfiSegment;
    start: CfiSegment;
    end: CfiSegment;
    findNode: (steps: unknown[], doc: Document, ignoreClass: string | null) => Node | null;
    toString: () => string;
    toRange: (doc: Document, ignoreClass?: string) => Range | null;
    _patchedToRange?: boolean;
}

interface RenditionAnnotationsInternal {
    inject: (view: EpubViewInstance) => void;
    _patchedInject?: boolean;
}

interface EpubViewsCollection {
    all?: () => EpubViewInstance[];
    _views?: EpubViewInstance[];
}

interface ContentsLike {
    range: (cfi: string) => Range | null;
    addStylesheetCss: (css: string, key: string) => void;
}

interface EpubViewInstance {
    index: number;
    contents?: ContentsLike;
    document?: Document;
    highlights?: Record<string, unknown>;
    pane?: { render: () => void };
    expand?: () => void;
    unhighlight: (cfi: string) => void;
    highlight: (
        cfiRange: string,
        data: Record<string, string>,
        cb: () => void,
        className: string,
        styles: Record<string, string>
    ) => void;
}

interface RenditionInternal {
    q?: EpubQueue;
    displaying?: ResolvablePromise;
    epubcfi?: { constructor?: { prototype?: EpubCfiInstance } };
    annotations?: RenditionAnnotationsInternal;
    views?: () => EpubViewInstance[] | EpubViewsCollection;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
}

interface LocationPayload {
    start?: {
        displayed?: {
            page?: number;
            total?: number;
        };
        percentage?: number;
    };
}

export class KindleEpubView extends ItemView {
    private book: Book | null = null;
    private rendition: Rendition | null = null;
    private currentEpubPath: string = "";
    private currentTitle: string = "E-Book Reader";
    private lastOpenAtCfi: string = "";
    private currentHighlights: HighlightEntry[] = [];
    private currentBookId: string = "";
    private scriptPath: string = "";
    private previousActiveHighlight: HighlightEntry | null = null;

    private headerEl!: HTMLElement;
    private titleSpan!: HTMLElement;
    private viewerEl!: HTMLElement;
    private locSpan!: HTMLElement;
    private fontSize: number = 100;
    private currentTheme: "auto" | "dark" | "light" | "sepia" = "auto";

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return VIEW_TYPE_KINDLE_EPUB;
    }

    getDisplayText(): string {
        return this.currentTitle;
    }

    getIcon(): string {
        return "book-open";
    }

    async onOpen(): Promise<void> {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass("kindle-reader-wrapper");

        // 1. Controls Toolbar
        this.headerEl = container.createDiv({ cls: "kindle-reader-toolbar" });

        // Left section: Title & Location
        const leftBox = this.headerEl.createDiv({ cls: "kindle-toolbar-left" });
        this.titleSpan = leftBox.createSpan({ cls: "kindle-reader-title", text: this.currentTitle });
        this.locSpan = leftBox.createSpan({ cls: "kindle-reader-loc", text: "" });

        // Right section: Navigation & Font controls
        const rightBox = this.headerEl.createDiv({ cls: "kindle-toolbar-right" });

        const prevBtn = rightBox.createEl("button", { cls: "kindle-btn", title: "Previous page" });
        setIcon(prevBtn, "chevron-left");
        prevBtn.onclick = () => {
            void this.rendition?.prev();
        };

        const nextBtn = rightBox.createEl("button", { cls: "kindle-btn", title: "Next page" });
        setIcon(nextBtn, "chevron-right");
        nextBtn.onclick = () => {
            void this.rendition?.next();
        };

        const fontDown = rightBox.createEl("button", { cls: "kindle-btn", title: "Decrease font size", text: "A-" });
        fontDown.onclick = () => this.changeFontSize(-10);

        const fontUp = rightBox.createEl("button", { cls: "kindle-btn", title: "Increase font size", text: "A+" });
        fontUp.onclick = () => this.changeFontSize(10);

        const themeBtn = rightBox.createEl("button", { cls: "kindle-btn", title: "Cycle theme" });
        setIcon(themeBtn, "sun-moon");
        themeBtn.onclick = () => this.cycleTheme();

        const calibreBtn = rightBox.createEl("button", {
            cls: "kindle-btn",
            title: "Open in external Calibre Viewer"
        });
        setIcon(calibreBtn, "external-link");
        calibreBtn.onclick = () => this.openInCalibre();

        const closeBtn = rightBox.createEl("button", { cls: "kindle-btn", title: "Close reader" });
        setIcon(closeBtn, "x");
        closeBtn.onclick = () => this.leaf.detach();

        // 2. Viewer Area
        this.viewerEl = container.createDiv({ cls: "kindle-viewer-container" });

        // Keyboard arrows
        this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
            if (this.containerEl.contains(document.activeElement)) {
                if (e.key === "ArrowLeft") void this.rendition?.prev();
                if (e.key === "ArrowRight") void this.rendition?.next();
            }
        });
    }

    async onClose(): Promise<void> {
        this.destroyCurrentBook();
    }

    private patchRenditionSafety(): void {
        if (!this.rendition) return;
        const renditionInternal = this.rendition as unknown as RenditionInternal;

        // 1. Prevent Queue.run() from ever deadlocking if a task rejects or throws
        const q = renditionInternal.q;
        if (q && typeof q.dequeue === "function" && !q._patchedSafety) {
            const origDequeue = q.dequeue.bind(q);
            q.dequeue = function (): Promise<unknown> {
                try {
                    const p = origDequeue();
                    if (p && typeof (p as PromiseLike<unknown>).then === "function") {
                        return (p as Promise<unknown>).then(
                            (val: unknown) => val,
                            (err: unknown) => {
                                console.warn("ePub.js queue task error caught:", err);
                                return undefined;
                            }
                        );
                    }
                    return Promise.resolve(p);
                } catch (err) {
                    console.warn("ePub.js queue sync error caught:", err);
                    return Promise.resolve();
                }
            };
            q._patchedSafety = true;
        }

        // 2. Ensure displayerror never leaves this.rendition.displaying unresolved
        renditionInternal.on("displayerror", (err: unknown) => {
            console.warn("Rendition displayerror:", err);
            const displaying = renditionInternal.displaying;
            if (displaying && typeof displaying.resolve === "function") {
                try {
                    displaying.resolve();
                } catch {
                    /* ignore promise resolution error */
                }
            }
        });

        // 3. Patch EpubCFI.prototype.toRange to clamp offsets and never throw IndexSizeError
        const cfiProto = renditionInternal.epubcfi?.constructor?.prototype;
        if (cfiProto && typeof cfiProto.toRange === "function" && !cfiProto._patchedToRange) {
            const origToRange = cfiProto.toRange;
            cfiProto.toRange = function (this: EpubCfiInstance, _doc: Document, ignoreClass?: string): Range | null {
                try {
                    return origToRange.call(this, _doc, ignoreClass);
                } catch {
                    try {
                        const doc = _doc || activeDocument;
                        const range = doc.createRange();
                        const needsIgnoring = ignoreClass ? doc.querySelector("." + ignoreClass) != null : false;
                        const ig: string | null = needsIgnoring && ignoreClass ? ignoreClass : null;
                        const clampSet = (isStart: boolean, steps: unknown[], offset: unknown): boolean => {
                            const node = this.findNode(steps, doc, ig);
                            if (!node) return false;
                            const maxLen = node.nodeType === 3 ? (node.textContent?.length ?? 0) : (node.childNodes?.length ?? 0);
                            const safeOff = typeof offset === "number" && !isNaN(offset) ? Math.max(0, Math.min(offset, maxLen)) : 0;
                            if (isStart) range.setStart(node, safeOff);
                            else range.setEnd(node, safeOff);
                            return true;
                        };
                        if (this.range) {
                            const sSteps = this.path.steps.concat(this.start.steps);
                            const eSteps = this.path.steps.concat(this.end.steps);
                            if (!clampSet(true, sSteps, this.start.terminal.offset)) return null;
                            clampSet(false, eSteps, this.end.terminal.offset);
                        } else {
                            if (!clampSet(true, this.path.steps, this.path.terminal.offset)) return null;
                        }
                        return range;
                    } catch (e2) {
                        console.warn("Safe toRange fallback failed for", this.toString(), e2);
                        return null;
                    }
                }
            };
            cfiProto._patchedToRange = true;
        }

        // 4. Disable premature Annotations.inject (which runs in hooks.render BEFORE Themes.inject)
        const annots = renditionInternal.annotations;
        if (annots && !annots._patchedInject) {
            annots.inject = function (): void {
                // Handled by renderHighlightsForActiveViews() after hooks.content (Themes) completes
            };
            annots._patchedInject = true;
        }
    }

    private destroyCurrentBook(): void {
        if (this.rendition) {
            try {
                this.rendition.destroy();
            } catch {
                /* ignore rendition destroy error */
            }
            this.rendition = null;
        }
        if (this.book) {
            try {
                this.book.destroy();
            } catch {
                /* ignore book destroy error */
            }
            this.book = null;
        }
    }

    async loadBook(
        epubPath: string,
        openAt?: string,
        bookId?: string,
        scriptPath?: string,
        preloadedHighlights?: HighlightEntry[]
    ): Promise<void> {
        if (!fs.existsSync(epubPath)) {
            this.titleSpan.setText("Book file not found");
            return;
        }

        this.currentBookId = bookId || "";
        this.scriptPath = scriptPath || "";

        // If same book already loaded, update highlights if provided and navigate
        if (this.currentEpubPath === epubPath && this.rendition) {
            this.loadHighlights(this.currentBookId, preloadedHighlights);
            this.renderHighlightsForActiveViews();
            if (openAt) {
                await this.navigateTo(openAt);
            }
            return;
        }

        this.currentEpubPath = epubPath;
        this.previousActiveHighlight = null;
        this.destroyCurrentBook();
        this.viewerEl.empty();

        this.loadHighlights(this.currentBookId, preloadedHighlights);

        const buffer = fs.readFileSync(epubPath);
        const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

        this.book = ePub(arrayBuffer);

        try {
            const meta = await this.book.loaded.metadata;
            this.currentTitle = meta.title || "Book";
            this.titleSpan.setText(this.currentTitle);
        } catch {
            this.titleSpan.setText("Book");
        }

        this.rendition = this.book.renderTo(this.viewerEl, {
            width: "100%",
            height: "100%",
            flow: "paginated",
            spread: "none"
        });

        this.patchRenditionSafety();
        this.registerThemes();
        this.applyCurrentTheme();

        const renditionEvents = this.rendition as unknown as RenditionInternal;

        // "rendered" fires AFTER hooks.content (Themes.inject) has applied fonts and line-height
        renditionEvents.on("rendered", (_section: unknown, view: unknown) => {
            const epubView = view as EpubViewInstance | undefined;
            try {
                if (epubView && typeof epubView.expand === "function") {
                    epubView.expand();
                }
            } catch {
                /* ignore expand errors during transitional layout */
            }
            this.renderHighlightsForActiveViews();
        });

        renditionEvents.on("relocated", (locArg: unknown) => {
            const location = locArg as LocationPayload | undefined;
            if (location?.start?.displayed?.page) {
                const page = location.start.displayed.page;
                const total = location.start.displayed.total;
                this.locSpan.setText(`Page ${page}/${total}`);
            } else if (location?.start?.percentage) {
                const pct = Math.round(location.start.percentage * 100);
                this.locSpan.setText(`${pct}%`);
            }
        });

        if (openAt) {
            await this.navigateTo(openAt);
        } else {
            await this.rendition.display();
            this.renderHighlightsForActiveViews();
        }
    }

    updateBookHighlights(bookId: string, highlights: HighlightEntry[]): void {
        if (this.currentBookId && this.currentBookId === bookId) {
            this.currentHighlights = highlights;
            this.renderHighlightsForActiveViews();
        }
    }

    private loadHighlights(bookId: string, preloadedHighlights?: HighlightEntry[]): void {
        this.currentHighlights = [];
        if (!bookId) return;

        if (preloadedHighlights !== undefined) {
            this.currentHighlights = preloadedHighlights;
            return;
        }

        if (!this.scriptPath) return;

        const syncDir = path.dirname(this.scriptPath);
        const indexPath = path.join(syncDir, "books_index.json");

        if (fs.existsSync(indexPath)) {
            try {
                const index = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as Record<string, BooksIndexRecord>;
                const highlights = index[bookId]?.highlights;
                if (Array.isArray(highlights)) {
                    this.currentHighlights = highlights;
                }
            } catch (e) {
                console.error("Failed to load highlights from index:", e);
            }
        }
    }

    private getActiveViewsList(): EpubViewInstance[] {
        if (!this.rendition) return [];
        const renditionInternal = this.rendition as unknown as RenditionInternal;
        const viewsObj = renditionInternal.views?.();
        if (!viewsObj) return [];
        if (Array.isArray(viewsObj)) return viewsObj;
        if (typeof viewsObj.all === "function") return viewsObj.all();
        if (Array.isArray(viewsObj._views)) return viewsObj._views;
        return [];
    }

    private renderHighlightsForActiveViews(): void {
        if (!this.rendition) return;
        const viewsList = this.getActiveViewsList();

        for (const view of viewsList) {
            if (!view || !view.contents || !view.document) continue;

            // 1. Clear existing SVG marks on this view so there are never duplicate or orphaned marks
            if (view.highlights) {
                for (const cfi of Object.keys(view.highlights)) {
                    try {
                        view.unhighlight(cfi);
                    } catch {
                        /* ignore stale CFI removal error */
                    }
                }
            }

            if (!this.currentHighlights.length) continue;

            // 2. Render all highlights belonging to this view's spine section
            for (const h of this.currentHighlights) {
                if (!h.range_cfi) continue;
                if (typeof h.spine_index === "number" && h.spine_index !== view.index) {
                    continue;
                }

                try {
                    const rng = view.contents.range(h.range_cfi);
                    if (!rng) continue;

                    const isActive =
                        this.previousActiveHighlight !== null &&
                        (this.previousActiveHighlight.range_cfi === h.range_cfi ||
                            (Boolean(this.previousActiveHighlight.point_cfi) &&
                                this.previousActiveHighlight.point_cfi === h.point_cfi));

                    const className = isActive ? "kindle-active-highlight" : "kindle-highlight";
                    const styles: Record<string, string> = isActive
                        ? {
                              fill: "#ff9800",
                              "fill-opacity": "0.35",
                              stroke: "none",
                              "mix-blend-mode": "normal"
                          }
                        : {
                              fill: "#ffd600",
                              "fill-opacity": "0.22",
                              stroke: "none",
                              "mix-blend-mode": "normal"
                          };

                    view.highlight(
                        h.range_cfi,
                        { text: h.text || "", point_cfi: h.point_cfi || "" },
                        () => undefined,
                        className,
                        styles
                    );
                } catch (e) {
                    console.warn("Error rendering highlight on view:", h.range_cfi, e);
                }
            }

            try {
                view.pane?.render();
            } catch {
                /* ignore pane render error */
            }
        }
    }

    private findMatchingHighlight(openAt: string): HighlightEntry | null {
        if (!openAt || !this.currentHighlights.length) return null;

        // 1. Exact match on point_cfi or range_cfi
        for (const h of this.currentHighlights) {
            if (h.point_cfi === openAt || h.range_cfi === openAt) return h;
        }

        // 2. Normalized digits & colons match
        const clean = (s?: string): string => (s || "").replace(/[^0-9:]/g, "");
        const cleanOpen = clean(openAt);

        for (const h of this.currentHighlights) {
            if (clean(h.point_cfi) === cleanOpen || clean(h.start_cfi) === cleanOpen) return h;
        }

        // 3. Match by parent element prefix + closest character offset in same spine section
        const elemMatch = openAt.match(/^epubcfi\(\/(\d+)(\/2\/4\/.*\/)\d+:(\d+)\)$/);
        if (elemMatch) {
            const spineStep = parseInt(elemMatch[1], 10);
            const spineIdx = spineStep / 2 - 1;
            const elemPrefix = elemMatch[2];
            const targetOffset = parseInt(elemMatch[3], 10);
            let best: HighlightEntry | null = null;
            let bestDiff = Infinity;
            for (const h of this.currentHighlights) {
                if (
                    h.spine_index === spineIdx &&
                    typeof h.start_cfi === "string" &&
                    h.start_cfi.startsWith(elemPrefix)
                ) {
                    const offMatch = h.start_cfi.match(/:(\d+)$/);
                    const hOff = offMatch ? parseInt(offMatch[1], 10) : 0;
                    const diff = Math.abs(hOff - targetOffset);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        best = h;
                    }
                }
            }
            if (best) return best;
        }

        // 4. Substring match
        for (const h of this.currentHighlights) {
            if (cleanOpen && (clean(h.point_cfi).includes(cleanOpen) || clean(h.range_cfi).includes(cleanOpen))) return h;
        }

        return null;
    }

    private registerThemes(): void {
        if (!this.rendition) return;

        this.rendition.themes.register("auto-dark", {
            "body": {
                "color": "#dcddde !important",
                "background": "#202020 !important",
                "font-family": "var(--font-text), sans-serif !important",
                "line-height": "1.6 !important"
            },
            "p": { "color": "#dcddde !important" },
            "a": { "color": "#7b68ee !important" }
        });

        this.rendition.themes.register("auto-light", {
            "body": {
                "color": "#2e3338 !important",
                "background": "#ffffff !important",
                "font-family": "var(--font-text), sans-serif !important",
                "line-height": "1.6 !important"
            },
            "p": { "color": "#2e3338 !important" },
            "a": { "color": "#0066cc !important" }
        });

        this.rendition.themes.register("sepia", {
            "body": {
                "color": "#4a3c31 !important",
                "background": "#fbf0d9 !important",
                "font-family": "var(--font-text), serif !important",
                "line-height": "1.6 !important"
            },
            "p": { "color": "#4a3c31 !important" },
            "a": { "color": "#8b5a2b !important" }
        });

        this.rendition.hooks.content.register((contentsObj: unknown) => {
            const contents = contentsObj as ContentsLike | undefined;
            contents?.addStylesheetCss(`
                svg g.kindle-highlight rect, svg g[ref="kindle-highlight"] rect {
                    fill: #ffd600 !important;
                    fill-opacity: 0.22 !important;
                    stroke: none !important;
                    stroke-width: 0 !important;
                    mix-blend-mode: normal !important;
                    rx: 2px !important;
                    ry: 2px !important;
                }
                svg g.kindle-active-highlight rect, svg g[ref="kindle-active-highlight"] rect {
                    fill: #ff9800 !important;
                    fill-opacity: 0.35 !important;
                    stroke: none !important;
                    stroke-width: 0 !important;
                    mix-blend-mode: normal !important;
                    rx: 2px !important;
                    ry: 2px !important;
                }
            `, "kindle-highlight-styles");
        });
    }

    private applyCurrentTheme(): void {
        if (!this.rendition) return;
        const isDark = activeDocument.body.hasClass("theme-dark");

        if (this.currentTheme === "auto") {
            this.rendition.themes.select(isDark ? "auto-dark" : "auto-light");
        } else if (this.currentTheme === "dark") {
            this.rendition.themes.select("auto-dark");
        } else if (this.currentTheme === "light") {
            this.rendition.themes.select("auto-light");
        } else if (this.currentTheme === "sepia") {
            this.rendition.themes.select("sepia");
        }
        window.setTimeout(() => this.renderHighlightsForActiveViews(), 60);
    }

    private cycleTheme(): void {
        const order: ("auto" | "sepia" | "dark" | "light")[] = ["auto", "sepia", "dark", "light"];
        const nextIdx = (order.indexOf(this.currentTheme) + 1) % order.length;
        this.currentTheme = order[nextIdx];
        this.applyCurrentTheme();
    }

    private changeFontSize(delta: number): void {
        this.fontSize = Math.max(70, Math.min(200, this.fontSize + delta));
        if (this.rendition) {
            this.rendition.themes.fontSize(`${this.fontSize}%`);
            window.setTimeout(() => {
                for (const v of this.getActiveViewsList()) {
                    try {
                        v.expand?.();
                    } catch {
                        /* ignore expand error */
                    }
                }
                this.renderHighlightsForActiveViews();
            }, 60);
        }
    }

    async navigateTo(openAt: string): Promise<void> {
        if (!this.rendition) return;

        this.lastOpenAtCfi = openAt;

        if (openAt.startsWith("search:")) {
            const query = openAt.slice(7);
            try {
                const bookObj = this.book as unknown as { find?: (q: string) => Promise<Array<{ cfi: string }>> } | null;
                const results = await bookObj?.find?.(query);
                if (results && results.length > 0) {
                    const foundCfi = results[0].cfi;
                    this.previousActiveHighlight = { range_cfi: foundCfi, point_cfi: foundCfi, text: query };
                    await this.rendition.display(foundCfi);
                    await new Promise<void>((r) => window.setTimeout(r, 60));
                    await this.rendition.display(foundCfi);
                    this.renderHighlightsForActiveViews();
                }
            } catch (e) {
                console.warn("EPUB search error:", e);
            }
            return;
        }

        const matched = this.findMatchingHighlight(openAt);
        let targetCfi = openAt;

        if (matched && matched.range_cfi) {
            this.previousActiveHighlight = matched;
            targetCfi = matched.range_cfi;
        } else {
            // Convert Calibre-style CFI to standard EPUB CFI for ePub.js
            const m = targetCfi.match(/^epubcfi\(\/(\d+)(.*)\)$/);
            if (m) {
                const spineStep = m[1];
                let docPath = m[2];
                if (docPath.startsWith("/2/4/")) docPath = docPath.slice(2);
                targetCfi = `epubcfi(/6/${spineStep}!${docPath})`;
            }
            this.previousActiveHighlight = { range_cfi: targetCfi, point_cfi: openAt, text: "" };
        }

        // Convert range CFI to point CFI for display (epub.js display() cannot take range CFIs with commas)
        let navCfi = targetCfi;
        const rangeMatch = targetCfi.match(/^epubcfi\((.+?),(.+?),(.+?)\)$/);
        if (rangeMatch) {
            navCfi = `epubcfi(${rangeMatch[1]}${rangeMatch[2]})`;
        }

        // Check if target spine section is already rendered in active views
        const spineMatch = navCfi.match(/\/6\/(\d+)!/);
        const targetSpineIdx = spineMatch ? parseInt(spineMatch[1], 10) / 2 - 1 : -1;
        const wasSectionAlreadyLoaded = this.getActiveViewsList().some((v) => v.index === targetSpineIdx);

        const renditionInternal = this.rendition as unknown as RenditionInternal;

        const safeDisplay = async (cfi?: string): Promise<boolean> => {
            if (!this.rendition) return false;
            try {
                const timeoutPromise = new Promise((_, reject) =>
                    window.setTimeout(() => reject(new Error("Display timeout")), 4000)
                );
                await Promise.race([this.rendition.display(cfi), timeoutPromise]);
                return true;
            } catch (err) {
                console.warn("safeDisplay error for:", cfi, err);
                const displaying = renditionInternal.displaying;
                if (displaying && typeof displaying.resolve === "function") {
                    try {
                        displaying.resolve();
                    } catch {
                        /* ignore displaying promise resolve error */
                    }
                }
                const q = renditionInternal.q;
                if (q && q.running) {
                    q.running = false;
                    try {
                        q.run();
                    } catch {
                        /* ignore queue rerun error */
                    }
                }
                return false;
            }
        };

        let displayed = await safeDisplay(navCfi);

        // Fallback 1: if specific point CFI failed, jump to chapter spine (/6/XX!)
        if (!displayed && navCfi) {
            const spinePart = navCfi.match(/\/6\/(\d+)!/);
            if (spinePart) {
                displayed = await safeDisplay(`epubcfi(/6/${spinePart[1]}!)`);
            }
        }

        // Fallback 2: default view display
        if (!displayed) {
            await safeDisplay();
        }

        // If section was just loaded, wait for Themes.inject (hooks.content) to finish, expand columns, and re-align page
        if (!wasSectionAlreadyLoaded && displayed && navCfi) {
            await new Promise<void>((r) => window.setTimeout(r, 60));
            for (const v of this.getActiveViewsList()) {
                try {
                    v.expand?.();
                } catch {
                    /* ignore expand error */
                }
            }
            await safeDisplay(navCfi);
        }

        this.renderHighlightsForActiveViews();
    }

    openInCalibre(): void {
        if (!this.currentEpubPath) {
            new Notice("Book is not open yet");
            return;
        }
        new Notice("Launching external Calibre Viewer...");
        const args = this.lastOpenAtCfi ? ["--open-at", this.lastOpenAtCfi, this.currentEpubPath] : [this.currentEpubPath];
        spawn("ebook-viewer", args, { detached: true, stdio: "ignore" }).unref();
    }
}
