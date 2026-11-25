import { describe, expect, it, vi } from 'vitest';
import {
	bytesEqual,
	capturePdfPress,
	capturePdfTarget,
	copyBytes,
	findPdfViewForNode,
	isCapturedPdfCurrent,
	isCapturedPdfViewLive,
	PdfMutationCoordinator,
	resolveCapturedPdfPress,
} from '../src/pdf-mutation';

describe('coordinatePdfMutation', () => {
	it('uses the pre-write check and preserves output identity', async () => {
		const events: string[] = [];
		const bytes = new Uint8Array([2]);
		const read = vi.fn(async () => { events.push('read'); return new Uint8Array([1]); });
		const result = await new PdfMutationCoordinator().run('fast.pdf', {
			read,
			transform: async () => ({ bytes, value: 1 }),
			preview: (output) => { expect(output).toBe(bytes); events.push('preview'); return { dispose() { events.push('dispose'); } }; },
			write: async (output) => { expect(output).toBe(bytes); events.push('write'); },
		});
		expect(read).toHaveBeenCalledTimes(2);
		expect(result.bytes).toBe(bytes);
		expect(events).toEqual(['read', 'preview', 'read', 'write', 'dispose']);
	});

	it('rejects external edits before write and removes its preview', async () => {
		let reads = 0;
		const write = vi.fn(); const dispose = vi.fn();
		await expect(new PdfMutationCoordinator().run('changed.pdf', {
			read: async () => new Uint8Array([++reads]),
			transform: async () => ({ bytes: new Uint8Array([9]), value: undefined }),
			preview: () => ({ dispose }), write,
		})).rejects.toThrow(/changed since/);
		expect(write).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
	});

	it('serializes mutations for the same normalized path and continues after a rejected operation', async () => {
		const coordinator = new PdfMutationCoordinator();
		const source = new Map<string, Uint8Array>([['papers/a.pdf', new Uint8Array([1])]]);
		const events: string[] = [];
		let releaseFirst!: () => void;
		let markFirstStarted!: () => void;
		const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
		const firstStarted = new Promise<void>((resolve) => (markFirstStarted = resolve));
		const makeDeps = (label: string, wait = false) => ({
			read: async () => {
				events.push(`${label}:read`);
				return source.get('papers/a.pdf')!.slice();
			},
			write: async (bytes: Uint8Array) => {
				events.push(`${label}:write`);
				source.set('papers/a.pdf', bytes.slice());
			},
			transform: async (original: Uint8Array) => {
				events.push(`${label}:transform`);
				if (wait) markFirstStarted();
				if (wait) await firstGate;
				if (label === 'failed') throw new Error('transform failed');
				return { bytes: new Uint8Array([...original, label === 'first' ? 2 : 3]), value: label };
			},
		});

		const first = coordinator.run('papers/a.pdf', makeDeps('first', true));
		const failed = coordinator.run('papers/./a.pdf', makeDeps('failed'));
		const last = coordinator.run('papers//a.pdf', makeDeps('last'));
		await firstStarted;
		expect(events).toEqual(['first:read', 'first:transform']);
		releaseFirst();
		await expect(failed).rejects.toThrow('transform failed');
		await expect(first).resolves.toMatchObject({ changed: true, value: 'first' });
		await expect(last).resolves.toMatchObject({ changed: true, value: 'last' });
		expect(events).toEqual([
			'first:read', 'first:transform', 'first:read', 'first:write',
			'failed:read', 'failed:transform',
			'last:read', 'last:transform', 'last:read', 'last:write',
		]);
	});

	it('lets different paths make progress independently', async () => {
		const coordinator = new PdfMutationCoordinator();
		const events: string[] = [];
		let release!: () => void;
		let markOtherFinished!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const otherFinished = new Promise<void>((resolve) => (markOtherFinished = resolve));
		const run = (path: string, wait: boolean) => coordinator.run(path, {
			read: async () => { events.push(`${path}:read`); return new Uint8Array([1]); },
			transform: async (bytes) => {
				events.push(`${path}:transform`);
				if (wait) await gate;
				return { bytes: new Uint8Array([bytes[0]! + 1]), value: path };
			},
			write: async () => {
				events.push(`${path}:write`);
				if (path === 'b.pdf') markOtherFinished();
			},
		});

		const first = run('a.pdf', true);
		const other = run('b.pdf', false);
		await otherFinished;
		expect(events).toContain('b.pdf:write');
		release();
		await Promise.all([first, other]);
	});

	it('recovers a same-path queue after its first read rejects', async () => {
		const coordinator = new PdfMutationCoordinator();
		let reads = 0;
		let writes = 0;
		const dependencies = {
			read: async () => {
				reads++;
				if (reads === 1) throw new Error('read failed');
				return new Uint8Array([1]);
			},
			transform: async () => ({ bytes: new Uint8Array([2]), value: undefined }),
			write: async () => { writes++; },
		};
		await expect(coordinator.run('read-recovers.pdf', dependencies)).rejects.toThrow('read failed');
		await expect(coordinator.run('read-recovers.pdf', dependencies)).resolves.toMatchObject({ changed: true });
		expect(reads).toBe(3);
		expect(writes).toBe(1);
	});

	it('returns byte-identical transforms without write', async () => {
		const coordinator = new PdfMutationCoordinator();
		const events: string[] = [];
		const original = new Uint8Array([1, 2]);
		const result = await coordinator.run('a.pdf', {
			read: async () => original.slice(),
			transform: async (bytes) => ({ bytes, value: 'unchanged' }),
			write: async () => { events.push('write'); },
		});
		expect(result).toMatchObject({ changed: false, value: 'unchanged' });
		expect(result.bytes).toEqual(original);
		expect(events).toEqual([]);
	});

	it('honors an explicit no-change result and returns the original bytes', async () => {
		let writes = 0;
		const original = new Uint8Array([1]);
		const result = await new PdfMutationCoordinator().run('explicit-no-op.pdf', {
			read: async () => original.slice(),
			transform: async (bytes) => {
				bytes[0] = 2;
				return { bytes, value: 'no change', changed: false };
			},
			write: async () => { writes++; },
		});
		expect(result).toMatchObject({ changed: false, value: 'no change' });
		expect(result.bytes).toEqual(original);
		expect(writes).toBe(0);
	});

	it('keeps beforeBytes passed to write immutable when a transform mutates its input', async () => {
		const coordinator = new PdfMutationCoordinator();
		const original = new Uint8Array([10, 20]);
		let writtenBefore: Uint8Array | undefined;
		await coordinator.run('immutable.pdf', {
			read: async () => original.slice(),
			transform: async (working) => {
				working[0] = 99;
				return { bytes: working, value: undefined };
			},
			write: async (_bytes, beforeBytes) => { writtenBefore = beforeBytes; },
		});
		expect(writtenBefore).toEqual(original);
	});
});

