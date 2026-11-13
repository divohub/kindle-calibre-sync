import * as fs from "fs";

const SYSTEM_SYMBOLS = [
	"$ion",
	"$ion_1_0",
	"$ion_symbol_table",
	"name",
	"version",
	"imports",
	"symbols",
	"max_id",
	"$ion_shared_symbol_table",
] as const;

const RAW_FRAGMENT_TYPES = new Set(["$417", "$418"]);
const IGNORED_STRUCT_FIELDS = new Set([
	"$749",
	"$584",
	"$683",
	"$145",
	"$146",
	"$141",
	"$702",
	"$250",
	"$176",
	"yj.dictionary.term",
	"yj.dictionary.unnormalized_term",
]);

export class IonSymbol {
	constructor(public readonly name: string) {}
}

export class IonAnnotation {
	constructor(
		public readonly annotations: string[],
		public readonly value: IonValue
	) {}
}

export class IonSExp {
	constructor(public readonly items: IonValue[]) {}
}

export class IonNop {
	static readonly INSTANCE = new IonNop();
}

export type IonStruct = Map<string, IonValue>;

export type IonValue =
	| null
	| boolean
	| number
	| string
	| Uint8Array
	| IonSymbol
	| IonStruct
	| IonAnnotation
	| IonSExp
	| IonNop
	| IonValue[];

export class KfxSymbolTable {
	private readonly localSymbols: string[] = [];
	private localStartId = 10;

	loadFromDocSymbolTable(struct: IonStruct): void {
		let maxImportId: number = SYSTEM_SYMBOLS.length;
		const importsVal = struct.get("imports");
		if (Array.isArray(importsVal)) {
			for (const entry of importsVal) {
				if (entry instanceof Map) {
					const maxIdVal = entry.get("max_id");
					const nameVal = entry.get("name");
					if (typeof maxIdVal === "number" && maxIdVal > 0) {
						if (nameVal === "YJ_symbols") {
							maxImportId = maxIdVal;
						} else {
							maxImportId += maxIdVal;
						}
					}
				}
			}
		}

		const symsVal = struct.get("symbols");
		this.localSymbols.length = 0;
		if (Array.isArray(symsVal)) {
			for (const s of symsVal) {
				this.localSymbols.push(typeof s === "string" ? s : "");
			}
		}

		const totalMaxId = struct.get("max_id");
		if (
			typeof totalMaxId === "number" &&
			this.localSymbols.length > 0 &&
			totalMaxId >= this.localSymbols.length + SYSTEM_SYMBOLS.length
		) {
			this.localStartId = totalMaxId - this.localSymbols.length + 1;
		} else {
			this.localStartId = maxImportId + 1;
		}
	}

	getSymbol(symbolId: number): string {
		if (symbolId >= 1 && symbolId <= SYSTEM_SYMBOLS.length) {
			return SYSTEM_SYMBOLS[symbolId - 1];
		}
		if (symbolId >= this.localStartId) {
			const idx = symbolId - this.localStartId;
			if (idx >= 0 && idx < this.localSymbols.length && this.localSymbols[idx]) {
				return this.localSymbols[idx];
			}
		}
		return `$${symbolId}`;
	}
}

class ByteReader {
	offset: number;
	readonly end: number;

	constructor(
		public readonly data: Uint8Array,
		start = 0,
		end = data.length
	) {
		this.offset = start;
		this.end = end;
	}

	get remaining(): number {
		return this.end - this.offset;
	}

	readByte(): number {
		if (this.offset >= this.end) {
			throw new Error("Unexpected end of Ion buffer");
		}
		return this.data[this.offset++];
	}

	peekByte(): number {
		if (this.offset >= this.end) {
			throw new Error("Unexpected end of Ion buffer");
		}
		return this.data[this.offset];
	}

	readSlice(len: number): Uint8Array {
		if (len < 0 || this.offset + len > this.end) {
			throw new Error(`Ion slice out of bounds: offset=${this.offset} len=${len} end=${this.end}`);
		}
		const slice = this.data.subarray(this.offset, this.offset + len);
		this.offset += len;
		return slice;
	}

	readVarUInt(): number {
		let value = 0;
		while (true) {
			const b = this.readByte();
			value = value * 128 + (b & 0x7f);
			if (b & 0x80) {
				return value;
			}
		}
	}

