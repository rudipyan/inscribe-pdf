// Writes a standard PDF /Highlight annotation into a PDF's bytes using pdf-lib's
// low-level object API (pdf-lib has no high-level "addHighlight" helper). Validated
// against both PDF.js (Obsidian's engine) and macOS's native Quartz renderer during
// the initial spike (scripts preserved in git history under spike/).
// `@cantoo/pdf-lib` is an API-compatible fork of pdf-lib that adds real
// encryption support -- the one capability stock pdf-lib lacks that we need
// (see loadPdfDoc below).
import { PDFDocument, PDFObject, PDFName, PDFArray, PDFDict, PDFNumber, PDFHexString, PDFInvalidObject, PDFRef, PDFRawStream, PDFString, PDFBool, EncryptedPDFError, ParseSpeeds, decodePDFRawStream } from '@cantoo/pdf-lib';
import type { PDFContext } from '@cantoo/pdf-lib';
import { boxesOverlap, type PdfBox } from './geometry';
import { normalizeQuote } from './pdf-text-extraction';

export type DocumentSnapshot = ReturnType<PDFDocument['takeSnapshot']>;
export type IncrementalSaveMode = 'classic-xref' | 'xref-stream' | 'full-rewrite';

export interface LoadedPdfSession {
	pdfDoc: PDFDocument;
	baseSnapshot: DocumentSnapshot | null;
	incrementalMode: IncrementalSaveMode;
	wasEncrypted: boolean;
	basePrevStartXRef: number;
}

export type PdfObjectUndoPatch =
	| {
		kind: 'annots';
		pageIndex: number;
		pageRef: PDFRef;
		prevAnnots: PDFObject | undefined;
		nextAnnots: PDFArray;
	}
	| {
		kind: 'recolor';
		pageIndex: number;
		targetRef: PDFRef;
		dict: PDFDict;
		prevC: PDFObject | undefined;
		nextC: PDFObject;
		prevAP: PDFObject | undefined;
		nextAP: PDFObject;
	}
	| {
		kind: 'note';
		pageIndex: number;
		targetRef: PDFRef;
		dict: PDFDict;
		prevContents: PDFObject | undefined;
		nextContents: PDFObject | undefined;
		prevRC: PDFObject | undefined;
	};

export interface RgbColor {
	/** 0..1 */
	r: number;
	/** 0..1 */
	g: number;
	/** 0..1 */
	b: number;
}

export interface AddHighlightOptions {
	/** 0-based page index. */
	pageIndex: number;
	/** Flat QuadPoints array, PDF32000 Z vertex order per quad, length a multiple of 8.
	 * One quad per line of a (possibly multi-line) selection. */
	quadPoints: number[];
	/** Union bounding box of all quads -- becomes the annotation's /Rect. */
	box: PdfBox;
	color: RgbColor;
	/** Fill opacity, 0..1. Defaults to full opacity: with the Multiply blend the
	 * highlight then renders over white paper as exactly its color while text
	 * stays readable -- the standard desktop-marker look. */
	opacity?: number;
	/** The exact text the user had selected when creating this highlight. PDF
	 * text layout doesn't support recovering "just the highlighted part" of a
	 * text run from geometry alone (see pdf-text-extraction.ts's extractQuote),
	 * so this is stored in full after whitespace normalization in a custom dict key and preferred over
	 * geometric reconstruction whenever it's available. */
	quote?: string;
	/** A rectangular figure/table selection, copied as an image. */
	isRegion?: boolean;
}

const DEFAULT_OPACITY = 1;
/** Custom (non-spec) annotation dict key holding the quote captured at
 * creation time -- see AddHighlightOptions.quote. Conforming PDF readers
 * ignore dict keys they don't recognize, so this doesn't affect how the
 * highlight itself renders anywhere; only getStoredQuotes reads it back. */
const QUOTE_KEY = 'StudyPDFQuote';
const SUPPORTED_REPLACEMENT_ANNOTATION_KEYS = new Set([
	'/Type', '/Subtype', '/Rect', '/QuadPoints', '/C', '/CA', '/F', '/AP', `/${QUOTE_KEY}`,
]);
/** Marks image regions so they are not reconstructed as text quotations. */
const REGION_KEY = 'StudyPDFRegion';

interface LocalRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface PdfPoint {
	x: number;
	y: number;
}

interface QuadPolygon {
	/** Vertices in painted perimeter order: TL, TR, BR, BL. */
	points: [PdfPoint, PdfPoint, PdfPoint, PdfPoint];
	area: number;
}

/** Converts each quad (8 numbers: TL,TR,BL,BR) into a rect local to the annotation's
 * own BBox coordinate space (BBox origin = box.left/box.bottom). One quad may not be
 * axis-aligned bounding-box-only in theory, but ours always are (see geometry.ts). */
function quadPointsToLocalRects(quadPoints: number[], box: PdfBox): LocalRect[] {
	const rects: LocalRect[] = [];
	for (let i = 0; i < quadPoints.length; i += 8) {
		const xs = [quadPoints[i], quadPoints[i + 2], quadPoints[i + 4], quadPoints[i + 6]] as number[];
		const ys = [quadPoints[i + 1], quadPoints[i + 3], quadPoints[i + 5], quadPoints[i + 7]] as number[];
		const left = Math.min(...xs);
		const right = Math.max(...xs);
		const bottom = Math.min(...ys);
		const top = Math.max(...ys);
		rects.push({
			x: left - box.left,
			y: bottom - box.bottom,
			width: right - left,
			height: top - bottom,
		});
	}
	return rects;
}

function quadPointsToLocalPolygons(quadPoints: number[], box: PdfBox): PdfPoint[][] {
	const polygons: PdfPoint[][] = [];
	for (let i = 0; i < quadPoints.length; i += 8) {
		// QuadPoints are stored TL, TR, BL, BR. PDF paths need perimeter order.
		polygons.push([
			{ x: quadPoints[i]! - box.left, y: quadPoints[i + 1]! - box.bottom },
			{ x: quadPoints[i + 2]! - box.left, y: quadPoints[i + 3]! - box.bottom },
			{ x: quadPoints[i + 6]! - box.left, y: quadPoints[i + 7]! - box.bottom },
			{ x: quadPoints[i + 4]! - box.left, y: quadPoints[i + 5]! - box.bottom },
		]);
	}
	return polygons;
}

/** Builds a path per actual quad perimeter, so slanted selections keep their
 * shape and separate text lines do not fill the gaps between them. */
function buildAppearanceStreamContent(quadPoints: number[], box: PdfBox, color: RgbColor): string {
	const paths = quadPointsToLocalPolygons(quadPoints, box).flatMap((points) => [
		`${points[0]!.x} ${points[0]!.y} m`,
		...points.slice(1).map((point) => `${point.x} ${point.y} l`),
		'h',
	]);
	const lines = [
		'/GS0 gs',
		`${color.r} ${color.g} ${color.b} rg`,
		...paths,
		'f',
	];
	return lines.join('\n');
}

function createHighlightAppearance(context: PDFContext, quadPoints: number[], box: PdfBox, color: RgbColor, opacity: number): PDFRawStream {
	const encoded = encodeAppearanceContent(buildAppearanceStreamContent(quadPoints, box, color));
	return PDFRawStream.of(
		context.obj({
			Length: encoded.length,
			Type: 'XObject',
			Subtype: 'Form',
			FormType: 1,
			BBox: [0, 0, box.right - box.left, box.top - box.bottom],
			Matrix: [1, 0, 0, 1, box.left, box.bottom],
			Resources: { ExtGState: { GS0: { Type: 'ExtGState', ca: opacity, BM: 'Multiply' } } },
		}),
		encoded,
	);
}

/** Previous Study PDF releases used bounding rectangles in the appearance
 * stream. Accept that exact, generated form for safe recoloring of old marks. */
function buildLegacyAppearanceStreamContent(quadPoints: number[], box: PdfBox, color: RgbColor): string {
	const rects = quadPointsToLocalRects(quadPoints, box);
	return ['/GS0 gs', `${color.r} ${color.g} ${color.b} rg`, ...rects.map((r) => `${r.x} ${r.y} ${r.width} ${r.height} re`), 'f'].join('\n');
}

function isValidRgbColor(color: RgbColor): boolean {
	return [color.r, color.g, color.b].every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1);
}

function validateInputQuadPoints(quadPoints: number[], box: PdfBox): void {
	if (!Number.isFinite(box.left) || !Number.isFinite(box.right) || !Number.isFinite(box.top) || !Number.isFinite(box.bottom) ||
		box.left >= box.right || box.bottom >= box.top) {
		throw new Error('Study PDF: highlight rectangle is malformed.');
	}
	if (quadPoints.length === 0 || quadPoints.length % 8 !== 0 || quadPoints.some((value) => !Number.isFinite(value))) {
		throw new Error('Study PDF: highlight quadrilateral points are malformed.');
	}
	const strict = parseQuadPolygons(quadPoints, box);
	if (!strict.valid) throw new Error(`Study PDF: ${strict.reason}`);
}

// Many real-world PDFs (scans, textbooks, downloaded books) are "encrypted" only
// to restrict printing/copying: an owner password sets permission flags, but the
// user password is empty, so every viewer opens them without prompting. Loading
// those with `password: ''` decrypts them (verified live on the user's actual
// 544-page course textbook). Note the output then SAVES DECRYPTED -- content
// identical, permission flags dropped. Only documents that genuinely require a
// password to open (a real user password, which we don't have) still fail, now
// with a clear message. (Stock pdf-lib had no decryption at all; that's why this
// module uses the @cantoo fork. Its `ignoreEncryption: true` is not a substitute:
// it just skips the guard and crashes deep in page-tree traversal.)
// Keep small and medium PDFs on the existing fast path. Larger files and very
// object-heavy documents yield between parser/writer batches so annotation
// work does not hold the main thread for one uninterrupted full-file pass.
const COOPERATIVE_PARSE_BYTES = 8 * 1024 * 1024;
const DEEP_COOPERATIVE_PARSE_BYTES = 32 * 1024 * 1024;
const COOPERATIVE_SAVE_BYTES = 8 * 1024 * 1024;
const DEEP_COOPERATIVE_SAVE_BYTES = 32 * 1024 * 1024;
const COOPERATIVE_OBJECT_COUNT = 5000;
const DEEP_COOPERATIVE_OBJECT_COUNT = 20000;
let iosPdfWorkScheduling = false;

/** Enables bounded parser and writer batches for iOS PDF work. */
export function configurePdfWorkScheduling(isIos: boolean): void {
	iosPdfWorkScheduling = isIos;
}

function parseOptionsForBytes(pdfBytes: Uint8Array) {
	const parseSpeed = pdfBytes.byteLength >= DEEP_COOPERATIVE_PARSE_BYTES
		? ParseSpeeds.Medium
		: pdfBytes.byteLength >= COOPERATIVE_PARSE_BYTES
			? ParseSpeeds.Fast
			: ParseSpeeds.Fastest;
	return { parseSpeed: iosPdfWorkScheduling ? Math.min(parseSpeed, ParseSpeeds.Medium) : parseSpeed };
}

function stripDecryptedLoadArtifacts(doc: PDFDocument): void {
	// @cantoo/pdf-lib workarounds so a decrypting load always SAVES a genuinely
	// decrypted document (both confirmed empirically against its source):
	// 1. Its decrypting parser "decrypts" the original cross-reference stream
	//    too -- but xref streams are never encrypted, so that garbles them into
	//    PDFInvalidObjects, which the writer then re-serializes verbatim. The
	//    stale xref carries "/Encrypt N 0 R", making our saved output falsely
	//    (and unopenably) claim to still be encrypted. A fresh xref is always
	//    regenerated on save, so these leftovers are safe to drop.
	for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
		if (obj instanceof PDFInvalidObject) doc.context.delete(ref);
	}
	// 2. It only strips the trailer's /Encrypt entry when its legacy-crypto
	//    path sets context.isDecrypted; newer encryption revisions keep it.
	delete (doc.context.trailerInfo as { Encrypt?: unknown }).Encrypt;
}

async function loadPdfDoc(pdfBytes: Uint8Array): Promise<PDFDocument> {
	try {
		return await PDFDocument.load(pdfBytes, parseOptionsForBytes(pdfBytes));
	} catch (err) {
		if (!(err instanceof EncryptedPDFError)) throw err;
		let doc: PDFDocument;
		try {
			doc = await PDFDocument.load(pdfBytes, { ...parseOptionsForBytes(pdfBytes), password: '' });
		} catch {
			throw new Error('This PDF requires a password to open, which this plugin does not support yet.');
		}
		stripDecryptedLoadArtifacts(doc);
		return doc;
	}
}