describe('captured PDF targets', () => {
	it('chooses the pane that owns a cross-window node before checking its page', () => {
		const target = { nodeType: 1 } as unknown as Node;
		let wrongPanePageLookups = 0;
		const paneA = {
			containerEl: { contains: (_node: Node) => false },
			findPageIndexForNode: (_node: Node) => { wrongPanePageLookups++; return 0; },
		};
		const paneB = {
			containerEl: { contains: (node: Node) => node === target },
			findPageIndexForNode: (node: Node) => node === target ? 2 : null,
		};

		expect(findPdfViewForNode([paneA, paneB], target)).toEqual({ view: paneB, pageIndex: 2 });
		expect(wrongPanePageLookups).toBe(0);
		expect(findPdfViewForNode([paneA, paneB], { nodeType: 'not-a-node' })).toBeNull();
	});

	it('keeps callbacks tied to the original view and file when the active selection changes', () => {
		const originalFile = { path: 'a.pdf' };
		const originalView = { file: originalFile, containerEl: {} };
		let activeFile = originalFile;
		let activeView = originalView;
		const capture = capturePdfTarget(originalFile, originalView);
		activeFile = { path: 'b.pdf' };
		activeView = { file: activeFile, containerEl: {} };
		const deferredCallback = () => capture;
		expect(activeFile).not.toBe(deferredCallback().file);
		expect(activeView).not.toBe(deferredCallback().pdfView);
		expect(deferredCallback()).toMatchObject({ file: originalFile, path: 'a.pdf', pdfView: originalView });
	});

	it('keeps a press on A bound to A after switching to B and rejects a reused A container', () => {
		const fileA = { path: 'a.pdf' };
		const fileB = { path: 'b.pdf' };
		const containerA = {};
		const viewA = { file: fileA, containerEl: containerA };
		const viewB = { file: fileB, containerEl: {} };
		const press = capturePdfPress(capturePdfTarget(fileA, viewA), {
			pageIndex: 2,
			clientX: 120,
			clientY: 240,
			pdfPoint: { x: 80, y: 160 },
		});
		let activeView = viewA;
		const invokedTargets: string[] = [];
		const deferredRemoveOrMenu = () => {
			if (isCapturedPdfViewLive(press.capture, [viewA, viewB])) {
				invokedTargets.push(press.capture.path);
			}
		};

		activeView = viewB;
		deferredRemoveOrMenu();
		expect(activeView.file).toBe(fileB);
		expect(invokedTargets).toEqual(['a.pdf']);

		const reusedBView = { file: fileB, containerEl: containerA };
		invokedTargets.length = 0;
		if (isCapturedPdfViewLive(press.capture, [reusedBView])) invokedTargets.push(press.capture.path);
		expect(invokedTargets).toEqual([]);
	});

	it('clones the PDF point captured synchronously at touch press', () => {
		const file = { path: 'a.pdf' };
		const view = { file, containerEl: {} };
		const sourcePoint = { x: 82.5, y: 141 };
		const press = capturePdfPress(capturePdfTarget(file, view), {
			pageIndex: 1,
			clientX: 120,
			clientY: 240,
			pdfPoint: sourcePoint,
		});
		sourcePoint.x = 0;
		expect(resolveCapturedPdfPress(press)).toEqual({ pageIndex: 1, point: { x: 82.5, y: 141 } });
	});

	it('rejects a renamed file or a replacement occupying the original path', () => {
		const file = { path: 'a.pdf' };
		const view = { file, containerEl: {} };
		const capture = capturePdfTarget(file, view);
		expect(isCapturedPdfCurrent(capture, (path) => path === 'a.pdf' ? file : null)).toBe(true);
		file.path = 'renamed.pdf';
		expect(isCapturedPdfCurrent(capture, (path) => path === 'a.pdf' ? file : null)).toBe(false);
		file.path = 'a.pdf';
		expect(isCapturedPdfCurrent(capture, (path) => path === 'a.pdf' ? { path: 'a.pdf' } : null)).toBe(false);
		expect(() => capturePdfTarget(file, { file: { path: 'other.pdf' }, containerEl: {} })).toThrow(/do not match/);
	});
});