	readVarSInt(): number {
		const first = this.readByte();
		const negative = (first & 0x40) !== 0;
		let value = first & 0x3f;
		if ((first & 0x80) === 0) {
			while (true) {
				const b = this.readByte();
				value = value * 128 + (b & 0x7f);
				if (b & 0x80) {
					break;
				}
			}
		}
		return negative ? -value : value;
	}
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

function readUnsignedIntBE(bytes: Uint8Array): number {
	let value = 0;
	for (let i = 0; i < bytes.length; i++) {
		value = value * 256 + bytes[i];
	}
	return value;
}

function readSignedIntBE(bytes: Uint8Array): number {
	if (bytes.length === 0) return 0;
	const first = bytes[0];
	const negative = (first & 0x80) !== 0;
	let value = first & 0x7f;
	for (let i = 1; i < bytes.length; i++) {
		value = value * 256 + bytes[i];
	}
	return negative ? -value : value;
}

function readUInt32LE(data: Uint8Array, offset: number): number {
	return (
		(data[offset] |
			(data[offset + 1] << 8) |
			(data[offset + 2] << 16) |
			(data[offset + 3] << 24)) >>>
		0
	);
}

function readUInt16LE(data: Uint8Array, offset: number): number {
	return data[offset] | (data[offset + 1] << 8);
}

function readUInt64LE(data: Uint8Array, offset: number): number {
	const lo = readUInt32LE(data, offset);
	const hi = readUInt32LE(data, offset + 4);
	return hi * 0x100000000 + lo;
}

function isIonBvmAt(data: Uint8Array, offset: number): boolean {
	return (
		offset + 4 <= data.length &&
		data[offset] === 0xe0 &&
		data[offset + 1] === 0x01 &&
		data[offset + 2] === 0x00 &&
		data[offset + 3] === 0xea
	);
}

export class IonDecoder {
	constructor(private readonly symtab: KfxSymbolTable) {}

	decodeSingleValue(data: Uint8Array): IonValue {
		const reader = new ByteReader(data, 0, data.length);
		if (isIonBvmAt(data, 0)) {
			reader.offset += 4;
		}
		while (reader.remaining > 0) {
			if (isIonBvmAt(data, reader.offset)) {
				reader.offset += 4;
				continue;
			}
			const val = this.readValue(reader);
			if (val !== IonNop.INSTANCE) {
				return val;
			}
		}
		return null;
	}