function isPdfA1Conformance(doc: PDFDocument): boolean {
	try {
		const meta = doc.catalog.lookup(PDFName.of('Metadata'));
		if (!(meta instanceof PDFRawStream)) return false;
		const xml = new TextDecoder('utf-8').decode(decodePDFRawStream(meta).decode());
		return /<pdfaid:part\b[^>]*>\s*1\s*<\/pdfaid:part>|\bpdfaid:part\s*=\s*["']1["']/.test(xml);
	} catch {
		return false;
	}
}

/** Detects whether incremental updates can safely append to this PDF without a full rewrite. */
export function detectIncrementalMode(
	pdfBytes: Uint8Array,
	pdfDoc: PDFDocument,
	wasEncrypted: boolean,
): IncrementalSaveMode {
	if (wasEncrypted) return 'full-rewrite';
	const prevStartXRef = pdfDoc.context.pdfFileDetails.prevStartXRef;
	if (!Number.isInteger(prevStartXRef) || prevStartXRef < 0 || prevStartXRef >= pdfBytes.byteLength) {
		return 'full-rewrite';
	}
	let offset = prevStartXRef;
	while (offset < pdfBytes.byteLength && (pdfBytes[offset] === 0x20 || pdfBytes[offset] === 0x09 || pdfBytes[offset] === 0x0a || pdfBytes[offset] === 0x0d)) {
		offset++;
	}
	const head = new TextDecoder('latin1').decode(pdfBytes.subarray(offset, Math.min(pdfBytes.byteLength, offset + 24)));
	if (head.startsWith('xref')) return 'classic-xref';
	if (/^\d+\s+\d+\s+obj\b/.test(head)) {
		return isPdfA1Conformance(pdfDoc) ? 'full-rewrite' : 'xref-stream';
	}
	return 'full-rewrite';
}

/** Loads a PDF once for an in-memory editing session with incremental-snapshot tracking. */
export async function loadPdfDocForSession(pdfBytes: Uint8Array): Promise<LoadedPdfSession> {
	try {
		const pdfDoc = await PDFDocument.load(pdfBytes, {
			...parseOptionsForBytes(pdfBytes),
			forIncrementalUpdate: true,
			updateMetadata: false,
		});
		const baseSnapshot = pdfDoc.context.snapshot ?? pdfDoc.takeSnapshot();
		const incrementalMode = detectIncrementalMode(pdfBytes, pdfDoc, false);
		const basePrevStartXRef = pdfDoc.context.pdfFileDetails.prevStartXRef ?? 0;
		return { pdfDoc, baseSnapshot, incrementalMode, wasEncrypted: false, basePrevStartXRef };
	} catch (err) {
		if (!(err instanceof EncryptedPDFError)) throw err;
		let pdfDoc: PDFDocument;
		try {
			pdfDoc = await PDFDocument.load(pdfBytes, {
				...parseOptionsForBytes(pdfBytes),
				password: '',
				updateMetadata: false,
			});
		} catch {
			throw new Error('This PDF requires a password to open, which this plugin does not support yet.');
		}
		stripDecryptedLoadArtifacts(pdfDoc);
		return { pdfDoc, baseSnapshot: null, incrementalMode: 'full-rewrite', wasEncrypted: true, basePrevStartXRef: 0 };
	}
}

/** Runs an in-memory mutation while bypassing pdf-lib's O(N) automatic indirect-object scan,
 * then explicitly marks the modified indirect object references on baseSnapshot. */
export function withExplicitSnapshotTracking<T>(
	pdfDoc: PDFDocument,
	baseSnapshot: DocumentSnapshot | null,
	fn: () => { result: T; dirtyRefs: readonly PDFRef[] },
): T {
	const previousSnapshot = pdfDoc.context.snapshot;
	pdfDoc.context.snapshot = undefined;
	try {
		const { result, dirtyRefs } = fn();
		if (baseSnapshot) {
			for (const ref of dirtyRefs) baseSnapshot.markRefForSave(ref);
		}
		return result;
	} finally {
		pdfDoc.context.snapshot = previousSnapshot;
	}
}

/** Applies inverse or forward object patches for fast in-memory undo/redo. */
export function applyUndoPatchToDoc(
	pdfDoc: PDFDocument,
	baseSnapshot: DocumentSnapshot | null,
	patches: readonly PdfObjectUndoPatch[],
	direction: 'undo' | 'redo',
): number[] {
	return withExplicitSnapshotTracking(pdfDoc, baseSnapshot, () => {
		const ordered = direction === 'undo' ? [...patches].reverse() : patches;
		const dirtyRefs: PDFRef[] = [];
		const pageIndexes = new Set<number>();
		const annotsKey = PDFName.of('Annots');
		const cKey = PDFName.of('C');
		const apKey = PDFName.of('AP');
		const contentsKey = PDFName.of('Contents');
		const rcKey = PDFName.of('RC');

		for (const patch of ordered) {
			pageIndexes.add(patch.pageIndex);
			if (patch.kind === 'annots') {
				const page = pdfDoc.getPage(patch.pageIndex);
				const nextValue = direction === 'undo' ? patch.prevAnnots : patch.nextAnnots;
				if (nextValue === undefined) page.node.delete(annotsKey);
				else page.node.set(annotsKey, nextValue);
				dirtyRefs.push(patch.pageRef);
			} else if (patch.kind === 'recolor') {
				const cVal = direction === 'undo' ? patch.prevC : patch.nextC;
				const apVal = direction === 'undo' ? patch.prevAP : patch.nextAP;
				if (cVal === undefined) patch.dict.delete(cKey);
				else patch.dict.set(cKey, cVal);
				if (apVal === undefined) patch.dict.delete(apKey);
				else patch.dict.set(apKey, apVal);
				dirtyRefs.push(patch.targetRef);
			} else {
				const contentsVal = direction === 'undo' ? patch.prevContents : patch.nextContents;
				const rcVal = direction === 'undo' ? patch.prevRC : undefined;
				if (contentsVal === undefined) patch.dict.delete(contentsKey);
				else patch.dict.set(contentsKey, contentsVal);
				if (rcVal === undefined) patch.dict.delete(rcKey);
				else patch.dict.set(rcKey, rcVal);
				dirtyRefs.push(patch.targetRef);
			}
		}

		return {
			result: [...pageIndexes].sort((a, b) => a - b),
			dirtyRefs,
		};
	});
}

/** Validates the appended incremental trailer/xref block without reparsing the full PDF. */
export function verifyIncrementalTail(
	baseBytes: Uint8Array,
	fullBytes: Uint8Array,
	incrementalMode: Exclude<IncrementalSaveMode, 'full-rewrite'>,
	expectedPrevXRef: number,
): void {
	if (fullBytes.byteLength <= baseBytes.byteLength) {
		throw new Error('Study PDF: incremental save produced an empty update.');
	}
	const tailStart = Math.max(baseBytes.byteLength, fullBytes.byteLength - 256);
	const tail = new TextDecoder('latin1').decode(fullBytes.subarray(tailStart));
	const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
	if (!match) {
		throw new Error('Study PDF: incremental PDF tail is missing a valid startxref/EOF marker.');
	}
	const xrefOffset = Number(match[1]);
	if (!Number.isSafeInteger(xrefOffset) || xrefOffset < baseBytes.byteLength || xrefOffset >= fullBytes.byteLength) {
		throw new Error('Study PDF: incremental startxref offset is out of range.');
	}
	let offset = xrefOffset;
	while (offset < fullBytes.byteLength && (fullBytes[offset] === 0x20 || fullBytes[offset] === 0x09 || fullBytes[offset] === 0x0a || fullBytes[offset] === 0x0d)) {
		offset++;
	}
	if (incrementalMode === 'classic-xref') {
		const xrefSection = new TextDecoder('latin1').decode(fullBytes.subarray(offset));
		if (!xrefSection.startsWith('xref')) {
			throw new Error('Study PDF: incremental classic xref section is malformed.');
		}
		if (expectedPrevXRef > 0 && !new RegExp(`/Prev\\s+${expectedPrevXRef}\\b`).test(xrefSection)) {
			throw new Error('Study PDF: incremental trailer is missing the expected /Prev offset.');
		}
		return;
	}
	const streamHeaderBytes = fullBytes.subarray(offset, Math.min(fullBytes.byteLength, offset + 512));
	const streamHeader = new TextDecoder('latin1').decode(streamHeaderBytes);
	const dictHeader = streamHeader.split(/\bstream\b/, 1)[0] ?? streamHeader;
	if (!/^\d+\s+\d+\s+obj\b/.test(dictHeader) || !/\/Type\s*\/XRef\b/.test(dictHeader)) {
		throw new Error('Study PDF: incremental XRef stream header is malformed.');
	}
	if (expectedPrevXRef > 0 && !new RegExp(`/Prev\\s+${expectedPrevXRef}\\b`).test(dictHeader)) {
		throw new Error('Study PDF: incremental XRef stream is missing the expected /Prev offset.');
	}
}

/** Serializes the current session PDF either as an O(changed) incremental tail
 * against the pinned base snapshot or as a verified full rewrite when required. */
export async function serializeSessionBytes(
	pdfDoc: PDFDocument,
	baseBytes: Uint8Array,
	baseSnapshot: DocumentSnapshot | null,
	incrementalMode: IncrementalSaveMode,
	basePrevStartXRef: number,
): Promise<Uint8Array> {
	if (incrementalMode === 'full-rewrite' || !baseSnapshot) {
		const savedBytes = await savePdfDoc(pdfDoc, baseBytes);
		const verifyDoc = await PDFDocument.load(savedBytes, parseOptionsForBytes(savedBytes));
		if (verifyDoc.getPageCount() !== pdfDoc.getPageCount()) {
			throw new Error(
				`Study PDF: page count changed after saving (${pdfDoc.getPageCount()} -> ${verifyDoc.getPageCount()}); aborting to avoid corrupting the file.`,
			);
		}
		return savedBytes;
	}
	const delta = await pdfDoc.saveIncremental(baseSnapshot, {
		useObjectStreams: incrementalMode === 'xref-stream',
		objectsPerTick: 1500,
	});
	const fullBytes = new Uint8Array(baseBytes.byteLength + delta.byteLength);
	fullBytes.set(baseBytes, 0);
	fullBytes.set(delta, baseBytes.byteLength);
	verifyIncrementalTail(baseBytes, fullBytes, incrementalMode, basePrevStartXRef);
	return fullBytes;
}

/** Binds a selectable annotation target to the exact source bytes that were
 * inspected. This prevents a ref number copied from a different PDF from
 * being accepted when both files happen to allocate the same object number. */
async function fingerprintPdfBytes(pdfBytes: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) throw new Error('Study PDF: this environment cannot verify the source PDF identity.');
	// WebCrypto reads precisely the typed-array view's byteOffset/byteLength;
	// pass the caller's view directly instead of copying a large PDF buffer.
	const view = new Uint8Array(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength);
	const digest = await subtle.digest('SHA-256', view as BufferSource);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

/** All saves go through here: force the classic cross-reference-table writer.
 * @cantoo/pdf-lib defaults to its object-stream writer for PDF 1.5+ headers, and
 * that writer produced corrupted output on a real decrypt-loaded textbook (the
 * freshly added annotation object was written truncated -- "End of file inside
 * dictionary" from PDF.js; confirmed with the vanilla library, not our
 * workarounds). The classic writer is the same one stock pdf-lib always used --
 * every output we validated across Adobe/Preview/PDF.js came from it. */
function savePdfDoc(pdfDoc: PDFDocument, sourceBytes: Uint8Array): Promise<Uint8Array> {
	const objectCount = pdfDoc.context.enumerateIndirectObjects().length;
	const objectsPerTick = sourceBytes.byteLength >= DEEP_COOPERATIVE_SAVE_BYTES || objectCount >= DEEP_COOPERATIVE_OBJECT_COUNT
		? 500
		: sourceBytes.byteLength >= COOPERATIVE_SAVE_BYTES || objectCount >= COOPERATIVE_OBJECT_COUNT
			? 1500
			: Infinity;
	return pdfDoc.save({
		useObjectStreams: false,
		objectsPerTick: iosPdfWorkScheduling ? Math.min(objectsPerTick, ParseSpeeds.Medium) : objectsPerTick,
	});
}

/** Safety guard shared by every function that saves a modified PDF: pdf-lib fully
 * re-serializes the whole document on save, and complex real-world PDFs don't
 * always round-trip cleanly through that. Reload our own output and verify it
 * isn't structurally corrupted *before* ever handing these bytes to a caller who
 * may overwrite the user's original file with them. Fail loudly rather than
 * silently returning bad bytes. (Loaded-encrypted documents save decrypted --
 * verified empirically -- so this plain reload works for them too.) */
async function verifySavedBytes(
	savedBytes: Uint8Array,
	originalPageCount: number,
	pageIndex: number,
	expectedAnnotCount: number,
): Promise<PDFDocument> {
	const verifyDoc = await PDFDocument.load(savedBytes, parseOptionsForBytes(savedBytes));
	if (verifyDoc.getPageCount() !== originalPageCount) {
		throw new Error(
			`Study PDF: page count changed after saving (${originalPageCount} -> ${verifyDoc.getPageCount()}); aborting to avoid corrupting the file.`,
		);
	}
	const verifyAnnots = safeDictionaryArray(verifyDoc.getPage(pageIndex).node, PDFName.of('Annots'));
	const verifyAnnotCount = verifyAnnots?.size() ?? 0;
	if (verifyAnnotCount !== expectedAnnotCount) {
		throw new Error(
			`Study PDF: annotation count on page ${pageIndex} is ${verifyAnnotCount}, expected ${expectedAnnotCount}; aborting to avoid corrupting the file.`,
		);
	}
	return verifyDoc;
}

/** Adds every annotation in one in-memory document transaction with explicit snapshot tracking. */
export function addHighlightsToDoc(
	pdfDoc: PDFDocument,
	baseSnapshot: DocumentSnapshot | null,
	optionsList: readonly AddHighlightOptions[],
): { addedRefs: PDFRef[]; changedPageIndexes: number[]; patches: PdfObjectUndoPatch[] } {
	if (optionsList.length === 0) throw new Error('Study PDF: at least one highlight is required.');
	const context = pdfDoc.context;
	const annotsKey = PDFName.of('Annots');
	const pageCount = pdfDoc.getPageCount();
	const additionsByPage = new Map<number, {
		page: ReturnType<PDFDocument['getPage']>;
		existingAnnots: PDFArray | undefined;
		items: { options: AddHighlightOptions; opacity: number; quote: string }[];
	}>();

	for (const options of optionsList) {
		const { pageIndex, quadPoints, box, color, opacity = DEFAULT_OPACITY, quote } = options;
		if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
			throw new Error('Study PDF: highlight page does not exist.');
		}
		const page = pdfDoc.getPage(pageIndex);
		const rawAnnotsValue = page.node.get(annotsKey);
		const existingAnnots = safeDictionaryArray(page.node, annotsKey);
		if (rawAnnotsValue !== undefined && !existingAnnots) {
			throw new Error(`Study PDF: page ${pageIndex} has an unreadable /Annots array; highlight was not saved.`);
		}
		if (quadPoints.length === 0 || quadPoints.length % 8 !== 0) {
			throw new Error(`quadPoints must be a non-empty multiple of 8, got ${quadPoints.length}`);
		}
		if (!isValidRgbColor(color)) throw new Error('Study PDF: highlight color must contain finite RGB channels between 0 and 1.');
		if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Study PDF: highlight opacity must be between 0 and 1.');
		validateInputQuadPoints(quadPoints, box);
		const group = additionsByPage.get(pageIndex) ?? { page, existingAnnots, items: [] };
		group.items.push({ options, opacity, quote: normalizeQuote(quote ?? '') });
		additionsByPage.set(pageIndex, group);
	}

	return withExplicitSnapshotTracking(pdfDoc, baseSnapshot, () => {
		const addedRefs: PDFRef[] = [];
		const patches: PdfObjectUndoPatch[] = [];
		const dirtyRefs: PDFRef[] = [];
		for (const [pageIndex, group] of additionsByPage) {
			const prevAnnots = group.page.node.get(annotsKey);
			const nextAnnots = PDFArray.withContext(context);
			for (const existing of group.existingAnnots?.asArray() ?? []) nextAnnots.push(existing);
			for (const { options, opacity, quote } of group.items) {
				const { quadPoints, box, color } = options;
				const apRef = context.register(createHighlightAppearance(context, quadPoints, box, color, opacity));
				const highlightDict = context.obj({
					Type: 'Annot',
					Subtype: 'Highlight',
					Rect: [box.left, box.bottom, box.right, box.top],
					QuadPoints: quadPoints,
					C: [color.r, color.g, color.b],
					CA: opacity,
					F: 4,
					AP: { N: apRef },
					...(options.isRegion ? { [REGION_KEY]: PDFBool.True } : {}),
					...(quote ? { [QUOTE_KEY]: PDFHexString.fromText(quote) } : {}),
				});
				const annotRef = context.register(highlightDict);
				nextAnnots.push(annotRef);
				addedRefs.push(annotRef);
			}
			group.page.node.set(annotsKey, nextAnnots);
			patches.push({ kind: 'annots', pageIndex, pageRef: group.page.ref, prevAnnots, nextAnnots });
			dirtyRefs.push(group.page.ref);
		}
		return {
			result: {
				addedRefs,
				changedPageIndexes: [...additionsByPage.keys()].sort((a, b) => a - b),
				patches,
			},
			dirtyRefs,
		};
	});
}

