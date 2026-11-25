import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFArray } from '@cantoo/pdf-lib';
import {
	detectIncrementalMode,
	loadPdfDocForSession,
	verifyIncrementalTail,
	type AddHighlightOptions,
} from '../src/annotate';
import { PdfSessionManager, type SessionFileLike } from '../src/pdf-working-session';
import { loadPdfjsDoc, makeFixturePdfBytes } from './helpers/pdf-fixture';

const YELLOW = { r: 1, g: 1, b: 0 };
const BLUE = { r: 0, g: 0.5, b: 1 };
const GREEN = { r: 0, g: 1, b: 0 };

function makeHighlight(pageIndex: number, y: number, color = YELLOW, quote = 'sample'): AddHighlightOptions {
	return {
		pageIndex,
		quadPoints: [40, y + 12, 160, y + 12, 40, y, 160, y],
		box: { left: 40, bottom: y, right: 160, top: y + 12 },
		color,
		quote,
	};
}

function createHarness(initialBytes: Uint8Array, options?: { debounceMs?: number; maxWaitMs?: number }) {
	let diskBytes = new Uint8Array(initialBytes);
	const file: SessionFileLike = { path: 'papers/test.pdf', stat: { mtime: 100, size: diskBytes.byteLength } };
	let current = true;
	const writes: Uint8Array[] = [];
	const conflicts: string[] = [];
	const visualSyncs: { flushRevision: number; pages: number[] }[] = [];

	const readBinary = vi.fn(async () => new Uint8Array(diskBytes));
	const writeBinary = vi.fn(async (_f: SessionFileLike, bytes: Uint8Array) => {
		writes.push(new Uint8Array(bytes));
		diskBytes = new Uint8Array(bytes);
		file.stat.mtime += 10;
		file.stat.size = diskBytes.byteLength;
	});

	const manager = new PdfSessionManager(
		{
			readBinary,
			writeBinary,
			isFileCurrent: () => current,
			onExternalConflict: (_f, _path, reason) => { conflicts.push(reason); },
			onVisualSynced: (_f, _path, flushRevision, pages) => { visualSyncs.push({ flushRevision, pages }); },
		},
		options ?? { debounceMs: 40, maxWaitMs: 200 },
	);

	return {
		file,
		manager,
		readBinary,
		writeBinary,
		writes,
		conflicts,
		visualSyncs,
		diskBytes: () => diskBytes,
		setDiskBytes: (bytes: Uint8Array) => {
			diskBytes = new Uint8Array(bytes);
			file.stat.mtime += 50;
			file.stat.size = diskBytes.byteLength;
		},
		setCurrent: (val: boolean) => { current = val; },
	};
}