	private readValue(reader: ByteReader): IonValue {
		const descriptor = reader.readByte();
		const typeCode = descriptor >> 4;
		const flag = descriptor & 0x0f;

		if (typeCode === 0) {
			if (flag === 15) return null;
			const nopLen = flag === 14 ? reader.readVarUInt() : flag;
			reader.readSlice(nopLen);
			return IonNop.INSTANCE;
		}

		if (flag === 15) {
			return null;
		}

		if (typeCode === 1) {
			return flag !== 0;
		}

		const isStruct = typeCode === 13;
		const len =
			flag === 14 || (isStruct && flag === 1) ? reader.readVarUInt() : flag;

		switch (typeCode) {
			case 2: // PosInt
				return readUnsignedIntBE(reader.readSlice(len));
			case 3: // NegInt
				return -readUnsignedIntBE(reader.readSlice(len));
			case 4: {
				// Float
				const slice = reader.readSlice(len);
				if (len === 0) return 0;
				const dv = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
				if (len === 4) return dv.getFloat32(0, false);
				if (len === 8) return dv.getFloat64(0, false);
				return 0;
			}
			case 5: {
				// Decimal
				if (len === 0) return 0;
				const sub = new ByteReader(reader.data, reader.offset, reader.offset + len);
				reader.offset += len;
				const exp = sub.readVarSInt();
				const mag = readSignedIntBE(sub.readSlice(sub.remaining));
				return mag * Math.pow(10, exp);
			}
			case 6: // Timestamp (not needed for KFX content/metadata text)
				reader.readSlice(len);
				return null;
			case 7: // Symbol
				return new IonSymbol(this.symtab.getSymbol(readUnsignedIntBE(reader.readSlice(len))));
			case 8: // String
				return utf8Decoder.decode(reader.readSlice(len));
			case 9: // CLOB
			case 10: // BLOB
				return reader.readSlice(len);
			case 11: {
				// List
				const sub = new ByteReader(reader.data, reader.offset, reader.offset + len);
				reader.offset += len;
				const list: IonValue[] = [];
				while (sub.remaining > 0) {
					const item = this.readValue(sub);
					if (item !== IonNop.INSTANCE) {
						list.push(item);
					}
				}
				return list;
			}
			case 12: {
				// SExp
				const sub = new ByteReader(reader.data, reader.offset, reader.offset + len);
				reader.offset += len;
				const items: IonValue[] = [];
				while (sub.remaining > 0) {
					const item = this.readValue(sub);
					if (item !== IonNop.INSTANCE) {
						items.push(item);
					}
				}
				return new IonSExp(items);
			}
			case 13: {
				// Struct
				const sub = new ByteReader(reader.data, reader.offset, reader.offset + len);
				reader.offset += len;
				const map: IonStruct = new Map();
				while (sub.remaining > 0) {
					const fieldSym = this.symtab.getSymbol(sub.readVarUInt());
					const val = this.readValue(sub);
					if (val !== IonNop.INSTANCE) {
						map.set(fieldSym, val);
					}
				}
				return map;
			}
			case 14: {
				// Annotation
				const sub = new ByteReader(reader.data, reader.offset, reader.offset + len);
				reader.offset += len;
				const annotBytesLen = sub.readVarUInt();
				const annotEnd = sub.offset + annotBytesLen;
				const annotations: string[] = [];
				while (sub.offset < annotEnd) {
					annotations.push(this.symtab.getSymbol(sub.readVarUInt()));
				}
				const value = this.readValue(sub);
				return new IonAnnotation(annotations, value);
			}
			default:
				throw new Error(`Unsupported Ion type code: ${typeCode}`);
		}
	}
}

export interface KfxMetadata {
	asin: string;
	assetId: string;
	bookId: string;
	cdeContentType: string;
	title: string;
	authors: string[];
	containerId: string;
}

export interface KfxContentChunk {
	pid: number;
	eid: string | number;
	eidOffset: number;
	length: number;
	sectionName: string;
	matchZeroLen: boolean;
	text: string | null;
}

export interface KfxParsedBook {
	metadata: KfxMetadata;
	chunks: KfxContentChunk[];
	locationPids: number[];
}

interface EntityIndexEntry {
	idIdnum: number;
	typeIdnum: number;
	offset: number;
	length: number;
}

interface ContHeader {
	version: number;
	headerLen: number;
	containerId: string;
	symtab: KfxSymbolTable;
	entities: EntityIndexEntry[];
}

function unwrapIon(value: IonValue | undefined): IonValue | undefined {
	if (value instanceof IonAnnotation) {
		return value.value;
	}
	return value;
}

function asStruct(value: IonValue | undefined): IonStruct | null {
	const unwrapped = unwrapIon(value);
	return unwrapped instanceof Map ? unwrapped : null;
}

function asList(value: IonValue | undefined): IonValue[] | null {
	const unwrapped = unwrapIon(value);
	return Array.isArray(unwrapped) ? unwrapped : null;
}

function asString(value: IonValue | undefined): string {
	const unwrapped = unwrapIon(value);
	return typeof unwrapped === "string" ? unwrapped : "";
}

function asSymbolOrNumber(value: IonValue | undefined): string | number | null {
	const unwrapped = unwrapIon(value);
	if (unwrapped instanceof IonSymbol) return unwrapped.name;
	if (typeof unwrapped === "number") return unwrapped;
	if (typeof unwrapped === "string") return unwrapped;
	return null;
}

function asSymbolName(value: IonValue | undefined): string {
	const unwrapped = unwrapIon(value);
	if (unwrapped instanceof IonSymbol) return unwrapped.name;
	if (typeof unwrapped === "string") return unwrapped;
	return "";
}

function parseContHeaderFromBuffer(data: Uint8Array): ContHeader {
	if (data.length < 18) {
		throw new Error("KFX file is too short to be a valid CONT container");
	}
	const sig = String.fromCharCode(data[0], data[1], data[2], data[3]);
	if (sig !== "CONT") {
		throw new Error(`Invalid KFX container signature: ${sig}`);
	}

	const version = readUInt16LE(data, 4);
	const headerLen = readUInt32LE(data, 6);
	const containerInfoOffset = readUInt32LE(data, 10);
	const containerInfoLength = readUInt32LE(data, 14);

	if (headerLen > data.length) {
		throw new Error(`KFX buffer truncated before header end (${data.length} < ${headerLen})`);
	}

	const symtab = new KfxSymbolTable();
	const decoder = new IonDecoder(symtab);
	const cinfoVal = decoder.decodeSingleValue(
		data.subarray(containerInfoOffset, containerInfoOffset + containerInfoLength)
	);
	const cinfo = asStruct(cinfoVal);
	if (!cinfo) {
		throw new Error("Invalid KFX container_info struct");
	}

	const containerId = asString(cinfo.get("$409"));
	const compressionType = cinfo.get("$410");
	if (typeof compressionType === "number" && compressionType !== 0) {
		throw new Error(`Unsupported KFX compressionType=${compressionType} in ${containerId}`);
	}
	const drmScheme = cinfo.get("$411");
	if (typeof drmScheme === "number" && drmScheme !== 0) {
		throw new Error(`DRM-protected KFX (drmScheme=${drmScheme}) is not supported`);
	}

	const docSymOff = cinfo.get("$415");
	const docSymLen = cinfo.get("$416");
	if (typeof docSymOff === "number" && typeof docSymLen === "number" && docSymLen > 0) {
		const docSymRaw = decoder.decodeSingleValue(data.subarray(docSymOff, docSymOff + docSymLen));
		const docSymStruct = asStruct(docSymRaw);
		if (docSymStruct) {
			symtab.loadFromDocSymbolTable(docSymStruct);
		}
	}

	const indexOff = cinfo.get("$413");
	const indexLen = cinfo.get("$414");
	const entities: EntityIndexEntry[] = [];
	if (typeof indexOff === "number" && typeof indexLen === "number" && indexLen > 0) {
		for (let pos = indexOff; pos + 24 <= indexOff + indexLen; pos += 24) {
			entities.push({
				idIdnum: readUInt32LE(data, pos),
				typeIdnum: readUInt32LE(data, pos + 4),
				offset: readUInt64LE(data, pos + 8),
				length: readUInt64LE(data, pos + 16),
			});
		}
	}

	return { version, headerLen, containerId, symtab, entities };
}

function decodeEntityData(
	entityBytes: Uint8Array,
	symtab: KfxSymbolTable,
	decoder: IonDecoder,
	entry: EntityIndexEntry
): { ftype: string; fid: string | null; value: IonValue } {
	if (entityBytes.length < 10) {
		throw new Error("KFX entity truncated (< 10 bytes)");
	}
	const sig = String.fromCharCode(entityBytes[0], entityBytes[1], entityBytes[2], entityBytes[3]);
	if (sig !== "ENTY") {
		throw new Error(`Invalid KFX entity signature: ${sig}`);
	}
	const entityHeaderLen = readUInt32LE(entityBytes, 6);
	const entityInfoVal = decoder.decodeSingleValue(entityBytes.subarray(10, entityHeaderLen));
	const entityInfo = asStruct(entityInfoVal);
	if (entityInfo) {
		const compr = entityInfo.get("$410");
		const drm = entityInfo.get("$411");
		if ((typeof compr === "number" && compr !== 0) || (typeof drm === "number" && drm !== 0)) {
			throw new Error("Compressed or DRM-protected KFX entity is not supported");
		}
	}

	let ftype = symtab.getSymbol(entry.typeIdnum);
	let fid: string | null = symtab.getSymbol(entry.idIdnum);
	if (fid === "$348") {
		fid = null;
	}

	if (RAW_FRAGMENT_TYPES.has(ftype)) {
		return { ftype, fid, value: null };
	}

	let val = decoder.decodeSingleValue(entityBytes.subarray(entityHeaderLen));
	if (val instanceof IonAnnotation && val.annotations.includes(ftype) && fid === null) {
		fid = ftype;
		val = val.value;
	}
	return { ftype, fid, value: val };
}

function extractMetadataFromFragments(
	containerId: string,
	bookMetadataVal: IonValue | undefined,
	legacyMetadataVal: IonValue | undefined
): KfxMetadata {
	const meta: KfxMetadata = {
		asin: "",
		assetId: "",
		bookId: "",
		cdeContentType: "",
		title: "",
		authors: [],
		containerId,
	};

	const bmStruct = asStruct(bookMetadataVal);
	if (bmStruct) {
		const cats = asList(bmStruct.get("$491"));
		if (cats) {
			for (const catItem of cats) {
				const cat = asStruct(catItem);
				if (!cat) continue;
				const catName = asString(cat.get("$495"));
				if (catName !== "kindle_title_metadata") continue;
				const kvs = asList(cat.get("$258"));
				if (!kvs) continue;
				for (const kvItem of kvs) {
					const kv = asStruct(kvItem);
					if (!kv) continue;
					const k = asString(kv.get("$492"));
					const v = asString(kv.get("$307"));
					if (!k || !v) continue;
					if (k === "author") meta.authors.push(v);
					else if (k === "title") meta.title = v;
					else if (k === "ASIN") meta.asin = v;
					else if (k === "asset_id") meta.assetId = v;
					else if (k === "book_id") meta.bookId = v;
					else if (k === "cde_content_type") meta.cdeContentType = v;
				}
			}
		}
	}

	const legStruct = asStruct(legacyMetadataVal);
	if (legStruct) {
		if (!meta.title) {
			meta.title = asString(legStruct.get("$153"));
		}
		if (meta.authors.length === 0) {
			const authorRaw = asString(legStruct.get("$222"));
			if (authorRaw) {
				for (const part of authorRaw.split(" & ")) {
					const trimmed = part.trim();
					if (trimmed) meta.authors.push(trimmed);
				}
			}
		}
		if (!meta.assetId) {
			meta.assetId = asString(legStruct.get("$466"));
		}
	}

	return meta;
}

/**
 * Reads only KFX container header + metadata fragments ($490 / $258) using partial file I/O.
 * Very fast for scanning dozens of local .kfx files by ASIN.
 */
export async function readKfxFileMetadata(filePath: string): Promise<KfxMetadata | null> {
	const fh = await fs.promises.open(filePath, "r");
	try {
		const preamble = Buffer.allocUnsafe(18);
		const preRead = await fh.read(preamble, 0, 18, 0);
		if (preRead.bytesRead < 18) return null;
		const sig = preamble.subarray(0, 4).toString("ascii");
		if (sig !== "CONT") return null;

		const headerLen = preamble.readUInt32LE(6);
		const headerBuf = Buffer.allocUnsafe(headerLen);
		const hdrRead = await fh.read(headerBuf, 0, headerLen, 0);
		if (hdrRead.bytesRead < headerLen) return null;

		const contHeader = parseContHeaderFromBuffer(headerBuf);
		const decoder = new IonDecoder(contHeader.symtab);

		let bookMetadataVal: IonValue | undefined;
		let legacyMetadataVal: IonValue | undefined;

		for (const entry of contHeader.entities) {
			const typeSym = contHeader.symtab.getSymbol(entry.typeIdnum);
			if (typeSym !== "$490" && typeSym !== "$258") continue;

			const entityBuf = Buffer.allocUnsafe(entry.length);
			const eRead = await fh.read(entityBuf, 0, entry.length, contHeader.headerLen + entry.offset);
			if (eRead.bytesRead < entry.length) continue;

			const decoded = decodeEntityData(entityBuf, contHeader.symtab, decoder, entry);
			if (typeSym === "$490") bookMetadataVal = decoded.value;
			else if (typeSym === "$258") legacyMetadataVal = decoded.value;
		}

		const meta = extractMetadataFromFragments(contHeader.containerId, bookMetadataVal, legacyMetadataVal);
		if (!meta.asin && !meta.title) return null;
		return meta;
	} catch {
		return null;
	} finally {
		await fh.close();
	}
}

export function codePointLength(str: string): number {
	let count = 0;
	for (let i = 0; i < str.length; ) {
		const cp = str.codePointAt(i);
		count++;
		i += cp !== undefined && cp > 0xffff ? 2 : 1;
	}
	return count;
}

export function sliceCodePoints(str: string, start: number, end: number): string {
	if (start <= 0 && end >= str.length && str.length === codePointLength(str)) {
		return str;
	}
	const out: string[] = [];
	let cpIdx = 0;
	for (let i = 0; i < str.length && cpIdx < end; ) {
		const cp = str.codePointAt(i);
		const charLen = cp !== undefined && cp > 0xffff ? 2 : 1;
		if (cpIdx >= start) {
			out.push(str.slice(i, i + charLen));
		}
		cpIdx++;
		i += charLen;
	}
	return out.join("");
}

function makeFragKey(ftype: string, fid: string | null): string {
	return fid === null ? ftype : `${ftype}\u0000${fid}`;
}

export function parseKfxBook(data: Uint8Array): KfxParsedBook {
	const header = parseContHeaderFromBuffer(data);
	const decoder = new IonDecoder(header.symtab);

	const fragmentMap = new Map<string, IonValue>();
	const firstOfType = new Map<string, IonValue>();

	for (const entry of header.entities) {
		const typeSym = header.symtab.getSymbol(entry.typeIdnum);
		if (RAW_FRAGMENT_TYPES.has(typeSym)) continue;

		const start = header.headerLen + entry.offset;
		const end = start + entry.length;
		if (end > data.length) {
			throw new Error(`KFX entity ${typeSym} exceeds file length`);
		}
		const decoded = decodeEntityData(data.subarray(start, end), header.symtab, decoder, entry);
		const key = makeFragKey(decoded.ftype, decoded.fid);
		fragmentMap.set(key, decoded.value);
		if (!firstOfType.has(decoded.ftype)) {
			firstOfType.set(decoded.ftype, decoded.value);
		}
	}

	const metadata = extractMetadataFromFragments(
		header.containerId,
		firstOfType.get("$490"),
		firstOfType.get("$258")
	);

	// Ordered sections from $538.$169 or $258.$169
	const docData = asStruct(firstOfType.get("$538")) ?? asStruct(firstOfType.get("$258"));
	const readingOrders = asList(docData?.get("$169")) ?? [];
	const sectionNames: string[] = [];
	const seenSections = new Set<string>();

	for (const roItem of readingOrders) {
		const ro = asStruct(roItem);
		if (!ro) continue;
		const secs = asList(ro.get("$170")) ?? [];
		for (const sItem of secs) {
			const sName = asSymbolName(sItem);
			if (sName && !seenSections.has(sName)) {
				seenSections.add(sName);
				sectionNames.push(sName);
			}
		}
	}

	const eidSection = new Map<string | number, string>();
	const eidStartPos = new Map<string | number, number>();
	const processedStories = new Set<string>();
	const allChunks: KfxContentChunk[] = [];
	const sectionChunks: KfxContentChunk[] = [];
	let cpiPid = 0;
	let cpiPidForOffset = 0;

	function getFrag(ftype: string, fid: string): IonValue | undefined {
		return fragmentMap.get(makeFragKey(ftype, fid));
	}

	function walkSection(sectionName: string): void {
		const haveContent = (
			eid: string | number | null,
			length: number,
			advance: boolean,
			allowZero = true,
			matchZeroLen = false,
			text: string | null = null
		): void => {
			if (eid === null) return;

			let startPos = eidStartPos.get(eid);
			if (startPos === undefined) {
				startPos = cpiPidForOffset;
				eidStartPos.set(eid, startPos);
			}

			let eidOffset = cpiPidForOffset - startPos;
			if (advance) {
				cpiPidForOffset += length;
			}

			const prev = sectionChunks.length > 0 ? sectionChunks[sectionChunks.length - 1] : null;
			let curLen = length;
			let curText = text;

			if (prev !== null && prev.eid === eid) {
				sectionChunks.pop();
				cpiPid += curLen;
				eidOffset += curLen;
				curLen += prev.length;
				if (prev.text !== null || curText !== null) {
					curText = (prev.text ?? "") + (curText ?? "");
				}
				sectionChunks.push({
					pid: prev.pid,
					eid: prev.eid,
					eidOffset: prev.eidOffset,
					length: curLen,
					sectionName: prev.sectionName,
					matchZeroLen: prev.matchZeroLen,
					text: curText,
				});

				if (curLen === 0 || !allowZero) {
					return;
				}
				curLen = 0;
				curText = null;
			}

			sectionChunks.push({
				pid: cpiPid,
				eid,
				eidOffset,
				length: curLen,
				sectionName: eidSection.get(eid) ?? sectionName,
				matchZeroLen,
				text: curText,
			});
			cpiPid += curLen;
		};

		const extractPositionData = (
			rawData: IonValue | undefined,
			currentEid: string | number | null,
			contentKey: string,
			listIndex: number | null,
			listMax: number | null,
			advance: boolean
		): void => {
			if (rawData === undefined || rawData === null) return;

			if (rawData instanceof IonAnnotation) {
				extractPositionData(rawData.value, currentEid, contentKey, listIndex, listMax, advance);
				return;
			}

			if (Array.isArray(rawData)) {
				for (let i = 0; i < rawData.length; i++) {
					const item = rawData[i];
					if (item !== undefined && item !== null) {
						extractPositionData(item, currentEid, contentKey, i, rawData.length - 1, advance);
					}
				}
				return;
			}

			if (rawData instanceof IonSExp) {
				for (const item of rawData.items) {
					extractPositionData(item, currentEid, contentKey, null, null, advance);
				}
				return;
			}

			if (rawData instanceof Map) {
				let eid = currentEid;
				let parentEid: string | number | null = null;
				if (contentKey !== "$259") {
					const maybeEid = asSymbolOrNumber(rawData.get("$155")) ?? asSymbolOrNumber(rawData.get("$598"));
					if (maybeEid !== null) {
						parentEid = currentEid;
						eid = maybeEid;
						eidSection.set(eid, sectionName);
					}
				}

				const annotType = asSymbolName(rawData.get("$687"));
				const typ = asSymbolName(rawData.get("$159"));

				if (
					(typ === "$270" || typ === "$271" || typ === "$269") &&
					parentEid !== null &&
					contentKey === "$146" &&
					asSymbolName(rawData.get("$601")) === "$283" &&
					listIndex !== null
				) {
					haveContent(parentEid, listIndex === 0 ? -1 : 0, advance);
				}

				const savedCpiPidForOffset = cpiPidForOffset;

				if (typ === "$596" || typ === "$271" || typ === "$272" || typ === "$274") {
					haveContent(eid, 1, advance);
				} else if (typ === "$270" || typ === "$277" || typ === "$269" || typ === "$151") {
					if (!rawData.has("$145") && !rawData.has("$146") && !rawData.has("$176")) {
						haveContent(eid, 1, advance, true, false);
					}
				}

				const ptVal = rawData.get("$141");
				if (Array.isArray(ptVal)) {
					for (const pt of ptVal) {
						extractPositionData(pt, eid, "$141", null, null, advance);
					}
				}

				if (rawData.has("$146") && typ !== "$274" && typ !== "$272") {
					const renderHint = asSymbolName(rawData.get("$615"));
					haveContent(eid, 1, advance && renderHint !== "$688" && renderHint !== "$689");
				}

				let nonStructContent: IonValue | undefined;
				if (rawData.has("$145") && annotType !== "$584" && annotType !== "$690") {
					const fv = rawData.get("$145");
					const fvStruct = asStruct(fv);
					if (fvStruct) {
						const contentName = asSymbolName(fvStruct.get("name"));
						const idxVal = fvStruct.get("$403");
						const contentFrag = asStruct(getFrag("$145", contentName));
						const listVal = asList(contentFrag?.get("$146"));
						if (listVal && typeof idxVal === "number" && idxVal >= 0 && idxVal < listVal.length) {
							const text = asString(listVal[idxVal]);
							haveContent(eid, codePointLength(text), advance, true, false, text);
						}
					} else {
						nonStructContent = fv;
					}
				}

				if (rawData.has("$683")) {
					extractPositionData(rawData.get("$683"), eid, "$683", null, null, advance);
				}

				const f749 = rawData.get("$749");
				if (f749 instanceof IonSymbol) {
					extractPositionData(getFrag("$259", f749.name), null, "$259", null, null, advance);
				}

				if (rawData.has("$146")) {
					const cListKey = typ === "$274" ? "$274" : "$146";
					const listAdvance = typ === "$272" ? false : advance;
					const listEid = typ === "$272" ? null : eid;
					extractPositionData(rawData.get("$146"), listEid, cListKey, null, null, listAdvance);
				}

				if (nonStructContent !== undefined) {
					extractPositionData(nonStructContent, eid, "$145", null, null, advance);
				}

				if (rawData.has("$176") && contentKey !== "$259") {
					haveContent(eid, 1, advance);
					const storyName = asSymbolName(rawData.get("$176"));
					if (storyName && !processedStories.has(storyName)) {
						extractPositionData(getFrag("$259", storyName), null, "$259", null, null, advance);
						processedStories.add(storyName);
					}
				}

				for (const [fk, fv] of rawData.entries()) {
					if (typeof fv !== "string" && !IGNORED_STRUCT_FIELDS.has(fk)) {
						extractPositionData(fv, eid, fk, null, null, advance);
					}
				}

				if (
					typ !== "$271" &&
					asSymbolName(rawData.get("$601")) === "$283" &&
					cpiPidForOffset > savedCpiPidForOffset + 1
				) {
					cpiPidForOffset = savedCpiPidForOffset + 1;
				}
				return;
			}

			if (typeof rawData === "string") {
				let length = codePointLength(rawData);
				if (contentKey === "$146" && listIndex === 0) {
					length -= 1;
				}
				const allowZero = listIndex !== null && listMax !== null && listIndex < listMax;
				haveContent(currentEid, length, advance, allowZero, false, rawData);
			}
		};

		const secFrag = getFrag("$260", sectionName);
		extractPositionData(secFrag, null, "$260", null, null, true);

		for (const chunk of sectionChunks) {
			allChunks.push(chunk);
		}
		sectionChunks.length = 0;
	}

	for (const secName of sectionNames) {
		walkSection(secName);
	}

	// Build location PID table ($621 or $550) for accurate Kindle Location numbering
	const locationPids: number[] = [];
	const f621 = firstOfType.get("$621");
	const f621List = asList(f621);
	if (f621List && f621List.length > 0) {
		const row = asStruct(f621List[0]);
		const pids = asList(row?.get("$182"));
		if (pids) {
			for (const p of pids) {
				if (typeof p === "number") locationPids.push(p);
			}
		}
	}

	if (locationPids.length === 0) {
		const f550 = firstOfType.get("$550");
		const f550List = asList(f550);
		if (f550List && f550List.length > 0) {
			const row = asStruct(f550List[0]);
			const locs = asList(row?.get("$182"));
			if (locs) {
				const eidChunks = new Map<string | number, KfxContentChunk[]>();
				for (const chunk of allChunks) {
					const arr = eidChunks.get(chunk.eid);
					if (arr) arr.push(chunk);
					else eidChunks.set(chunk.eid, [chunk]);
				}

				for (const lmItem of locs) {
					const lm = asStruct(lmItem);
					if (!lm) continue;
					const eid = asSymbolOrNumber(lm.get("$155"));
					const offsetVal = lm.get("$143");
					const eidOffset = typeof offsetVal === "number" ? offsetVal : 0;
					if (eid === null) continue;
					const matches = eidChunks.get(eid);
					if (!matches || matches.length === 0) continue;

					let resolvedPid = matches[0].pid + eidOffset;
					for (const c of matches) {
						if (eidOffset >= c.eidOffset && eidOffset <= c.eidOffset + c.length) {
							resolvedPid = c.pid + (eidOffset - c.eidOffset);
							break;
						}
					}
					locationPids.push(resolvedPid);
				}
			}
		}
	}

	return { metadata, chunks: allChunks, locationPids };
}

/**
 * Extracts readable highlight text for inclusive KFX shortPosition range [startPid, endPid].
 */
export function extractKfxTextRange(
	chunks: KfxContentChunk[],
	startPid: number,
	endPid: number
): string {
	if (chunks.length === 0 || endPid < startPid) {
		return "";
	}

	const parts: string[] = [];
	for (const chunk of chunks) {
		if (chunk.length <= 0 || !chunk.text) continue;
		const chunkEnd = chunk.pid + chunk.length - 1;
		if (chunkEnd < startPid) continue;
		if (chunk.pid > endPid) break;

		const sliceStart = Math.max(0, startPid - chunk.pid);
		const sliceEnd = Math.min(chunk.length, endPid - chunk.pid + 1);
		if (sliceEnd > sliceStart) {
			const piece = sliceCodePoints(chunk.text, sliceStart, sliceEnd);
			if (piece) {
				parts.push(piece);
			}
		}
	}

	if (parts.length === 0) return "";
	let joined = parts[0];
	for (let i = 1; i < parts.length; i++) {
		const next = parts[i];
		const prevEndsWs = /\s$/.test(joined);
		const nextStartsWs = /^\s/.test(next);
		joined += prevEndsWs || nextStartsWs ? next : ` ${next}`;
	}
	return joined.trim();
}

/**
 * Converts a KFX shortPosition (PID) to 1-based Kindle Location matching My Clippings.txt.
 */
export function kfxPidToLocation(locationPids: number[], pid: number): number {
	if (locationPids.length === 0) {
		return Math.floor(Math.max(0, pid) / 110) + 1;
	}
	let lo = 0;
	let hi = locationPids.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (locationPids[mid] <= pid) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return Math.max(1, lo);
}