/** Adds every annotation in one pdf-lib load/save transaction. This is used
 * for cross-page selections so the PDF write and undo-history record are
 * atomic across all touched pages. */
export async function addHighlightAnnotations(
	pdfBytes: Uint8Array,
	optionsList: readonly AddHighlightOptions[],
): Promise<Uint8Array> {
	if (optionsList.length === 0) throw new Error('Study PDF: at least one highlight is required.');
	const pdfDoc = await loadPdfDoc(pdfBytes);
	const expectedCounts = new Map<number, number>();
	for (const options of optionsList) {
		const prev = expectedCounts.get(options.pageIndex) ??
			(options.pageIndex >= 0 && options.pageIndex < pdfDoc.getPageCount()
				? safeDictionaryArray(pdfDoc.getPage(options.pageIndex).node, PDFName.of('Annots'))?.size() ?? 0
				: 0);
		expectedCounts.set(options.pageIndex, prev + 1);
	}
	addHighlightsToDoc(pdfDoc, null, optionsList);

	const savedBytes = await savePdfDoc(pdfDoc, pdfBytes);
	const verifyDoc = await PDFDocument.load(savedBytes, parseOptionsForBytes(savedBytes));
	if (verifyDoc.getPageCount() !== pdfDoc.getPageCount()) {
		throw new Error('Study PDF: page count changed after saving; aborting to avoid corrupting the file.');
	}
	for (const [pageIndex, expectedAnnotCount] of expectedCounts) {
		const verifyAnnots = safeDictionaryArray(verifyDoc.getPage(pageIndex).node, PDFName.of('Annots'));
		const actualCount = verifyAnnots?.size() ?? 0;
		if (actualCount !== expectedAnnotCount) {
			throw new Error(`Study PDF: annotation count on page ${pageIndex} is ${actualCount}, expected ${expectedAnnotCount}; aborting to avoid corrupting the file.`);
		}
	}
	const fingerprint = await fingerprintPdfBytes(savedBytes);
	await rememberVerifiedHighlightState(savedBytes, verifyDoc, fingerprint, {
		sourceBytes: pdfBytes,
		changedPageIndexes: expectedCounts.keys(),
	});
	return savedBytes;
}

interface ValidatedReplacementHighlight {
	options: AddHighlightOptions;
	opacity: number;
	quote: string;
	polygons: QuadPolygon[];
}

function replacementMetadataReason(context: PDFContext, dict: PDFDict): string | null {
	const unexpectedKeys = dict.keys()
		.map((key) => key.toString())
		.filter((key) => !SUPPORTED_REPLACEMENT_ANNOTATION_KEYS.has(key));
	if (unexpectedKeys.length > 0) {
		return `This highlight has metadata the replacement cannot preserve safely (${unexpectedKeys.join(', ')}).`;
	}
	if (dict.get(PDFName.of('Type'))?.toString() !== '/Annot') return 'This highlight has an unsupported annotation type marker.';
	const flags = safeContextNumber(context, dict.get(PDFName.of('F')));
	if (flags !== 4) return 'This highlight has unsupported annotation flags.';
	const quoteValue = dict.get(PDFName.of(QUOTE_KEY));
	if (quoteValue !== undefined && readNote(dict, QUOTE_KEY) === null) return 'This highlight has an unsupported stored quote value.';
	try {
		metadataSignature(dict);
	} catch {
		return 'This highlight has metadata that cannot be verified safely.';
	}
	return null;
}

export interface ReplacementPagePlan {
	pageIndex: number;
	page: ReturnType<PDFDocument['getPage']>;
	prevAnnots: PDFObject | undefined;
	originalAnnots: ReturnType<PDFArray['get']>[];
	removals: Set<string>;
	additions: PDFRef[];
	expectedAnnots: ReturnType<PDFArray['get']>[];
}

/** Applies text-selection highlight additions and overlapping-highlight replacements
 * inside an open PDFDocument with explicit snapshot tracking. */
export function replaceOverlappingHighlightsInDoc(
	pdfDoc: PDFDocument,
	baseSnapshot: DocumentSnapshot | null,
	optionsList: readonly AddHighlightOptions[],
): {
	addedAnnotations: { ref: PDFRef; replacement: ValidatedReplacementHighlight }[];
	removedRefs: PDFRef[];
	pagePlans: Map<number, ReplacementPagePlan>;
	changedPageIndexes: number[];
	patches: PdfObjectUndoPatch[];
} {
	if (optionsList.length === 0) throw new Error('Study PDF: at least one highlight is required.');
	const context = pdfDoc.context;
	const validated: ValidatedReplacementHighlight[] = [];
	const optionsByPage = new Map<number, ValidatedReplacementHighlight[]>();
	const pagePlans = new Map<number, ReplacementPagePlan>();

	for (const options of optionsList) {
		const { pageIndex, quadPoints, box, color, opacity = DEFAULT_OPACITY, quote } = options;
		if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) {
			throw new Error('Study PDF: highlight page does not exist.');
		}
		if (quadPoints.length === 0 || quadPoints.length % 8 !== 0) {
			throw new Error(`quadPoints must be a non-empty multiple of 8, got ${quadPoints.length}`);
		}
		if (!isValidRgbColor(color)) throw new Error('Study PDF: highlight color must contain finite RGB channels between 0 and 1.');
		if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Study PDF: highlight opacity must be between 0 and 1.');
		validateInputQuadPoints(quadPoints, box);
		const parsed = parseQuadPolygons(quadPoints, box);
		if (!parsed.valid) throw new Error(`Study PDF: ${parsed.reason}`);
		const replacement: ValidatedReplacementHighlight = {
			options,
			opacity,
			quote: normalizeQuote(quote ?? ''),
			polygons: parsed.polygons,
		};
		validated.push(replacement);
		const pageOptions = optionsByPage.get(pageIndex) ?? [];
		pageOptions.push(replacement);
		optionsByPage.set(pageIndex, pageOptions);
	}

	const annotsKey = PDFName.of('Annots');
	const removedRefs: PDFRef[] = [];
	for (const [pageIndex, pageOptions] of optionsByPage) {
		const page = pdfDoc.getPage(pageIndex);
		const prevAnnots = page.node.get(annotsKey);
		const originalArray = safeDictionaryArray(page.node, annotsKey);
		if (prevAnnots !== undefined && !originalArray) {
			throw new Error(`Study PDF: page ${pageIndex} has an unreadable /Annots array; replacement was not saved.`);
		}
		const originalAnnots = originalArray ? [...originalArray.asArray()] : [];
		const plan: ReplacementPagePlan = {
			pageIndex,
			page,
			prevAnnots,
			originalAnnots,
			removals: new Set(),
			additions: [],
			expectedAnnots: [],
		};
		pagePlans.set(pageIndex, plan);

		const referenceCounts = new Map<string, number>();
		for (const value of originalAnnots) {
			if (value instanceof PDFRef) referenceCounts.set(value.toString(), (referenceCounts.get(value.toString()) ?? 0) + 1);
		}

		for (const value of originalAnnots) {
			const dict = safeContextDict(context, value);
			if (!dict || dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') continue;
			if (dict.get(PDFName.of(REGION_KEY)) === PDFBool.True) continue;
			const geometry = readHighlightGeometry(context, value);
			if (!geometry) {
				throw new Error(`Study PDF: page ${pageIndex} has a /Highlight without usable /Rect geometry; replacement was not saved because overlap cannot be determined safely.`);
			}

			if (geometry.invalidReason) {
				if (pageOptions.some(({ options }) => boxesOverlap(geometry.box, options.box))) {
					throw new Error(`Study PDF: an existing /Highlight may overlap the new selection, but its geometry is invalid (${geometry.invalidReason}); replacement was not saved.`);
				}
				continue;
			}

			const overlaps = pageOptions.some(({ options, polygons }) => boxesOverlap(geometry.box, options.box) &&
				geometry.polygons.some((existing) => polygons.some((incoming) => polygonsHavePositiveAreaIntersection(existing, incoming))));
			if (!overlaps) continue;

			if (!(value instanceof PDFRef)) {
				throw new Error('Study PDF: an overlapping /Highlight is a direct annotation with no stable reference; replacement was not saved.');
			}
			if (referenceCounts.get(value.toString()) !== 1) {
				throw new Error('Study PDF: an overlapping /Highlight has an ambiguous annotation reference; replacement was not saved.');
			}
			if (dict.get(PDFName.of('Contents')) !== undefined || dict.get(PDFName.of('RC')) !== undefined) {
				throw new Error('Study PDF: an overlapping highlight contains a note or rich-text comment. Replacement was not saved so the note is preserved.');
			}
			const unsupportedReason = getUnsupportedReason(context, value, geometry, dict, 'overlap') ?? replacementMetadataReason(context, dict);
			if (unsupportedReason) {
				throw new Error(`Study PDF: an overlapping highlight cannot be replaced safely: ${unsupportedReason} The PDF was not changed.`);
			}
			plan.removals.add(value.toString());
			removedRefs.push(value);
		}
	}

	return withExplicitSnapshotTracking(pdfDoc, baseSnapshot, () => {
		const addedAnnotations: { ref: PDFRef; replacement: ValidatedReplacementHighlight }[] = [];
		for (const replacement of validated) {
			const { options, opacity, quote } = replacement;
			const { pageIndex, quadPoints, box, color } = options;
			const apRef = context.register(createHighlightAppearance(context, quadPoints, box, color, opacity));
			const highlightDict = context.obj({
				Type: 'Annot',
				Subtype: 'Highlight',
				Rect: [box.left, box.bottom, box.right, box.top],
				QuadPoints: quadPoints,
				C: [color.r, color.g, color.b],
				CA: opacity,
				F: 4,
				AP: { N: apRef },
				...(quote ? { [QUOTE_KEY]: PDFHexString.fromText(quote) } : {}),
			});
			const ref = context.register(highlightDict);
			pagePlans.get(pageIndex)!.additions.push(ref);
			addedAnnotations.push({ ref, replacement });
		}

		const patches: PdfObjectUndoPatch[] = [];
		const dirtyRefs: PDFRef[] = [];
		for (const plan of pagePlans.values()) {
			const keptAnnots = plan.originalAnnots.filter((value) => !(value instanceof PDFRef && plan.removals.has(value.toString())));
			plan.expectedAnnots = [...keptAnnots, ...plan.additions];
			const annots = PDFArray.withContext(context);
			for (const value of plan.expectedAnnots) annots.push(value);
			plan.page.node.set(annotsKey, annots);
			patches.push({ kind: 'annots', pageIndex: plan.pageIndex, pageRef: plan.page.ref, prevAnnots: plan.prevAnnots, nextAnnots: annots });
			dirtyRefs.push(plan.page.ref);
		}
		return {
			result: {
				addedAnnotations,
				removedRefs,
				pagePlans,
				changedPageIndexes: [...pagePlans.keys()].sort((a, b) => a - b),
				patches,
			},
			dirtyRefs,
		};
	});
}

/** Adds new highlights while replacing only existing, fully supported highlights
 * whose actual QuadPoints polygons have a positive-area intersection with one
 * of the new selections. All overlap decisions use the original /Annots arrays,
 * so new highlights in a cross-page operation never remove one another. */