describe('bytesEqual and copyBytes', () => {
	it('copies bytes using slice without sharing memory', () => {
		const source = new Uint8Array([1, 2, 3, 4, 5]);
		const copy = copyBytes(source);
		expect(copy).toEqual(source);
		expect(copy).not.toBe(source);
		copy[0] = 99;
		expect(source[0]).toBe(1);
	});

	it('handles reference equality and length mismatches', () => {
		const arr = new Uint8Array([1, 2, 3]);
		expect(bytesEqual(arr, arr)).toBe(true);
		expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
	});

	it('compares aligned byte arrays including 32-bit words and tail bytes', () => {
		// 9 bytes: 2 words + 1 tail byte
		const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(bytesEqual(a, b)).toBe(true);

		// mismatch in word
		const c = new Uint8Array([1, 2, 3, 4, 5, 0, 7, 8, 9]);
		expect(bytesEqual(a, c)).toBe(false);

		// mismatch in tail byte
		const d = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 0]);
		expect(bytesEqual(a, d)).toBe(false);
	});

	it('falls back to byte loop when offsets are not 32-bit aligned', () => {
		const bufferA = new ArrayBuffer(16);
		const bufferB = new ArrayBuffer(16);
		const viewA = new Uint8Array(bufferA, 1, 7); // offset 1 (unaligned)
		const viewB = new Uint8Array(bufferB, 1, 7);
		viewA.set([1, 2, 3, 4, 5, 6, 7]);
		viewB.set([1, 2, 3, 4, 5, 6, 7]);
		expect(bytesEqual(viewA, viewB)).toBe(true);

		viewB[6] = 99;
		expect(bytesEqual(viewA, viewB)).toBe(false);
	});
});