describe('PdfSessionManager incremental saves, batching, conflicts, and undo/redo', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('detects classic-xref and xref-stream incremental modes and round-trips through pdf-lib and pdf.js', async () => {
		const classicDoc = await PDFDocument.create();
		classicDoc.addPage([400, 300]);
		const classicBytes = await classicDoc.save({ useObjectStreams: false });
		const classicLoaded = await loadPdfDocForSession(classicBytes);
		expect(classicLoaded.incrementalMode).toBe('classic-xref');

		const streamDoc = await PDFDocument.create();
		streamDoc.addPage([400, 300]);
		const streamBytes = await streamDoc.save({ useObjectStreams: true });
		const streamLoaded = await loadPdfDocForSession(streamBytes);
		expect(streamLoaded.incrementalMode).toBe('xref-stream');

		for (const baseBytes of [classicBytes, streamBytes]) {
			const h = createHarness(baseBytes, { debounceMs: 20, maxWaitMs: 100 });
			await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 200)] });
			await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 160, BLUE)] });
			await h.manager.flushNow(h.file.path);

			expect(h.writes).toHaveLength(1);
			// Incremental update appends a small tail rather than rewriting a growing whole file
			expect(h.diskBytes().subarray(0, baseBytes.byteLength)).toEqual(baseBytes);

			const reloaded = await PDFDocument.load(h.diskBytes());
			expect(reloaded.getPageCount()).toBe(1);
			expect(reloaded.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size()).toBe(2);

			const pj = await loadPdfjsDoc(h.diskBytes());
			const annots = await (await pj.getPage(1)).getAnnotations();
			expect(annots.filter((a: { subtype?: string }) => a.subtype === 'Highlight')).toHaveLength(2);
			h.manager.disposeAll();
		}
	});

	it('upgrades encrypted (empty-password) PDFs from full-rewrite on first flush to classic-xref incremental thereafter', async () => {
		const doc = await PDFDocument.create();
		doc.addPage([400, 300]);
		await doc.encrypt({ userPassword: '', ownerPassword: 'owner', permissions: { printing: 'highResolution' } });
		const encryptedBytes = await doc.save({ useObjectStreams: false });

		const loaded = await loadPdfDocForSession(encryptedBytes);
		expect(loaded.incrementalMode).toBe('full-rewrite');
		expect(detectIncrementalMode(encryptedBytes, loaded.pdfDoc, true)).toBe('full-rewrite');

		const h = createHarness(encryptedBytes, { debounceMs: 20, maxWaitMs: 100 });
		await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 200)] });
		await h.manager.flushNow(h.file.path);
		expect(h.writes).toHaveLength(1);

		const afterFirstFlush = h.diskBytes();
		await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 150, BLUE)] });
		await h.manager.flushNow(h.file.path);
		expect(h.writes).toHaveLength(2);
		// Second write appended incrementally onto the decrypted first flush!
		expect(h.diskBytes().subarray(0, afterFirstFlush.byteLength)).toEqual(afterFirstFlush);

		const pj = await loadPdfjsDoc(h.diskBytes());
		const annots = await (await pj.getPage(1)).getAnnotations();
		expect(annots.filter((a: { subtype?: string }) => a.subtype === 'Highlight')).toHaveLength(2);
		h.manager.disposeAll();
	});

	it('rejects malformed or truncated incremental tails in verifyIncrementalTail', () => {
		const base = new Uint8Array([1, 2, 3, 4]);
		const bad = new Uint8Array([1, 2, 3, 4, 65, 66, 67]);
		expect(() => verifyIncrementalTail(base, bad, 'classic-xref', 10)).toThrow(/missing a valid startxref/);
		const wrongPrev = new TextEncoder().encode('1234xref\n0 1\ntrailer << /Size 1 /Prev 99 >>\nstartxref\n4\n%%EOF\n');
		expect(() => verifyIncrementalTail(base, wrongPrev, 'classic-xref', 10)).toThrow(/expected \/Prev/);
	});

	it('batches rapid edits into a single disk write and keeps pending overlays up to date', async () => {
		const baseBytes = await makeFixturePdfBytes();
		const h = createHarness(baseBytes, { debounceMs: 50, maxWaitMs: 500 });

		// Warm session first
		await h.manager.getHighlightIndex(h.file);

		// 5 rapid highlights + recolor on pending highlight + note
		const r1 = await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 220)] });
		expect(r1.visualMode).toBe('overlay-only');
		expect(r1.pendingOverlays).toHaveLength(1);

		const firstTarget = r1.highlightIndex.get(0)![0]!.target!;
		const r2 = await h.manager.mutate(h.file, { kind: 'recolor', target: firstTarget, color: BLUE });
		// Pending highlight recolored purely in overlay without PDF.js canvas redraw!
		expect(r2.visualMode).toBe('overlay-only');
		expect(r2.pendingOverlays[0]!.colorCss).toBe('rgb(0, 128, 255)');

		await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 180, GREEN)] });
		await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 140)] });
		await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 100)] });

		// Not written to disk yet before debounce
		expect(h.writeBinary).not.toHaveBeenCalled();

		// Wait for debounce to fire once
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(h.writeBinary).toHaveBeenCalledTimes(1);
		expect(h.manager.isDirty(h.file.path)).toBe(false);
		expect(h.manager.getPendingOverlays(h.file.path)).toEqual([]);

		const pj = await loadPdfjsDoc(h.diskBytes());
		const annots = await (await pj.getPage(1)).getAnnotations();
		expect(annots.filter((a: { subtype?: string }) => a.subtype === 'Highlight')).toHaveLength(4);
		h.manager.disposeAll();
	});

	it('allows non-blocking edits while a disk flush is in flight and preserves newer overlays', async () => {
		const baseBytes = await makeFixturePdfBytes();
		const h = createHarness(baseBytes, { debounceMs: 25, maxWaitMs: 200 });

		let releaseWrite!: () => void;
		let writeStarted!: () => void;
		const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
		const startedPromise = new Promise<void>((resolve) => { writeStarted = resolve; });
		const origImpl = h.writeBinary.getMockImplementation()!;
		h.writeBinary.mockImplementationOnce(async (f, bytes, ctx) => {
			writeStarted();
			await writeGate;
			await origImpl(f, bytes, ctx);
		});

		await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 220)] });
		const flushPromise = h.manager.flushNow(h.file.path);
		await startedPromise;

		// Edit #2 arrives WHILE write #1 is blocked on disk I/O — must resolve immediately!
		const r2 = await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 150, BLUE)] });
		expect(r2.revision).toBe(2);
		expect(r2.pendingOverlays).toHaveLength(2);

		releaseWrite();
		await flushPromise;

		// Revision 1's overlay was cleared by write #1, while revision 2's overlay remains!
		expect(h.manager.getPendingOverlays(h.file.path).map((o) => o.revision)).toEqual([2]);
		expect(h.manager.isDirty(h.file.path)).toBe(true);

		// Follow-up debounce flushes revision 2 cleanly
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(h.writeBinary).toHaveBeenCalledTimes(2);
		expect(h.manager.isDirty(h.file.path)).toBe(false);
		expect(h.manager.getPendingOverlays(h.file.path)).toEqual([]);

		const reloaded = await PDFDocument.load(h.diskBytes());
		expect(reloaded.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size()).toBe(2);
		h.manager.disposeAll();
	});

	it('aborts flush without overwriting when external iCloud/iPad changes occurred on disk', async () => {
		const baseBytes = await makeFixturePdfBytes();
		const h = createHarness(baseBytes, { debounceMs: 20, maxWaitMs: 100 });

		await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 220)] });

		// Simulate another device editing the PDF on disk before flush
		const externalDoc = await PDFDocument.load(baseBytes);
		externalDoc.addPage([400, 300]);
		const externalBytes = await externalDoc.save();
		h.setDiskBytes(externalBytes);

		await h.manager.flushNow(h.file.path);

		expect(h.writeBinary).not.toHaveBeenCalled();
		expect(h.conflicts).toHaveLength(1);
		expect(h.diskBytes()).toEqual(externalBytes);
		expect(h.manager.hasSession(h.file.path)).toBe(false);
		h.manager.disposeAll();
	});

	it('supports O(1) object-level undo and redo across add, recolor, note, remove, and page note', async () => {
		const baseBytes = await makeFixturePdfBytes();
		const h = createHarness(baseBytes, { debounceMs: 50, maxWaitMs: 300 });

		const rAdd = await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 220)] });
		const target1 = rAdd.highlightIndex.get(0)![0]!.target!;

		const rRecolor = await h.manager.mutate(h.file, { kind: 'recolor', target: target1, color: BLUE });
		expect(rRecolor.highlightIndex.get(0)![0]!.currentColor).toEqual(BLUE);

		const target2 = rRecolor.highlightIndex.get(0)![0]!.target!;
		const rNote = await h.manager.mutate(h.file, { kind: 'set-note', target: target2, note: 'important' });
		expect(rNote.highlightIndex.get(0)![0]!.note).toBe('important');

		await h.manager.mutate(h.file, { kind: 'add-page-note', pageIndex: 0, point: { x: 50, y: 50 }, note: 'sticky' });
		expect(h.manager.historyStatus(h.file, h.file.path)).toEqual({ canUndo: true, canRedo: false });

		// Undo page note -> note -> recolor -> add
		const u1 = await h.manager.undoOrRedo(h.file, 'undo');
		expect(u1.status).toBe('applied');
		const u2 = await h.manager.undoOrRedo(h.file, 'undo');
		expect(u2.highlightIndex.get(0)![0]!.note).toBeNull();
		const u3 = await h.manager.undoOrRedo(h.file, 'undo');
		expect(u3.highlightIndex.get(0)![0]!.currentColor).toEqual(YELLOW);
		const u4 = await h.manager.undoOrRedo(h.file, 'undo');
		expect(u4.highlightIndex.get(0) ?? []).toHaveLength(0);
		expect(h.manager.historyStatus(h.file, h.file.path)).toEqual({ canUndo: false, canRedo: true });

		// Redo add + recolor + note
		await h.manager.undoOrRedo(h.file, 'redo');
		await h.manager.undoOrRedo(h.file, 'redo');
		const re3 = await h.manager.undoOrRedo(h.file, 'redo');
		expect(re3.highlightIndex.get(0)![0]!.currentColor).toEqual(BLUE);
		expect(re3.highlightIndex.get(0)![0]!.note).toBe('important');

		await h.manager.flushNow(h.file.path);
		const pj = await loadPdfjsDoc(h.diskBytes());
		const annots = (await (await pj.getPage(1)).getAnnotations()).filter((a: { subtype?: string }) => a.subtype === 'Highlight');
		expect(annots).toHaveLength(1);
		expect(annots[0].contentsObj?.str).toBe('important');
		expect(Array.from(annots[0].color)).toEqual([0, 128, 255]);
		h.manager.disposeAll();
	});

	it('flushes dirty sessions when their tab closes or flushAllDirty is called, and handles external modify events', async () => {
		const baseBytes = await makeFixturePdfBytes();
		const h = createHarness(baseBytes, { debounceMs: 5000, maxWaitMs: 10000 });

		await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 220)] });
		// Closing tab flushes immediately without waiting 5s debounce
		await h.manager.flushClosedSessions(new Set());
		expect(h.writeBinary).toHaveBeenCalledTimes(1);
		expect(h.manager.isDirty(h.file.path)).toBe(false);

		// Own-write grace window prevents self-eviction
		expect(h.manager.onExternalModify(h.file.path)).toBe(false);
		expect(h.manager.hasSession(h.file.path)).toBe(true);

		// Another edit + flushAllDirty
		await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 180)] });
		await h.manager.flushAllDirty();
		expect(h.writeBinary).toHaveBeenCalledTimes(2);
		h.manager.disposeAll();
	});

	it('upgrades set-note to memory-canvas-refresh when pending highlights share the page', async () => {
		const baseBytes = await makeFixturePdfBytes();
		const h = createHarness(baseBytes, { debounceMs: 5000, maxWaitMs: 10000 });

		// Add pending highlight (not flushed yet) -> set note on it
		const r1 = await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 220)] });
		const target = r1.highlightIndex.get(0)![0]!.target!;
		const rNote = await h.manager.mutate(h.file, { kind: 'set-note', target, note: 'keep highlight visible' });
		expect(rNote.visualMode).toBe('memory-canvas-refresh');
		expect(rNote.pendingOverlays).toHaveLength(1);

		// Confirming visual refresh clears pending overlays up to revision 2
		const remaining = h.manager.confirmVisualRefresh(h.file.path, rNote.changedPageIndexes, rNote.revision);
		expect(remaining).toEqual([]);
		h.manager.disposeAll();
	});

	it('keeps pending overlays and forces flush refresh until confirmVisualRefresh is called', async () => {
		const baseBytes = await makeFixturePdfBytes();
		let lastWriteCtx: { alreadyVisuallyRefreshed: boolean; pagesToRefresh: number[] } | null = null;
		const h = createHarness(baseBytes, { debounceMs: 5000, maxWaitMs: 10000 });
		const origImpl = h.writeBinary.getMockImplementation()!;
		h.writeBinary.mockImplementation(async (f, bytes, ctx) => {
			lastWriteCtx = { alreadyVisuallyRefreshed: ctx.alreadyVisuallyRefreshed, pagesToRefresh: ctx.pagesToRefresh };
			await origImpl(f, bytes, ctx);
		});

		const r1 = await h.manager.mutate(h.file, { kind: 'add-highlights', optionsList: [makeHighlight(0, 220)] });
		const t1 = r1.highlightIndex.get(0)![0]!.target!;
		// Even a baked-style remove/recolor keeps pages unconfirmed if confirmVisualRefresh wasn't called
		await h.manager.flushNow(h.file.path);
		expect(lastWriteCtx).toEqual({ alreadyVisuallyRefreshed: false, pagesToRefresh: [0] });

		const rRecolor = await h.manager.mutate(h.file, { kind: 'recolor', target: t1, color: BLUE });
		expect(rRecolor.visualMode).toBe('memory-canvas-refresh');
		// Confirm visual refresh manually -> subsequent flush knows canvas is already refreshed
		h.manager.confirmVisualRefresh(h.file.path, rRecolor.changedPageIndexes, rRecolor.revision);
		await h.manager.flushNow(h.file.path);
		expect(lastWriteCtx).toEqual({ alreadyVisuallyRefreshed: true, pagesToRefresh: [] });
		h.manager.disposeAll();
	});

	it('evicts clean sessions respecting maxOpenSessions/maxCleanBaseBytes and mismatched stat.size on modify', async () => {
		const baseBytes = await makeFixturePdfBytes();
		const diskMap = new Map<string, Uint8Array>();
		const files: SessionFileLike[] = ['a.pdf', 'b.pdf', 'c.pdf'].map((name) => {
			const bytes = new Uint8Array(baseBytes);
			diskMap.set(name, bytes);
			return { path: name, stat: { mtime: 10, size: bytes.byteLength } };
		});
		const mgr = new PdfSessionManager<SessionFileLike>({
			readBinary: async (f) => new Uint8Array(diskMap.get(f.path)!),
			writeBinary: async (f, bytes) => {
				diskMap.set(f.path, new Uint8Array(bytes));
				f.stat.size = bytes.byteLength;
			},
			isFileCurrent: () => true,
			onExternalConflict: () => {},
		}, { maxOpenSessions: 2, maxCleanBaseBytes: baseBytes.byteLength * 2 + 10 });

		await mgr.warmSession(files[0]!);
		await mgr.warmSession(files[1]!);
		expect(mgr.hasSession('a.pdf')).toBe(true);
		expect(mgr.hasSession('b.pdf')).toBe(true);

		// Opening c.pdf evicts oldest clean session (a.pdf)
		await mgr.warmSession(files[2]!);
		expect(mgr.hasSession('a.pdf')).toBe(false);
		expect(mgr.hasSession('c.pdf')).toBe(true);

		// Mutate + flush b.pdf so lastOwnWriteCompletedAt is fresh, then simulate different-size external sync
		await mgr.mutate(files[1]!, { kind: 'add-highlights', optionsList: [makeHighlight(0, 220)] });
		await mgr.flushNow('b.pdf');
		expect(mgr.onExternalModify('b.pdf', files[1]!.stat.size + 42)).toBe(true);
		expect(mgr.hasSession('b.pdf')).toBe(false);
		mgr.disposeAll();
	});
});