export async function replaceOverlappingHighlightAnnotations(
	pdfBytes: Uint8Array,
	optionsList: readonly AddHighlightOptions[],
): Promise<Uint8Array> {
	if (optionsList.length === 0) throw new Error('Study PDF: at least one highlight is required.');
	const pdfDoc = await loadPdfDoc(pdfBytes);
	const { addedAnnotations, pagePlans } = replaceOverlappingHighlightsInDoc(pdfDoc, null, optionsList);

	const savedBytes = await savePdfDoc(pdfDoc, pdfBytes);
	const verifyDoc = await PDFDocument.load(savedBytes, parseOptionsForBytes(savedBytes));
	if (verifyDoc.getPageCount() !== pdfDoc.getPageCount()) {
		throw new Error('Study PDF: page count changed after saving; aborting to avoid corrupting the file.');
	}
	for (const [pageIndex, plan] of pagePlans) {
		const verifyAnnots = safeDictionaryArray(verifyDoc.getPage(pageIndex).node, PDFName.of('Annots'));
		const actual = verifyAnnots ? verifyAnnots.asArray() : [];
		if (JSON.stringify(actual.map(canonicalPdfValue)) !== JSON.stringify(plan.expectedAnnots.map(canonicalPdfValue))) {
			throw new Error(`Study PDF: annotation membership or order changed on page ${pageIndex} after saving; aborting to avoid corrupting the file.`);
		}
	}
	for (const { ref, replacement } of addedAnnotations) {
		const { options, quote } = replacement;
		const verifyAnnots = safeDictionaryArray(verifyDoc.getPage(options.pageIndex).node, PDFName.of('Annots'));
		const verifyRef = verifyAnnots?.asArray().find((value) => value instanceof PDFRef && sameRef(value, ref));
		if (!(verifyRef instanceof PDFRef)) throw new Error('Study PDF: a new highlight reference is missing after saving.');
		const dict = verifyDoc.context.lookup(verifyRef, PDFDict);
		const geometry = readHighlightGeometry(verifyDoc.context, verifyRef);
		if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight' || !geometry || geometry.invalidReason ||
			!numericArrayMatches(verifyDoc.context, dict.get(PDFName.of('Rect')), [options.box.left, options.box.bottom, options.box.right, options.box.top]) ||
			!numericArrayMatches(verifyDoc.context, dict.get(PDFName.of('QuadPoints')), options.quadPoints) ||
			!sameColor(readRgbColor(verifyDoc.context, dict), options.color) ||
			(quote ? readNote(dict, QUOTE_KEY) !== quote : dict.get(PDFName.of(QUOTE_KEY)) !== undefined)) {
			throw new Error('Study PDF: new highlight geometry, color, or stored quote did not verify after saving.');
		}
		const appearance = checkRecolorAppearance(verifyDoc.context, dict, geometry, options.quadPoints, options.color);
		const annotationOpacity = safeContextNumber(verifyDoc.context, dict.get(PDFName.of('CA')));
		if (appearance.reason || !appearance.graphicsState || annotationOpacity === undefined ||
			Math.abs(annotationOpacity - replacement.opacity) >= 1e-8 ||
			Math.abs(appearance.graphicsState.ca - replacement.opacity) >= 1e-8 ||
			appearance.graphicsState.blendMode !== '/Multiply') {
			throw new Error('Study PDF: new highlight appearance or opacity did not verify after saving.');
		}
	}
	const fingerprint = await fingerprintPdfBytes(savedBytes);
	await rememberVerifiedHighlightState(savedBytes, verifyDoc, fingerprint, {
		sourceBytes: pdfBytes,
		changedPageIndexes: pagePlans.keys(),
	});
	return savedBytes;
}

/** A /Highlight annotation reduced to the geometry a lookup needs: its /Rect
 * and the individual quads it actually paints. */
export interface HighlightGeometry {
	/** The annotation's /Rect -- the union of all quads. */
	box: PdfBox;
	/** One box per quad (one per highlighted line). Empty for a highlight with
	 * no usable /QuadPoints, where /Rect is all we have to go on. */
	quads: PdfBox[];
	/** Strictly validated polygons in TL, TR, BR, BL perimeter order. */
	polygons: QuadPolygon[];
	/** Why this geometry cannot safely be recolored, if applicable. */
	invalidReason: string | null;
}

function safeDictionaryArray(dict: PDFDict, key: PDFName): PDFArray | undefined {
	try {
		return dict.lookupMaybe(key, PDFArray);
	} catch {
		return undefined;
	}
}

function safeContextArray(context: PDFContext, value: ReturnType<PDFArray['get']> | undefined): PDFArray | undefined {
	try {
		return value ? context.lookupMaybe(value, PDFArray) : undefined;
	} catch {
		return undefined;
	}
}

function safeContextDict(context: PDFContext, value: ReturnType<PDFArray['get']> | undefined): PDFDict | undefined {
	try {
		return value ? context.lookupMaybe(value, PDFDict) : undefined;
	} catch {
		return undefined;
	}
}

function safeContextNumber(context: PDFContext, value: ReturnType<PDFArray['get']> | undefined): number | undefined {
	try {
		return value ? context.lookupMaybe(value, PDFNumber)?.asNumber() : undefined;
	} catch {
		return undefined;
	}
}

function numbersOf(array: PDFArray): number[] | null {
	const values = array.asArray();
	if (!values.every((value) => value instanceof PDFNumber)) return null;
	const numbers = values.map((value) => value.asNumber());
	return numbers.every(Number.isFinite) ? numbers : null;
}

function parseQuadPolygons(raw: number[], box: PdfBox): { valid: true; polygons: QuadPolygon[] } | { valid: false; polygons: []; reason: string } {
	if (raw.length === 0 || raw.length % 8 !== 0) return { valid: false, polygons: [], reason: 'This highlight has missing or malformed /QuadPoints.' };
	const polygons: QuadPolygon[] = [];
	for (let i = 0; i < raw.length; i += 8) {
		const points: [PdfPoint, PdfPoint, PdfPoint, PdfPoint] = [
			{ x: raw[i]!, y: raw[i + 1]! },
			{ x: raw[i + 2]!, y: raw[i + 3]! },
			{ x: raw[i + 6]!, y: raw[i + 7]! },
			{ x: raw[i + 4]!, y: raw[i + 5]! },
		];
		if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
			return { valid: false, polygons: [], reason: 'This highlight has non-finite /QuadPoints.' };
		}
		if (points.some((point) => point.x < box.left - 1e-8 || point.x > box.right + 1e-8 || point.y < box.bottom - 1e-8 || point.y > box.top + 1e-8)) {
			return { valid: false, polygons: [], reason: 'This highlight has /QuadPoints outside its /Rect.' };
		}
		const crosses: number[] = [];
		for (let j = 0; j < 4; j++) {
			const a = points[j]!;
			const b = points[(j + 1) % 4]!;
			const c = points[(j + 2) % 4]!;
			crosses.push((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
		}
		if (crosses.some((cross) => Math.abs(cross) < 1e-8) || !(crosses.every((cross) => cross > 0) || crosses.every((cross) => cross < 0))) {
			return { valid: false, polygons: [], reason: 'This highlight has a degenerate or non-convex quadrilateral.' };
		}
		const twiceArea = points.reduce((sum, point, j) => {
			const next = points[(j + 1) % 4]!;
			return sum + point.x * next.y - next.x * point.y;
		}, 0);
		const area = Math.abs(twiceArea) / 2;
		if (!Number.isFinite(area) || area < 1e-8) return { valid: false, polygons: [], reason: 'This highlight has a zero-area quadrilateral.' };
		polygons.push({ points, area });
	}
	return { valid: true, polygons };
}

/** Tests actual convex polygon intersection, excluding edge-only contact. */
function polygonsHavePositiveAreaIntersection(first: QuadPolygon, second: QuadPolygon): boolean {
	for (const polygon of [first, second]) {
		for (let index = 0; index < polygon.points.length; index++) {
			const start = polygon.points[index]!;
			const end = polygon.points[(index + 1) % polygon.points.length]!;
			const axisX = start.y - end.y;
			const axisY = end.x - start.x;
			let firstMin = Infinity;
			let firstMax = -Infinity;
			let secondMin = Infinity;
			let secondMax = -Infinity;
			for (const point of first.points) {
				const projection = point.x * axisX + point.y * axisY;
				firstMin = Math.min(firstMin, projection);
				firstMax = Math.max(firstMax, projection);
			}
			for (const point of second.points) {
				const projection = point.x * axisX + point.y * axisY;
				secondMin = Math.min(secondMin, projection);
				secondMax = Math.max(secondMax, projection);
			}
			if (firstMax <= secondMin || secondMax <= firstMin) return false;
		}
	}
	return true;
}

/** The geometry of a /Highlight annotation, or null if the ref isn't one (or
 * has no /Rect). */
function readHighlightGeometry(context: PDFContext, ref: ReturnType<PDFArray['get']>): HighlightGeometry | null {
	let dict: PDFDict;
	try {
		dict = context.lookup(ref, PDFDict);
	} catch {
		return null;
	}
	if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') return null;

	const rectArray = safeContextArray(context, dict.get(PDFName.of('Rect')));
	if (!rectArray) return null;
	const rectNumbers = numbersOf(rectArray);
	if (!rectNumbers || rectNumbers.length !== 4) return null;
	const [left, bottom, right, top] = rectNumbers;
	if (left! > right! || bottom! > top!) return null;
	const box = { left: left!, bottom: bottom!, right: right!, top: top! };

	const quadValue = dict.get(PDFName.of('QuadPoints'));
	const quadArray = safeContextArray(context, quadValue);
	const raw = quadArray ? numbersOf(quadArray) : null;
	const quads: PdfBox[] = [];
	// Keep legacy bbox lookup behavior, while the recolor and point-hit paths
	// require every source quadrilateral to pass strict validation.
	if (raw) {
		for (let i = 0; i + 8 <= raw.length; i += 8) {
			const xs = [raw[i]!, raw[i + 2]!, raw[i + 4]!, raw[i + 6]!];
			const ys = [raw[i + 1]!, raw[i + 3]!, raw[i + 5]!, raw[i + 7]!];
			quads.push({ left: Math.min(...xs), right: Math.max(...xs), top: Math.max(...ys), bottom: Math.min(...ys) });
		}
	}
	const parsed = !quadValue
		? { valid: false as const, polygons: [] as [], reason: 'This highlight has no /QuadPoints.' }
		: !quadArray || !raw
			? { valid: false as const, polygons: [] as [], reason: 'This highlight has malformed /QuadPoints.' }
			: parseQuadPolygons(raw, box);
	return { box, quads, polygons: parsed.polygons, invalidReason: parsed.valid ? null : parsed.reason };
}

export interface HighlightInfo {
	/** The annotation's /Contents comment (the "note"), or null if it has none. */
	note: string | null;
	/** Exact indirect object identity bound to these source bytes, absent for direct dictionaries. */
	target: HighlightTarget | null;
	quote: string | null;
	/** PDF-space text quads for recovering an imported highlight's quote. */
	quoteRects?: readonly PdfBox[];
	currentColor: RgbColor | null;
	unsupportedReason: string | null;
	/** PDF-space bounds of an explicitly marked image region. */
	regionBox?: PdfBox;
}

/** Reads a string-valued dict entry (by key name), handling both string
 * encodings a real-world PDF may use (literal PDFString and PDFHexString).
 * Used for both /Contents (the user's note) and the custom quote key. */
function readNote(dict: PDFDict, key = 'Contents'): string | null {
	const value = dict.get(PDFName.of(key));
	const text = (value as { decodeText?: () => string } | undefined)?.decodeText?.();
	return text || null;
}

function readRgbColor(context: PDFContext, dict: PDFDict): RgbColor | null {
	const raw = dict.get(PDFName.of('C'));
	const array = safeContextArray(context, raw);
	const values = array ? numbersOf(array) : null;
	if (!values || values.length !== 3) return null;
	const color = { r: values[0]!, g: values[1]!, b: values[2]! };
	return isValidRgbColor(color) ? color : null;
}

function sameColor(a: RgbColor | null, b: RgbColor): boolean {
	return !!a && a.r === b.r && a.g === b.g && a.b === b.b;
}

function readQuadPoints(context: PDFContext, dict: PDFDict): number[] | null {
	const raw = dict.get(PDFName.of('QuadPoints'));
	const array = safeContextArray(context, raw);
	return array ? numbersOf(array) : null;
}

function numericArrayMatches(context: PDFContext, raw: unknown, expected: number[]): boolean {
	const array = safeContextArray(context, raw as ReturnType<PDFArray['get']> | undefined);
	const actual = array ? numbersOf(array) : null;
	return !!actual && actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) < 1e-8);
}

