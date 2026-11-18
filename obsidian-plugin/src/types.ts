export interface KindleCalibreSettings {
	calibreLibraryPath: string;
	highlightsFolder: string;
	clippingsPath: string;
	ksdkDbPath?: string;
	kindleHtmlPath?: string;
	injectCalibreAnnotations: boolean;
	autoOpenReader: boolean;
	calibreLibraryId: string;
	scriptPath?: string;
}

export interface HighlightEntry {
	range_cfi?: string;
	point_cfi?: string;
	start_cfi?: string;
	end_cfi?: string;
	spine_index?: number;
	text?: string;
}

export interface BooksIndexRecord {
	id?: number;
	title?: string;
	authors?: string;
	epub_path?: string;
	highlights?: HighlightEntry[];
}

export type BooksIndex = Record<string, BooksIndexRecord>;

export interface StoredPluginData {
	settings?: Partial<KindleCalibreSettings>;
	booksIndex?: BooksIndex;
}

export type ClippingType = "highlight" | "note" | "bookmark";

export interface Clipping {
	title: string;
	author: string;
	entryType: ClippingType;
	page: number | null;
	locationStart: number;
	locationEnd: number;
	dateStr: string;
	text: string;
	refId: string;
	note?: string;
}

export interface CalibreBook {
	bookId: number;
	title: string;
	authors: string;
	path: string;
	formats: string[];
}

export interface CfiInfo {
	startCfi: string;
	endCfi: string;
	spineIndex: number;
	spineName: string;
	fullCfi: string;
	rangeCfi: string;
}

export interface SyncSummary {
	clippingsPath: string;
	totalBooks: number;
	totalClips: number;
	matchedBooks: number;
	cfiFound: number;
	injectedAnnots: number;
	notesUpdated: number;
	highlightsFolder: string;
	epubsConverted?: number;
	epubConversionWarnings?: string[];
	calibreWarning?: string;
}