function dictionaryKeysEqual(dict: PDFDict, keys: string[]): boolean {
	const actual = dict.keys().map((key) => key.toString()).sort();
	return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

interface AppearanceCheck {
	reason: string | null;
	stream: PDFRawStream | null;
	appearanceDict: PDFDict | null;
	appearanceValue: ReturnType<PDFDict['get']>;
	normalValue: ReturnType<PDFDict['get']>;
	graphicsState: { ca: number; blendMode: string } | null;
	style: 'polygon' | 'legacy-rectangles' | null;
	filteredReplacementOpacity?: number;
}

/** Only recolor the small, known appearance form used by Study PDF. Arbitrary
 * imported appearance programs can contain clipping, masks, blend modes, or
 * state selection that this plugin cannot safely reproduce. */
function checkRecolorAppearance(
	context: PDFContext,
	dict: PDFDict,
	geometry: HighlightGeometry,
	quadPoints: number[],
	color: RgbColor | null,
): AppearanceCheck {
	const unsupported = (reason: string): AppearanceCheck => ({
		reason,
		stream: null,
		appearanceDict: null,
		appearanceValue: dict.get(PDFName.of('AP')),
		normalValue: undefined,
		graphicsState: null,
		style: null,
	});
	const annotationOpacityValue = dict.get(PDFName.of('CA'));
	let annotationOpacity: number | undefined;
	if (annotationOpacityValue) {
		const opacity = safeContextNumber(context, annotationOpacityValue);
		if (opacity === undefined || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) return unsupported('This highlight has unsupported /CA opacity.');
		annotationOpacity = opacity;
	}
	if (dict.get(PDFName.of('AS'))) return unsupported('This highlight uses appearance-state selection that cannot be recolored safely.');
	const apValue = dict.get(PDFName.of('AP'));
	const ap = safeContextDict(context, apValue);
	if (!ap) return unsupported('This highlight has no supported appearance dictionary.');
	if (ap.get(PDFName.of('R')) || ap.get(PDFName.of('D'))) return unsupported('This highlight has alternate appearance states that cannot be recolored safely.');
	const normalValue = ap.get(PDFName.of('N'));
	let streamObject: PDFObject | undefined;
	try {
		streamObject = normalValue ? context.lookup(normalValue) : undefined;
	} catch {
		return unsupported('This highlight has a malformed normal appearance stream.');
	}
	if (!(streamObject instanceof PDFRawStream)) return unsupported('This highlight does not use a supported normal appearance stream.');
	const stream = streamObject;
	const streamDict = stream.dict;
	const filter = streamDict.get(PDFName.of('Filter'));
	if (filter || streamDict.get(PDFName.of('DecodeParms'))) {
		const filtered = unsupported('This highlight uses a filtered appearance stream.');
		if (!filter || streamDict.get(PDFName.of('Subtype'))?.toString() !== '/Form' || !dictionaryKeysEqual(ap, ['/N'])) return filtered;
		return {
			...filtered,
			appearanceDict: ap,
			normalValue,
			filteredReplacementOpacity: annotationOpacity ?? DEFAULT_OPACITY,
		};
	}
	if (!dictionaryKeysEqual(streamDict, ['/Length', '/Type', '/Subtype', '/FormType', '/BBox', '/Matrix', '/Resources'])) {
		return unsupported('This highlight appearance has unsupported form graphics state.');
	}
	const formTypeValue = streamDict.get(PDFName.of('FormType'));
	const formType = safeContextNumber(context, formTypeValue);
	if (streamDict.get(PDFName.of('Type'))?.toString() !== '/XObject' ||
		streamDict.get(PDFName.of('Subtype'))?.toString() !== '/Form' || formType !== 1) {
		return unsupported('This highlight has an unsupported appearance form.');
	}
	const width = geometry.box.right - geometry.box.left;
	const height = geometry.box.top - geometry.box.bottom;
	if (!numericArrayMatches(context, streamDict.get(PDFName.of('BBox')), [0, 0, width, height]) ||
		!numericArrayMatches(context, streamDict.get(PDFName.of('Matrix')), [1, 0, 0, 1, geometry.box.left, geometry.box.bottom])) {
		return unsupported('This highlight appearance does not match its /Rect geometry.');
	}
	const resourcesValue = streamDict.get(PDFName.of('Resources'));
	const resources = safeContextDict(context, resourcesValue);
	if (!resources || !dictionaryKeysEqual(resources, ['/ExtGState'])) return unsupported('This highlight has unsupported appearance resources.');
	const extValue = resources.get(PDFName.of('ExtGState'));
	const ext = safeContextDict(context, extValue);
	if (!ext || !dictionaryKeysEqual(ext, ['/GS0'])) return unsupported('This highlight has unsupported graphics states.');
	const gsValue = ext.get(PDFName.of('GS0'));
	const gs = safeContextDict(context, gsValue);
	if (!gs || !dictionaryKeysEqual(gs, ['/Type', '/ca', '/BM']) || gs.get(PDFName.of('Type'))?.toString() !== '/ExtGState' || gs.get(PDFName.of('BM'))?.toString() !== '/Multiply') {
		return unsupported('This highlight has masks or a conflicting blend mode.');
	}
	const alphaValue = gs.get(PDFName.of('ca'));
	const alpha = safeContextNumber(context, alphaValue);
	if (alpha === undefined || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return unsupported('This highlight has unsupported appearance opacity.');
	if (annotationOpacity !== undefined && annotationOpacity !== alpha) return unsupported('This highlight has conflicting annotation and appearance opacity.');
	if (!color) return unsupported('This highlight has no valid /C RGB color.');
	const content = stream.getContentsString();
	const expectedPolygon = buildAppearanceStreamContent(quadPoints, geometry.box, color);
	const expectedLegacy = buildLegacyAppearanceStreamContent(quadPoints, geometry.box, color);
	const style = content === expectedPolygon ? 'polygon' : content === expectedLegacy ? 'legacy-rectangles' : null;
	if (!style) return unsupported('This highlight appearance contains unsupported drawing instructions or a different color.');
	return {
		reason: null,
		stream,
		appearanceDict: ap,
		appearanceValue: apValue,
		normalValue,
		graphicsState: { ca: alpha, blendMode: gs.get(PDFName.of('BM'))!.toString() },
		style,
	};
}

function geometrySignature(geometry: HighlightGeometry): string {
	return JSON.stringify([
		geometry.box.left,
		geometry.box.bottom,
		geometry.box.right,
		geometry.box.top,
		geometry.quads.map((quad) => [quad.left, quad.bottom, quad.right, quad.top]),
	]);
}

function targetForAnnotation(
	pageIndex: number,
	ref: ReturnType<PDFArray['get']>,
	sourceFingerprint: string,
	geometry: HighlightGeometry,
) {
	return ref instanceof PDFRef
		? { pageIndex, objectNumber: ref.objectNumber, generationNumber: ref.generationNumber, sourceFingerprint, geometrySignature: geometrySignature(geometry) }
		: null;
}

function getUnsupportedReason(
	context: PDFContext,
	ref: ReturnType<PDFArray['get']>,
	geometry: HighlightGeometry,
	dict: PDFDict,
	operation: 'recolor' | 'overlap',
): string | null {
	if (!(ref instanceof PDFRef)) return 'This direct annotation has no stable indirect reference and cannot be recolored.';
	if (geometry.invalidReason) return geometry.invalidReason;
	const color = readRgbColor(context, dict);
	if (!color) return 'This highlight has no valid /C RGB color.';
	const quadPoints = readQuadPoints(context, dict);
	if (!quadPoints) return 'This highlight has malformed /QuadPoints.';
	const appearance = checkRecolorAppearance(context, dict, geometry, quadPoints, color);
	if (operation === 'recolor' && appearance.filteredReplacementOpacity !== undefined) return null;
	return appearance.reason;
}

function makeHighlightInfo(context: PDFContext, pageIndex: number, ref: ReturnType<PDFArray['get']>, geometry: HighlightGeometry, dict: PDFDict, sourceFingerprint: string): HighlightInfo {
	return {
		...(dict.get(PDFName.of(REGION_KEY)) === PDFBool.True ? { regionBox: geometry.box } : {}),
		note: readNote(dict),
		target: targetForAnnotation(pageIndex, ref, sourceFingerprint, geometry),
		quote: readNote(dict, QUOTE_KEY),
		...(geometry.invalidReason === null ? { quoteRects: geometry.quads } : {}),
		currentColor: readRgbColor(context, dict),
		unsupportedReason: getUnsupportedReason(context, ref, geometry, dict, 'recolor'),
	};
}

function indexedInfo(highlight: IndexedHighlight): HighlightInfo {
	return {
		regionBox: highlight.regionBox,
		note: highlight.note,
		target: highlight.target,
		quote: highlight.quote,
		...(highlight.quoteRects ? { quoteRects: highlight.quoteRects } : {}),
		currentColor: highlight.currentColor,
		unsupportedReason: highlight.unsupportedReason,
	};
}

/** Every /Highlight annotation on a page, in /Annots order, reduced to just
 * what a click lookup needs. */
export interface IndexedHighlight extends HighlightInfo {
	/** Validated /Rect and /QuadPoints geometry for point hit-testing. */
	geometry: HighlightGeometry;
	/** Original position in the page's /Annots array, used for stable ties. */
	annotsOrder: number;
}

/** All highlights in the document, keyed by 0-based page index. */
export type HighlightIndex = Map<number, IndexedHighlight[]>;

export interface VerifiedHighlightState {
	fingerprint: string;
	index: HighlightIndex;
}

const MAX_CACHED_FINGERPRINT_INDEXES = 8;
const verifiedHighlightStates = new WeakMap<Uint8Array, VerifiedHighlightState>();
const verifiedIndexesByFingerprint = new Map<string, HighlightIndex>();

function rememberFingerprintIndex(fingerprint: string, index: HighlightIndex): void {
	if (verifiedIndexesByFingerprint.has(fingerprint)) {
		verifiedIndexesByFingerprint.delete(fingerprint);
	} else if (verifiedIndexesByFingerprint.size >= MAX_CACHED_FINGERPRINT_INDEXES) {
		const oldestKey = verifiedIndexesByFingerprint.keys().next().value;
		if (oldestKey !== undefined) verifiedIndexesByFingerprint.delete(oldestKey);
	}
	verifiedIndexesByFingerprint.set(fingerprint, index);
}

/** Returns cached metadata only for the exact output Uint8Array object. Callers
 * must not mutate output bytes; copies and other views have no associated state. */
export function getVerifiedHighlightState(bytes: Uint8Array): VerifiedHighlightState | undefined {
	return verifiedHighlightStates.get(bytes);
}

async function resolvePreviousHighlightIndex(
	sourceBytes?: Uint8Array,
	sourceFingerprint?: string,
): Promise<HighlightIndex | undefined> {
	if (sourceBytes) {
		const direct = verifiedHighlightStates.get(sourceBytes);
		if (direct) return direct.index;
	}
	if (sourceFingerprint) {
		return verifiedIndexesByFingerprint.get(sourceFingerprint);
	}
	if (sourceBytes && verifiedIndexesByFingerprint.size > 0) {
		try {
			const fingerprint = await fingerprintPdfBytes(sourceBytes);
			return verifiedIndexesByFingerprint.get(fingerprint);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function buildPageHighlights(
	context: PDFContext,
	page: ReturnType<PDFDocument['getPage']>,
	pageIndex: number,
	sourceFingerprint: string,
): IndexedHighlight[] {
	if (page.node.get(PDFName.of('Annots')) === undefined) return [];
	const annots = safeDictionaryArray(page.node, PDFName.of('Annots'));
	if (!annots) return [];

	const found: IndexedHighlight[] = [];
	const seenRefs = new Set<string>();
	for (let i = 0; i < annots.size(); i++) {
		const ref = annots.get(i);
		const geometry = readHighlightGeometry(context, ref);
		if (!geometry) continue;
		const target = targetForAnnotation(pageIndex, ref, sourceFingerprint, geometry);
		if (target) {
			const key = `${target.objectNumber}:${target.generationNumber}`;
			if (seenRefs.has(key)) continue;
			seenRefs.add(key);
		}
		const dict = context.lookup(ref, PDFDict);
		found.push({ geometry, ...makeHighlightInfo(context, pageIndex, ref, geometry, dict, sourceFingerprint), annotsOrder: i });
	}
	return found;
}

function updateHighlightIndexFromPrevious(
	pdfDoc: PDFDocument,
	sourceFingerprint: string,
	previousIndex: HighlightIndex,
	changedPageIndexes: Iterable<number>,
	mutatedRef?: PDFRef,
): HighlightIndex {
	const pageCount = pdfDoc.getPageCount();
	const dirtyPages = new Set<number>();
	for (const pageIndex of changedPageIndexes) {
		if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
			return buildHighlightIndexFromDocument(pdfDoc, sourceFingerprint);
		}
		dirtyPages.add(pageIndex);
	}
	if (mutatedRef) {
		for (const [pageIndex, entries] of previousIndex) {
			if (entries.some((entry) =>
				entry.target?.objectNumber === mutatedRef.objectNumber &&
				entry.target.generationNumber === mutatedRef.generationNumber,
			)) {
				dirtyPages.add(pageIndex);
			}
		}
	}
	const index: HighlightIndex = new Map();
	for (const [pageIndex, entries] of previousIndex) {
		if (pageIndex < 0 || pageIndex >= pageCount) {
			return buildHighlightIndexFromDocument(pdfDoc, sourceFingerprint);
		}
		if (dirtyPages.has(pageIndex)) continue;
		index.set(
			pageIndex,
			entries.map((entry) => ({
				...entry,
				target: entry.target ? { ...entry.target, sourceFingerprint } : null,
			})),
		);
	}
	for (const pageIndex of dirtyPages) {
		const found = buildPageHighlights(pdfDoc.context, pdfDoc.getPage(pageIndex), pageIndex, sourceFingerprint);
		if (found.length > 0) index.set(pageIndex, found);
	}
	return new Map([...index.entries()].sort(([a], [b]) => a - b));
}

async function rememberVerifiedHighlightState(
	bytes: Uint8Array,
	pdfDoc: PDFDocument,
	fingerprint: string,
	options?: {
		sourceBytes?: Uint8Array;
		sourceFingerprint?: string;
		changedPageIndexes?: Iterable<number>;
		mutatedRef?: PDFRef;
	},
): Promise<void> {
	const previousIndex = options?.changedPageIndexes
		? await resolvePreviousHighlightIndex(options.sourceBytes, options.sourceFingerprint)
		: undefined;
	const index = previousIndex && options?.changedPageIndexes
		? updateHighlightIndexFromPrevious(pdfDoc, fingerprint, previousIndex, options.changedPageIndexes, options.mutatedRef)
		: buildHighlightIndexFromDocument(pdfDoc, fingerprint);
	verifiedHighlightStates.set(bytes, { fingerprint, index });
	rememberFingerprintIndex(fingerprint, index);
}

/** Parses the document once and reduces it to the polygons and metadata a click
 * lookup needs, so repeated clicks don't each re-read and re-parse the whole
 * file (a real stall on a large PDF, on the tap path where it is most visible). */
function buildHighlightIndexFromDocument(pdfDoc: PDFDocument, sourceFingerprint: string): HighlightIndex {
	const context = pdfDoc.context;
	const index: HighlightIndex = new Map();

	pdfDoc.getPages().forEach((page, pageIndex) => {
		const found = buildPageHighlights(context, page, pageIndex, sourceFingerprint);
		if (found.length > 0) index.set(pageIndex, found);
	});

	return index;
}

export function buildHighlightIndexFromDoc(pdfDoc: PDFDocument, sourceFingerprint: string): HighlightIndex {
	return buildHighlightIndexFromDocument(pdfDoc, sourceFingerprint);
}

export function updateHighlightIndexForPages(
	pdfDoc: PDFDocument,
	sourceFingerprint: string,
	previousIndex: HighlightIndex,
	changedPageIndexes: Iterable<number>,
): HighlightIndex {
	return updateHighlightIndexFromPrevious(pdfDoc, sourceFingerprint, previousIndex, changedPageIndexes);
}

export async function buildHighlightIndex(pdfBytes: Uint8Array): Promise<HighlightIndex> {
	const pdfDoc = await loadPdfDoc(pdfBytes);
	const sourceFingerprint = await fingerprintPdfBytes(pdfBytes);
	const index = buildHighlightIndexFromDocument(pdfDoc, sourceFingerprint);
	rememberFingerprintIndex(sourceFingerprint, index);
	return index;
}

function pointOnSegment(point: PdfPoint, a: PdfPoint, b: PdfPoint): boolean {
	const cross = (point.x - a.x) * (b.y - a.y) - (point.y - a.y) * (b.x - a.x);
	if (Math.abs(cross) > 1e-8) return false;
	return point.x >= Math.min(a.x, b.x) - 1e-8 && point.x <= Math.max(a.x, b.x) + 1e-8 &&
		point.y >= Math.min(a.y, b.y) - 1e-8 && point.y <= Math.max(a.y, b.y) + 1e-8;
}

function pointInPolygon(point: PdfPoint, polygon: QuadPolygon): boolean {
	const points = polygon.points;
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const a = points[j]!;
		const b = points[i]!;
		if (pointOnSegment(point, a, b)) return true;
		const crosses = (a.y > point.y) !== (b.y > point.y) &&
			point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
		if (crosses) inside = !inside;
	}
	return inside;
}

/** All actual highlight polygons at a point, ordered by painted area and then
 * original /Annots position. A slanted quad's bounding box is never used. */
export function findHighlightsInIndexAtPoint(index: HighlightIndex, pageIndex: number, point: { x: number; y: number }): HighlightInfo[] {
	if (!Number.isInteger(pageIndex) || pageIndex < 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
	return (index.get(pageIndex) ?? [])
		.filter((item) => item.geometry.invalidReason === null && item.geometry.polygons.some((polygon) => pointInPolygon(point, polygon)))
		.sort((a, b) => {
			const areaA = a.geometry.polygons.reduce((sum, polygon) => sum + polygon.area, 0);
			const areaB = b.geometry.polygons.reduce((sum, polygon) => sum + polygon.area, 0);
			return areaA - areaB || a.annotsOrder - b.annotsOrder;
		})
		.map(indexedInfo);
}

export interface StoredQuoteMetadata {
	quote: string | null;
	/** Region quotes are user-authored and must never be reconstructed from geometry. */
	isRegion: boolean;
}

/** Includes the legacy per-page quote arrays for API compatibility, plus a
 * stable indirect-reference map for safe joins to PDF.js annotations. */
export type StoredQuotesByReference = Map<number, (string | null)[]> & {
	byAnnotationId: Map<number, Map<string, StoredQuoteMetadata>>;
};

export interface StoredQuotesOptions {
	signal?: AbortSignal;
}

function assertStoredQuoteScanActive(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error('The highlights scan was cancelled.');
	error.name = 'AbortError';
	throw error;
}

function pdfJsAnnotationIdForRef(ref: ReturnType<PDFArray['get']>): string | null {
	if (!(ref instanceof PDFRef)) return null;
	return `${ref.objectNumber}R${ref.generationNumber === 0 ? '' : ref.generationNumber}`;
}

/** Reads captured quotes by stable indirect reference. PDF.js exposes the
 * same reference as annotation.id; positional zipping is unsafe because the
 * two libraries can filter or reorder annotations differently. */
export async function getStoredQuotes(pdfBytes: Uint8Array, options: StoredQuotesOptions = {}): Promise<StoredQuotesByReference> {
	assertStoredQuoteScanActive(options.signal);
	const pdfDoc = await loadPdfDoc(pdfBytes);
	const context = pdfDoc.context;
	const result = new Map<number, (string | null)[]>() as StoredQuotesByReference;
	result.byAnnotationId = new Map();

	for (let pageIndex = 0; pageIndex < pdfDoc.getPageCount(); pageIndex++) {
		assertStoredQuoteScanActive(options.signal);
		const annots = safeDictionaryArray(pdfDoc.getPage(pageIndex).node, PDFName.of('Annots'));
		if (annots) {
			const pageQuotes: (string | null)[] = [];
			const quotes = new Map<string, StoredQuoteMetadata>();
			const ambiguousIds = new Set<string>();
			for (let i = 0; i < annots.size(); i++) {
				const ref = annots.get(i);
				const dict = context.lookup(ref, PDFDict);
				if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') continue;
				const quote = readNote(dict, QUOTE_KEY);
				const isRegion = dict.get(PDFName.of(REGION_KEY)) === PDFBool.True;
				pageQuotes.push(quote);
				const id = pdfJsAnnotationIdForRef(ref);
				if (!id) continue;
				if (ambiguousIds.has(id)) {
					const previous = quotes.get(id);
					quotes.set(id, { quote: null, isRegion: Boolean(previous?.isRegion || isRegion) });
					continue;
				}
				if (quotes.has(id)) {
					// Duplicate indirect memberships are malformed/ambiguous. Remove the
					// key so no other annotation can inherit this quote by accident.
					const previous = quotes.get(id);
					quotes.set(id, { quote: null, isRegion: Boolean(previous?.isRegion || isRegion) });
					ambiguousIds.add(id);
					continue;
				}
				quotes.set(id, {
					quote,
					isRegion,
				});
			}
			if (pageQuotes.length > 0) result.set(pageIndex, pageQuotes);
			if (quotes.size > 0) result.byAnnotationId.set(pageIndex, quotes);
		}
		if (pdfDoc.getPageCount() >= 64 && pageIndex % 4 === 3) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			assertStoredQuoteScanActive(options.signal);
		}
	}
	return result;
}

export interface HighlightTarget {
	pageIndex: number;
	objectNumber: number;
	generationNumber: number;
	/** SHA-256 of the exact PDF bytes from which this target was inspected. */
	sourceFingerprint: string;
	/** Exact /Rect and /QuadPoints geometry used to safely re-inspect after an
	 * unrelated PDF rewrite changes object numbers or the source fingerprint. */
	geometrySignature?: string;
}

/** Rebinds a stale target inside an already-loaded PDFDocument when the same
 * indirect reference remains a /Highlight with unchanged geometry on the same page. */
export function reinspectHighlightTargetInDoc(
	pdfDoc: PDFDocument,
	target: HighlightTarget,
	sourceFingerprint: string,
): HighlightTarget | null {
	if (!target.geometrySignature || !Number.isInteger(target.pageIndex) || target.pageIndex < 0) return null;
	if (target.pageIndex >= pdfDoc.getPageCount()) return null;
	const context = pdfDoc.context;
	const annots = safeDictionaryArray(pdfDoc.getPage(target.pageIndex).node, PDFName.of('Annots'));
	if (!annots) return null;
	const matches: HighlightTarget[] = [];
	for (let index = 0; index < annots.size(); index++) {
		const ref = annots.get(index);
		if (!(ref instanceof PDFRef)) continue;
		if (ref.objectNumber !== target.objectNumber || ref.generationNumber !== target.generationNumber) continue;
		const dict = safeContextDict(context, ref);
		if (dict?.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') continue;
		const geometry = readHighlightGeometry(context, ref);
		if (!geometry || geometrySignature(geometry) !== target.geometrySignature) continue;
		matches.push({
			pageIndex: target.pageIndex,
			objectNumber: ref.objectNumber,
			generationNumber: ref.generationNumber,
			sourceFingerprint,
			geometrySignature: target.geometrySignature,
		});
	}
	return matches.length === 1 ? matches[0]! : null;
}

/** Rebinds a stale target only when the same indirect reference remains a
 * /Highlight with unchanged geometry on the same page. Geometry alone is not
 * enough: a replacement annotation can occupy the same rectangle. */
export async function reinspectHighlightTarget(
	pdfBytes: Uint8Array,
	target: HighlightTarget,
): Promise<HighlightTarget | null> {
	if (!target.geometrySignature || !Number.isInteger(target.pageIndex) || target.pageIndex < 0) return null;
	const sourceFingerprint = await fingerprintPdfBytes(pdfBytes);
	const pdfDoc = await loadPdfDoc(pdfBytes);
	return reinspectHighlightTargetInDoc(pdfDoc, target, sourceFingerprint);
}

export interface SetHighlightColorOptions extends HighlightTarget {
	color: RgbColor;
}

function canonicalPdfValue(value: unknown): unknown {
	if (value instanceof PDFRef) return { ref: value.toString() };
	if (value instanceof PDFName) return { name: value.toString() };
	if (value instanceof PDFNumber) return { number: value.asNumber() };
	if (value instanceof PDFString) return { text: value.decodeText() };
	if (value instanceof PDFBool) return { boolean: value.asBoolean() };
	if (value instanceof PDFArray) return value.asArray().map(canonicalPdfValue);
	if (value instanceof PDFDict) {
		return value.entries()
			.map(([key, entry]) => [key.toString(), canonicalPdfValue(entry)])
			.sort(([keyA], [keyB]) => String(keyA).localeCompare(String(keyB)));
	}
	if (value instanceof PDFRawStream) return { stream: value.getContentsString(), dict: canonicalPdfValue(value.dict) };
	if (value === undefined) return null;
	if (value instanceof PDFObject) return value.toString();
	throw new Error('Study PDF: unsupported annotation metadata value.');
}

function metadataSignature(dict: PDFDict): string {
	return metadataSignatureExcept(dict, new Set(['/C', '/AP']));
}

function metadataSignatureExcept(dict: PDFDict, excludedKeys: ReadonlySet<string>): string {
	const entries = dict.entries()
		.filter(([key]) => !excludedKeys.has(key.toString()))
		.map(([key, value]) => [key.toString(), canonicalPdfValue(value)])
		.sort(([keyA], [keyB]) => String(keyA).localeCompare(String(keyB)));
	return JSON.stringify(entries);
}

function pageAnnotationOrder(pdfDoc: PDFDocument): string[] {
	const annotsKey = PDFName.of('Annots');
	return pdfDoc.getPages().map((page) => {
		if (page.node.get(annotsKey) === undefined) return '[]';
		const annots = safeDictionaryArray(page.node, annotsKey);
		return JSON.stringify(annots ? annots.asArray().map((value) => canonicalPdfValue(value)) : []);
	});
}

function encodeAppearanceContent(content: string): Uint8Array {
	return Uint8Array.from(content, (character) => character.charCodeAt(0));
}

function sameRef(a: PDFRef, b: PDFRef): boolean {
	return a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber;
}

/** Check only stored PDF values; following refs would hide the ref edge we are
 * looking for and could walk unrelated parts of a cyclic object graph. */
function valueContainsRef(value: unknown, target: PDFRef, visited: Set<object>): boolean {
	if (value instanceof PDFRef) return sameRef(value, target);
	if (!value || typeof value !== 'object' || visited.has(value)) return false;
	visited.add(value);
	if (value instanceof PDFArray) return value.asArray().some((child) => valueContainsRef(child, target, visited));
	if (value instanceof PDFDict) return value.entries().some(([, child]) => valueContainsRef(child, target, visited));
	if (value instanceof PDFRawStream) return valueContainsRef(value.dict, target, visited);
	return false;
}

function isReferencedOutsideObject(context: PDFContext, target: PDFRef): boolean {
	const visited = new Set<object>();
	for (const [rootRef, root] of context.enumerateIndirectObjects()) {
		if (sameRef(rootRef, target)) continue;
		if (valueContainsRef(root, target, visited)) return true;
	}
	return false;
}

function recolorAppearanceStream(
	context: PDFContext,
	appearance: AppearanceCheck,
	quadPoints: number[],
	box: PdfBox,
	color: RgbColor,
): PDFRawStream {
	const originalStream = appearance.stream!;
	const streamDict = originalStream.dict.clone(context);

	// Rebuild these three nested resource dictionaries before attaching the new
	// stream, because third-party PDFs sometimes share them across annotations.
	const resourceValue = streamDict.get(PDFName.of('Resources'))!;
	const resources = context.lookupMaybe(resourceValue, PDFDict)!.clone(context);
	const extValue = resources.get(PDFName.of('ExtGState'))!;
	const ext = context.lookupMaybe(extValue, PDFDict)!.clone(context);
	const gsValue = ext.get(PDFName.of('GS0'))!;
	const gs = context.lookupMaybe(gsValue, PDFDict)!.clone(context);
	ext.set(PDFName.of('GS0'), gs);
	resources.set(PDFName.of('ExtGState'), ext);
	streamDict.set(PDFName.of('Resources'), resources);

	const content = appearance.style === 'legacy-rectangles'
		? buildLegacyAppearanceStreamContent(quadPoints, box, color)
		: buildAppearanceStreamContent(quadPoints, box, color);
	const encoded = encodeAppearanceContent(content);
	streamDict.set(PDFName.of('Length'), PDFNumber.of(encoded.length));
	return PDFRawStream.of(streamDict, encoded);
}

function replaceNormalAppearance(
	context: PDFContext,
	dict: PDFDict,
	appearance: AppearanceCheck,
	stream: PDFRawStream,
	pruneUnreferenced = true,
): PDFDict {
	const originalAppearanceRef = appearance.appearanceValue instanceof PDFRef ? appearance.appearanceValue : null;
	const originalStreamRef = appearance.normalValue instanceof PDFRef ? appearance.normalValue : null;
	const apClone = appearance.appearanceDict!.clone(context);
	apClone.set(PDFName.of('N'), context.register(stream));
	// Store the cloned AP dictionary directly. This preserves any shared AP for
	// other annotations and avoids leaving one new indirect AP dictionary per
	// recolor in the document.
	dict.set(PDFName.of('AP'), apClone);
	if (pruneUnreferenced) {
		if (originalAppearanceRef && !isReferencedOutsideObject(context, originalAppearanceRef)) context.delete(originalAppearanceRef);
		if (originalStreamRef && !isReferencedOutsideObject(context, originalStreamRef)) context.delete(originalStreamRef);
	}
	return apClone;
}

export interface DocHighlightTarget {
	pageIndex: number;
	objectNumber: number;
	generationNumber: number;
	geometrySignature?: string;
}

/** Recolors one exact indirect /Highlight annotation inside an open PDFDocument without pruning
 * old appearance refs (so undo remains O(1) and lossless). */
export function recolorHighlightInDoc(
	pdfDoc: PDFDocument,
	baseSnapshot: DocumentSnapshot | null,
	options: DocHighlightTarget & { color: RgbColor },
): { updatedCount: number; patches: PdfObjectUndoPatch[] } {
	const { pageIndex, objectNumber, generationNumber, color } = options;
	if (!Number.isInteger(pageIndex) || pageIndex < 0 || !Number.isInteger(objectNumber) || objectNumber < 1 ||
		!Number.isInteger(generationNumber) || generationNumber < 0) {
		throw new Error('Study PDF: invalid highlight target reference.');
	}
	if (!color || !isValidRgbColor(color)) throw new Error('Study PDF: highlight color must contain finite RGB channels between 0 and 1.');
	if (pageIndex >= pdfDoc.getPageCount()) throw new Error('Study PDF: highlight target page does not exist.');
	const context = pdfDoc.context;
	const page = pdfDoc.getPage(pageIndex);
	const annots = safeDictionaryArray(page.node, PDFName.of('Annots'));
	if (!annots) throw new Error('Study PDF: highlight target annotation was not found on that page.');
	let targetRef: PDFRef | null = null;
	for (let i = 0; i < annots.size(); i++) {
		const candidate = annots.get(i);
		if (candidate instanceof PDFRef && candidate.objectNumber === objectNumber && candidate.generationNumber === generationNumber) {
			if (targetRef) throw new Error('Study PDF: highlight target reference is ambiguous on that page.');
			targetRef = candidate;
		}
	}
	if (!targetRef) throw new Error('Study PDF: exact highlight target reference is missing from that page.');
	const dict = context.lookup(targetRef, PDFDict);
	if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') throw new Error('Study PDF: target annotation is not a /Highlight.');
	const geometry = readHighlightGeometry(context, targetRef);
	if (!geometry) throw new Error('Study PDF: highlight target has no usable /Rect geometry.');
	if (geometry.invalidReason) throw new Error(`Study PDF: ${geometry.invalidReason}`);
	if (options.geometrySignature && geometrySignature(geometry) !== options.geometrySignature) {
		throw new Error('Study PDF: the selected annotation geometry changed. Inspect the current highlight before retrying.');
	}
	const quadPoints = readQuadPoints(context, dict);
	if (!quadPoints) throw new Error('Study PDF: highlight target has malformed /QuadPoints.');
	const currentColor = readRgbColor(context, dict);
	if (!currentColor) throw new Error('Study PDF: highlight target has no valid /C RGB color.');
	const appearance = checkRecolorAppearance(context, dict, geometry, quadPoints, currentColor);
	const replacementOpacity = appearance.filteredReplacementOpacity;
	if (appearance.reason && replacementOpacity === undefined) throw new Error(`Study PDF: ${appearance.reason}`);
	if (sameColor(currentColor, color)) {
		return { updatedCount: 0, patches: [] };
	}
	if (replacementOpacity !== undefined && pdfDoc.getPages().some((otherPage, index) =>
		index !== pageIndex && safeDictionaryArray(otherPage.node, PDFName.of('Annots'))?.asArray()
			.some((value) => value instanceof PDFRef && sameRef(value, targetRef)),
	)) {
		throw new Error('Study PDF: this highlight reference is shared across pages.');
	}

	const resolvedRef = targetRef;
	return withExplicitSnapshotTracking(pdfDoc, baseSnapshot, () => {
		const prevC = dict.get(PDFName.of('C'));
		const prevAP = dict.get(PDFName.of('AP'));
		const stream = replacementOpacity === undefined
			? recolorAppearanceStream(context, appearance, quadPoints, geometry.box, color)
			: createHighlightAppearance(context, quadPoints, geometry.box, color, replacementOpacity);
		const nextC = context.obj([color.r, color.g, color.b]);
		dict.set(PDFName.of('C'), nextC);
		const nextAP = replaceNormalAppearance(context, dict, appearance, stream, false);
		return {
			result: {
				updatedCount: 1,
				patches: [{ kind: 'recolor', pageIndex, targetRef: resolvedRef, dict, prevC, nextC, prevAP, nextAP }],
			},
			dirtyRefs: [resolvedRef],
		};
	});
}

/** Recolors one exact, indirect /Highlight annotation. Rebuilds a filtered
 * normal form from verified geometry when needed. */
export async function setHighlightColorAt(
	pdfBytes: Uint8Array,
	options: SetHighlightColorOptions,
): Promise<{ bytes: Uint8Array; updatedCount: number; target: HighlightTarget }> {
	const { pageIndex, objectNumber, generationNumber, sourceFingerprint, color } = options;
	if (!Number.isInteger(pageIndex) || pageIndex < 0 || !Number.isInteger(objectNumber) || objectNumber < 1 ||
		!Number.isInteger(generationNumber) || generationNumber < 0) {
		throw new Error('Study PDF: invalid highlight target reference.');
	}
	if (typeof sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(sourceFingerprint)) throw new Error('Study PDF: invalid highlight target document identity.');
	if (!color || !isValidRgbColor(color)) throw new Error('Study PDF: highlight color must contain finite RGB channels between 0 and 1.');
	const actualFingerprint = await fingerprintPdfBytes(pdfBytes);
	if (actualFingerprint !== sourceFingerprint) throw new Error('Study PDF: highlight target belongs to a different PDF or an earlier saved version. Inspect the current PDF again before recoloring.');
	const pdfDoc = await loadPdfDoc(pdfBytes);
	if (pageIndex >= pdfDoc.getPageCount()) throw new Error('Study PDF: highlight target page does not exist.');
	const context = pdfDoc.context;
	const page = pdfDoc.getPage(pageIndex);
	const annots = safeDictionaryArray(page.node, PDFName.of('Annots'));
	if (!annots) throw new Error('Study PDF: highlight target annotation was not found on that page.');
	let targetRef: PDFRef | null = null;
	let targetIndex = -1;
	for (let i = 0; i < annots.size(); i++) {
		const candidate = annots.get(i);
		if (candidate instanceof PDFRef && candidate.objectNumber === objectNumber && candidate.generationNumber === generationNumber) {
			if (targetRef) throw new Error('Study PDF: highlight target reference is ambiguous on that page.');
			targetRef = candidate;
			targetIndex = i;
		}
	}
	if (!targetRef) throw new Error('Study PDF: exact highlight target reference is missing from that page.');
	const dict = context.lookup(targetRef, PDFDict);
	if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') throw new Error('Study PDF: target annotation is not a /Highlight.');
	const geometry = readHighlightGeometry(context, targetRef);
	if (!geometry) throw new Error('Study PDF: highlight target has no usable /Rect geometry.');
	if (geometry.invalidReason) throw new Error(`Study PDF: ${geometry.invalidReason}`);
	const quadPoints = readQuadPoints(context, dict);
	if (!quadPoints) throw new Error('Study PDF: highlight target has malformed /QuadPoints.');
	const currentColor = readRgbColor(context, dict);
	if (!currentColor) throw new Error('Study PDF: highlight target has no valid /C RGB color.');
	const appearance = checkRecolorAppearance(context, dict, geometry, quadPoints, currentColor);
	const replacementOpacity = appearance.filteredReplacementOpacity;
	if (appearance.reason && replacementOpacity === undefined) throw new Error(`Study PDF: ${appearance.reason}`);
	if (sameColor(currentColor, color)) {
		return { bytes: pdfBytes, updatedCount: 0, target: { pageIndex, objectNumber, generationNumber, sourceFingerprint } };
	}
	if (replacementOpacity !== undefined && pdfDoc.getPages().some((otherPage, index) =>
		index !== pageIndex && safeDictionaryArray(otherPage.node, PDFName.of('Annots'))?.asArray()
			.some((value) => value instanceof PDFRef && sameRef(value, targetRef)),
	)) {
		throw new Error('Study PDF: this highlight reference is shared across pages.');
	}

	const expectedGraphicsState = replacementOpacity === undefined ? appearance.graphicsState! : { ca: replacementOpacity, blendMode: '/Multiply' };
	const expectedAppearanceStyle = replacementOpacity === undefined ? appearance.style : 'polygon';
	const expectedPageCount = pdfDoc.getPageCount();
	const expectedOrder = pageAnnotationOrder(pdfDoc);
	const expectedMetadata = metadataSignature(dict);
	const stream = replacementOpacity === undefined
		? recolorAppearanceStream(context, appearance, quadPoints, geometry.box, color)
		: createHighlightAppearance(context, quadPoints, geometry.box, color, replacementOpacity);
	dict.set(PDFName.of('C'), context.obj([color.r, color.g, color.b]));
	replaceNormalAppearance(context, dict, appearance, stream);
	const savedBytes = await savePdfDoc(pdfDoc, pdfBytes);
	const verifyDoc = await PDFDocument.load(savedBytes, parseOptionsForBytes(savedBytes));
	if (verifyDoc.getPageCount() !== expectedPageCount) throw new Error('Study PDF: page count changed while recoloring; aborting the save.');
	if (JSON.stringify(pageAnnotationOrder(verifyDoc)) !== JSON.stringify(expectedOrder)) {
		throw new Error('Study PDF: annotation counts, order, or identities changed while recoloring; aborting the save.');
	}
	const verifyAnnots = safeDictionaryArray(verifyDoc.getPage(pageIndex).node, PDFName.of('Annots'));
	const verifyTarget = verifyAnnots?.asArray().find((value) => value instanceof PDFRef && value.objectNumber === objectNumber && value.generationNumber === generationNumber);
	if (!(verifyTarget instanceof PDFRef)) throw new Error('Study PDF: saved highlight identity is missing; aborting the save.');
	const verifyDict = verifyDoc.context.lookup(verifyTarget, PDFDict);
	if (verifyDict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight' || metadataSignature(verifyDict) !== expectedMetadata) {
		throw new Error('Study PDF: saved highlight metadata changed while recoloring; aborting the save.');
	}
	const savedGeometry = readHighlightGeometry(verifyDoc.context, verifyTarget);
	const savedQuads = readQuadPoints(verifyDoc.context, verifyDict);
	if (!savedGeometry || savedGeometry.invalidReason || !savedQuads || !sameColor(readRgbColor(verifyDoc.context, verifyDict), color)) {
		throw new Error('Study PDF: saved highlight color or geometry did not verify; aborting the save.');
	}
	const savedAppearance = checkRecolorAppearance(verifyDoc.context, verifyDict, savedGeometry, savedQuads, color);
	if (savedAppearance.reason) throw new Error(`Study PDF: saved appearance did not verify (${savedAppearance.reason}); aborting the save.`);
	if (savedAppearance.style !== expectedAppearanceStyle) throw new Error('Study PDF: saved appearance geometry style changed while recoloring; aborting the save.');
	if (!savedAppearance.graphicsState || savedAppearance.graphicsState.ca !== expectedGraphicsState.ca || savedAppearance.graphicsState.blendMode !== expectedGraphicsState.blendMode) {
		throw new Error('Study PDF: saved appearance opacity or blend mode changed while recoloring; aborting the save.');
	}
	if (verifyAnnots!.asArray().findIndex((value) => value instanceof PDFRef && value.objectNumber === objectNumber && value.generationNumber === generationNumber) !== targetIndex) {
		throw new Error('Study PDF: saved highlight order changed while recoloring; aborting the save.');
	}
	const refreshedFingerprint = await fingerprintPdfBytes(savedBytes);
	await rememberVerifiedHighlightState(savedBytes, verifyDoc, refreshedFingerprint, {
		sourceBytes: pdfBytes,
		sourceFingerprint,
		changedPageIndexes: [pageIndex],
		mutatedRef: targetRef,
	});
	return {
		bytes: savedBytes,
		updatedCount: 1,
		target: { pageIndex, objectNumber, generationNumber, sourceFingerprint: refreshedFingerprint },
	};
}

interface TargetAnnotationLocation {
	pdfDoc: PDFDocument;
	page: ReturnType<PDFDocument['getPage']>;
	context: PDFContext;
	annots: PDFArray;
	annotationIndex: number;
	ref: PDFRef;
	dict: PDFDict;
}

/** Adds a standard PDF sticky note into an open PDFDocument with explicit snapshot tracking. */
export function addPageNoteToDoc(
	doc: PDFDocument,
	baseSnapshot: DocumentSnapshot | null,
	{ pageIndex, point, note }: { pageIndex: number; point: PdfPoint; note: string },
): { addedRef: PDFRef; patches: PdfObjectUndoPatch[] } {
	const contents = note.trim();
	if (!contents || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
		throw new Error('Study PDF: a page note needs text and a valid page location.');
	}
	const pageCount = doc.getPageCount();
	if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
		throw new Error('Study PDF: the note page does not exist.');
	}
	const page = doc.getPage(pageIndex);
	const key = PDFName.of('Annots');
	const prevAnnots = page.node.get(key);
	const existing = safeDictionaryArray(page.node, key);
	if (prevAnnots !== undefined && !existing) {
		throw new Error('Study PDF: the page has an unreadable /Annots array.');
	}
	const { x, y, width, height } = page.getCropBox();
	if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
		throw new Error('Study PDF: the note page has invalid bounds.');
	}
	const size = Math.min(22, width, height);
	const left = Math.max(x, Math.min(point.x - size / 2, x + width - size));
	const bottom = Math.max(y, Math.min(point.y - size / 2, y + height - size));
	const rect = [left, bottom, left + size, bottom + size];

	return withExplicitSnapshotTracking(doc, baseSnapshot, () => {
		const ref = doc.context.register(doc.context.obj({
			Type: 'Annot', Subtype: 'Text', Name: 'Comment', Rect: rect,
			Contents: PDFHexString.fromText(contents), C: [1, 0.85, 0.35], Open: false, F: 4,
		}));
		const annots = PDFArray.withContext(doc.context);
		for (const item of existing?.asArray() ?? []) annots.push(item);
		annots.push(ref);
		page.node.set(key, annots);
		return {
			result: {
				addedRef: ref,
				patches: [{ kind: 'annots', pageIndex, pageRef: page.ref, prevAnnots, nextAnnots: annots }],
			},
			dirtyRefs: [page.ref],
		};
	});
}

function findExactHighlightLocationInDoc(
	pdfDoc: PDFDocument,
	target: DocHighlightTarget,
): TargetAnnotationLocation {
	const { pageIndex, objectNumber, generationNumber } = target;
	if (!Number.isInteger(pageIndex) || pageIndex < 0 || !Number.isInteger(objectNumber) || objectNumber < 1 ||
		!Number.isInteger(generationNumber) || generationNumber < 0) {
		throw new Error('Study PDF: invalid highlight target reference.');
	}
	if (pageIndex >= pdfDoc.getPageCount()) throw new Error('Study PDF: highlight target page does not exist.');
	const page = pdfDoc.getPage(pageIndex);
	const context = pdfDoc.context;
	const annots = safeDictionaryArray(page.node, PDFName.of('Annots'));
	if (!annots) throw new Error('Study PDF: highlight target annotation was not found on that page.');
	let ref: PDFRef | null = null;
	let annotationIndex = -1;
	for (let index = 0; index < annots.size(); index++) {
		const candidate = annots.get(index);
		if (candidate instanceof PDFRef && candidate.objectNumber === objectNumber && candidate.generationNumber === generationNumber) {
			if (ref) throw new Error('Study PDF: exact highlight target reference is duplicated or ambiguous on that page.');
			ref = candidate;
			annotationIndex = index;
		}
	}
	if (!ref) throw new Error('Study PDF: exact highlight target reference is missing from that page.');
	const dict = context.lookup(ref, PDFDict);
	if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') {
		throw new Error('Study PDF: target annotation is not a /Highlight.');
	}
	if (target.geometrySignature) {
		const geometry = readHighlightGeometry(context, ref);
		if (!geometry || geometrySignature(geometry) !== target.geometrySignature) {
			throw new Error('Study PDF: the selected annotation geometry changed. Inspect the current highlight before retrying.');
		}
	}
	return { pdfDoc, page, context, annots, annotationIndex, ref, dict };
}

/** Sets /Contents on an exact indirect /Highlight annotation inside an open PDFDocument. */
export function setHighlightNoteInDoc(
	pdfDoc: PDFDocument,
	baseSnapshot: DocumentSnapshot | null,
	options: DocHighlightTarget & { note: string },
): { updatedCount: number; patches: PdfObjectUndoPatch[] } {
	const { note, ...target } = options;
	if (typeof note !== 'string') throw new Error('Study PDF: highlight note must be text.');
	const trimmed = note.trim();
	const location = findExactHighlightLocationInDoc(pdfDoc, target);
	const contentsKey = PDFName.of('Contents');
	const rcKey = PDFName.of('RC');
	const prevContents = location.dict.get(contentsKey);
	const prevRC = location.dict.get(rcKey);
	const currentNote = readNote(location.dict);
	if (prevRC === undefined && ((trimmed && currentNote === trimmed) || (!trimmed && prevContents === undefined))) {
		return { updatedCount: 0, patches: [] };
	}

	return withExplicitSnapshotTracking(pdfDoc, baseSnapshot, () => {
		const nextContents = trimmed ? PDFHexString.fromText(trimmed) : undefined;
		if (nextContents) location.dict.set(contentsKey, nextContents);
		else location.dict.delete(contentsKey);
		location.dict.delete(rcKey);
		return {
			result: {
				updatedCount: 1,
				patches: [{
					kind: 'note',
					pageIndex: target.pageIndex,
					targetRef: location.ref,
					dict: location.dict,
					prevContents,
					nextContents,
					prevRC,
				}],
			},
			dirtyRefs: [location.ref],
		};
	});
}

/** Removes one exact indirect /Highlight membership from its page /Annots inside an open PDFDocument. */
export function removeHighlightInDoc(
	pdfDoc: PDFDocument,
	baseSnapshot: DocumentSnapshot | null,
	target: DocHighlightTarget,
): { removedCount: number; removedRef: PDFRef; patches: PdfObjectUndoPatch[] } {
	const location = findExactHighlightLocationInDoc(pdfDoc, target);
	const annotsKey = PDFName.of('Annots');
	const prevAnnots = location.page.node.get(annotsKey);
	return withExplicitSnapshotTracking(pdfDoc, baseSnapshot, () => {
		const nextAnnots = PDFArray.withContext(location.context);
		for (let index = 0; index < location.annots.size(); index++) {
			if (index !== location.annotationIndex) nextAnnots.push(location.annots.get(index));
		}
		location.page.node.set(annotsKey, nextAnnots);
		return {
			result: {
				removedCount: 1,
				removedRef: location.ref,
				patches: [{
					kind: 'annots',
					pageIndex: target.pageIndex,
					pageRef: location.page.ref,
					prevAnnots,
					nextAnnots,
				}],
			},
			dirtyRefs: [location.page.ref],
		};
	});
}

/** Add a standard PDF sticky note at a point on the displayed page. */
export async function addPageNote(
	pdfBytes: Uint8Array,
	{ pageIndex, point, note }: { pageIndex: number; point: PdfPoint; note: string },
): Promise<Uint8Array> {
	const contents = note.trim();
	if (!contents || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
		throw new Error('Study PDF: a page note needs text and a valid page location.');
	}
	const doc = await loadPdfDoc(pdfBytes);
	const pageCount = doc.getPageCount();
	if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
		throw new Error('Study PDF: the note page does not exist.');
	}
	const page = doc.getPage(pageIndex);
	const key = PDFName.of('Annots');
	const existing = safeDictionaryArray(page.node, key);
	if (page.node.get(key) !== undefined && !existing) {
		throw new Error('Study PDF: the page has an unreadable /Annots array.');
	}
	const { x, y, width, height } = page.getCropBox();
	if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
		throw new Error('Study PDF: the note page has invalid bounds.');
	}
	// PDF.js normalizes Text annotation icons to a 22-point square.
	const size = Math.min(22, width, height);
	const left = Math.max(x, Math.min(point.x - size / 2, x + width - size));
	const bottom = Math.max(y, Math.min(point.y - size / 2, y + height - size));
	const rect = [left, bottom, left + size, bottom + size];
	const ref = doc.context.register(doc.context.obj({
		Type: 'Annot', Subtype: 'Text', Name: 'Comment', Rect: rect,
		Contents: PDFHexString.fromText(contents), C: [1, 0.85, 0.35], Open: false, F: 4,
	}));
	const annots = PDFArray.withContext(doc.context);
	for (const item of existing?.asArray() ?? []) annots.push(item);
	annots.push(ref);
	page.node.set(key, annots);
	const order = pageAnnotationOrder(doc);
	const saved = await savePdfDoc(doc, pdfBytes);
	const verified = await verifySavedBytes(saved, pageCount, pageIndex, annots.size());
	const dict = safeContextDict(verified.context, ref);
	if (JSON.stringify(pageAnnotationOrder(verified)) !== JSON.stringify(order) || !dict ||
		dict.get(PDFName.of('Subtype'))?.toString() !== '/Text' || readNote(dict) !== contents ||
		!numericArrayMatches(verified.context, dict.get(PDFName.of('Rect')), rect)) {
		throw new Error('Study PDF: the saved page note or annotation order could not be verified.');
	}
	const fingerprint = await fingerprintPdfBytes(saved);
	await rememberVerifiedHighlightState(saved, verified, fingerprint, {
		sourceBytes: pdfBytes,
		changedPageIndexes: [pageIndex],
	});
	return saved;
}

async function loadExactHighlightTarget(
	pdfBytes: Uint8Array,
	target: HighlightTarget,
): Promise<TargetAnnotationLocation> {
	const { pageIndex, objectNumber, generationNumber, sourceFingerprint } = target;
	if (!Number.isInteger(pageIndex) || pageIndex < 0 || !Number.isInteger(objectNumber) || objectNumber < 1 ||
		!Number.isInteger(generationNumber) || generationNumber < 0) {
		throw new Error('Study PDF: invalid highlight target reference.');
	}
	if (typeof sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(sourceFingerprint)) {
		throw new Error('Study PDF: invalid highlight target document identity.');
	}
	if (await fingerprintPdfBytes(pdfBytes) !== sourceFingerprint) {
		throw new Error('Study PDF: highlight target belongs to a different PDF or an earlier saved version. Inspect the current PDF again before changing it.');
	}
	const pdfDoc = await loadPdfDoc(pdfBytes);
	if (pageIndex >= pdfDoc.getPageCount()) throw new Error('Study PDF: highlight target page does not exist.');
	const page = pdfDoc.getPage(pageIndex);
	const context = pdfDoc.context;
	const annots = safeDictionaryArray(page.node, PDFName.of('Annots'));
	if (!annots) throw new Error('Study PDF: highlight target annotation was not found on that page.');
	let ref: PDFRef | null = null;
	let annotationIndex = -1;
	for (let index = 0; index < annots.size(); index++) {
		const candidate = annots.get(index);
		if (candidate instanceof PDFRef && candidate.objectNumber === objectNumber && candidate.generationNumber === generationNumber) {
			if (ref) throw new Error('Study PDF: exact highlight target reference is duplicated or ambiguous on that page.');
			ref = candidate;
			annotationIndex = index;
		}
	}
	if (!ref) throw new Error('Study PDF: exact highlight target reference is missing from that page.');
	const dict = context.lookup(ref, PDFDict);
	if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight') {
		throw new Error('Study PDF: target annotation is not a /Highlight.');
	}
	if (target.geometrySignature) {
		const geometry = readHighlightGeometry(context, ref);
		if (!geometry || geometrySignature(geometry) !== target.geometrySignature) {
			throw new Error('Study PDF: the selected annotation geometry changed. Inspect the current highlight before retrying.');
		}
	}
	return { pdfDoc, page, context, annots, annotationIndex, ref, dict };
}

/** Sets /Contents on the exact highlighted annotation inspected by the caller.
 * The source fingerprint, page, indirect reference, subtype, and unique Annots
 * membership are all revalidated against the bytes passed to this function. */
export async function setHighlightNoteForTarget(
	pdfBytes: Uint8Array,
	options: HighlightTarget & { note: string },
): Promise<{ bytes: Uint8Array; updatedCount: number; target: HighlightTarget }> {
	const { note, ...target } = options;
	if (typeof note !== 'string') throw new Error('Study PDF: highlight note must be text.');
	const trimmed = note.trim();
	const location = await loadExactHighlightTarget(pdfBytes, target);
	const hasContents = location.dict.get(PDFName.of('Contents')) !== undefined;
	const hasRichText = location.dict.get(PDFName.of('RC')) !== undefined;
	const currentNote = readNote(location.dict);
	if (!hasRichText && ((trimmed && currentNote === trimmed) || (!trimmed && !hasContents))) {
		return { bytes: pdfBytes, updatedCount: 0, target };
	}

	const expectedPageCount = location.pdfDoc.getPageCount();
	const expectedOrder = pageAnnotationOrder(location.pdfDoc);
	const changedFields = new Set(['/Contents', '/RC']);
	const expectedMetadata = metadataSignatureExcept(location.dict, changedFields);
	if (trimmed) location.dict.set(PDFName.of('Contents'), PDFHexString.fromText(trimmed));
	else location.dict.delete(PDFName.of('Contents'));
	// Our editor writes plain text. Leaving imported rich text behind can make
	// another reader show the old comment after a replacement or deletion.
	location.dict.delete(PDFName.of('RC'));

	const savedBytes = await savePdfDoc(location.pdfDoc, pdfBytes);
	const verifyDoc = await PDFDocument.load(savedBytes, parseOptionsForBytes(savedBytes));
	if (verifyDoc.getPageCount() !== expectedPageCount ||
		JSON.stringify(pageAnnotationOrder(verifyDoc)) !== JSON.stringify(expectedOrder)) {
		throw new Error('Study PDF: saved annotation order or document structure changed while setting the note.');
	}
	const verifyAnnots = safeDictionaryArray(verifyDoc.getPage(target.pageIndex).node, PDFName.of('Annots'));
	const verifyRef = verifyAnnots?.get(location.annotationIndex);
	if (!(verifyRef instanceof PDFRef) || !sameRef(verifyRef, location.ref)) {
		throw new Error('Study PDF: saved highlight identity changed while setting the note.');
	}
	const verifyDict = verifyDoc.context.lookup(verifyRef, PDFDict);
	if (verifyDict.get(PDFName.of('Subtype'))?.toString() !== '/Highlight' ||
		metadataSignatureExcept(verifyDict, changedFields) !== expectedMetadata ||
		verifyDict.get(PDFName.of('RC')) !== undefined ||
		(trimmed ? readNote(verifyDict) !== trimmed : verifyDict.get(PDFName.of('Contents')) !== undefined)) {
		throw new Error('Study PDF: saved highlight note or preserved metadata did not verify.');
	}
	const refreshedFingerprint = await fingerprintPdfBytes(savedBytes);
	await rememberVerifiedHighlightState(savedBytes, verifyDoc, refreshedFingerprint, {
		sourceBytes: pdfBytes,
		sourceFingerprint: target.sourceFingerprint,
		changedPageIndexes: [target.pageIndex],
		mutatedRef: location.ref,
	});
	return {
		bytes: savedBytes,
		updatedCount: 1,
		target: { ...target, sourceFingerprint: refreshedFingerprint },
	};
}

/** Removes exactly one uniquely referenced /Annots membership for a highlight.
 * The annotation object and any Popup/object graph are left untouched. */
export async function removeHighlightForTarget(
	pdfBytes: Uint8Array,
	target: HighlightTarget,
): Promise<{ bytes: Uint8Array; removedCount: number }> {
	const location = await loadExactHighlightTarget(pdfBytes, target);
	const expectedPageCount = location.pdfDoc.getPageCount();
	const expectedOrder = pageAnnotationOrder(location.pdfDoc);
	const expectedPageOrder = JSON.parse(expectedOrder[target.pageIndex]!) as unknown[];
	expectedPageOrder.splice(location.annotationIndex, 1);
	expectedOrder[target.pageIndex] = JSON.stringify(expectedPageOrder);
	const kept: ReturnType<PDFArray['get']>[] = [];
	for (let index = 0; index < location.annots.size(); index++) {
		if (index !== location.annotationIndex) kept.push(location.annots.get(index));
	}
	const nextAnnots = PDFArray.withContext(location.context);
	for (const value of kept) nextAnnots.push(value);
	location.page.node.set(PDFName.of('Annots'), nextAnnots);

	const savedBytes = await savePdfDoc(location.pdfDoc, pdfBytes);
	const verifyDoc = await PDFDocument.load(savedBytes, parseOptionsForBytes(savedBytes));
	if (verifyDoc.getPageCount() !== expectedPageCount ||
		JSON.stringify(pageAnnotationOrder(verifyDoc)) !== JSON.stringify(expectedOrder)) {
		throw new Error('Study PDF: saved annotation order or document structure changed while removing the highlight.');
	}
	const fingerprint = await fingerprintPdfBytes(savedBytes);
	await rememberVerifiedHighlightState(savedBytes, verifyDoc, fingerprint, {
		sourceBytes: pdfBytes,
		sourceFingerprint: target.sourceFingerprint,
		changedPageIndexes: [target.pageIndex],
	});
	return { bytes: savedBytes, removedCount: 1 };
}
