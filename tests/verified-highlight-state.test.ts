import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import {
	addHighlightAnnotations,
	addPageNote,
	buildHighlightIndex,
	getVerifiedHighlightState,
	removeHighlightForTarget,
	setHighlightColorAt,
	setHighlightNoteForTarget,
	type HighlightIndex,
	type HighlightTarget,
} from '../src/annotate';
import { makeFixturePdfBytes } from './helpers/pdf-fixture';

const YELLOW = { r: 1, g: 0.92, b: 0.2 };
const BLUE = { r: 0.12, g: 0.34, b: 0.78 };
const FIRST = {
	pageIndex: 0,
	quadPoints: [20, 40, 80, 40, 20, 20, 80, 20],
	box: { left: 20, right: 80, top: 40, bottom: 20 },
};

async function fingerprint(bytes: Uint8Array): Promise<string> {
	const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', view as BufferSource);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function highlight(bytes?: Uint8Array): Promise<{ bytes: Uint8Array; target: HighlightTarget }> {
	const input = bytes ?? await makeFixturePdfBytes();
	const highlighted = await addHighlightAnnotations(input, [{ ...FIRST, color: YELLOW }]);
	const target = firstTarget(await buildHighlightIndex(highlighted));
	return { bytes: highlighted, target };
}

function firstTarget(index: HighlightIndex): HighlightTarget {
	const target = [...index.values()].flat().find((entry) => entry.target)?.target;
	if (!target) throw new Error('Fixture does not contain a highlight target.');
	return target;
}

async function expectStateMatchesBytes(bytes: Uint8Array): Promise<void> {
	const state = getVerifiedHighlightState(bytes);
	expect(state).toBeDefined();
	if (!state) return;

	expect(state.fingerprint).toBe(await fingerprint(bytes));
	expect(state.index).toEqual(await buildHighlightIndex(bytes));
	for (const entries of state.index.values()) {
		for (const entry of entries) {
			if (entry.target) expect(entry.target.sourceFingerprint).toBe(state.fingerprint);
		}
	}
}

describe('verified highlight state', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('caches the verified index for the exact bytes returned by add', async () => {
		const input = await makeFixturePdfBytes();
		const loadSpy = vi.spyOn(PDFDocument, 'load');
		const output = await addHighlightAnnotations(input, [{ ...FIRST, color: YELLOW }]);

		expect(loadSpy).toHaveBeenCalledTimes(2);
		expect(getVerifiedHighlightState(output)).toBeDefined();
		expect(getVerifiedHighlightState(new Uint8Array(output))).toBeUndefined();
		expect(getVerifiedHighlightState(output.subarray(0))).toBeUndefined();
		expect(getVerifiedHighlightState(new Uint8Array([1, 2, 3]))).toBeUndefined();
		await expectStateMatchesBytes(output);
	});

	it('caches the recolored index without parsing a third time', async () => {
		const { bytes, target } = await highlight();
		const loadSpy = vi.spyOn(PDFDocument, 'load');
		const result = await setHighlightColorAt(bytes, { ...target, color: BLUE });

		expect(loadSpy).toHaveBeenCalledTimes(2);
		const state = getVerifiedHighlightState(result.bytes);
		expect(state?.fingerprint).toBe(result.target.sourceFingerprint);
		await expectStateMatchesBytes(result.bytes);
	});

	it('caches the noted index without parsing a third time', async () => {
		const { bytes, target } = await highlight();
		const loadSpy = vi.spyOn(PDFDocument, 'load');
		const result = await setHighlightNoteForTarget(bytes, { ...target, note: 'review this passage' });

		expect(loadSpy).toHaveBeenCalledTimes(2);
		const state = getVerifiedHighlightState(result.bytes);
		expect(state?.fingerprint).toBe(result.target.sourceFingerprint);
		await expectStateMatchesBytes(result.bytes);
	});

	it('caches the remaining index after removing a target without parsing a third time', async () => {
		const first = await addHighlightAnnotations(await makeFixturePdfBytes(), [{ ...FIRST, color: YELLOW }]);
		const second = await addHighlightAnnotations(first, [{
			pageIndex: 0,
			quadPoints: [20, 80, 80, 80, 20, 60, 80, 60],
			box: { left: 20, right: 80, top: 80, bottom: 60 },
			color: YELLOW,
		}]);
		const index = await buildHighlightIndex(second);
		const target = firstTarget(index);
		const loadSpy = vi.spyOn(PDFDocument, 'load');
		const result = await removeHighlightForTarget(second, target);

		expect(result.removedCount).toBe(1);
		expect(loadSpy).toHaveBeenCalledTimes(2);
		const state = getVerifiedHighlightState(result.bytes);
		expect(state?.index.get(0)).toHaveLength(1);
		await expectStateMatchesBytes(result.bytes);
	});

	it('caches the verified index when adding a standalone page note without parsing a third time', async () => {
		const { bytes } = await highlight();
		const loadSpy = vi.spyOn(PDFDocument, 'load');
		const saved = await addPageNote(bytes, {
			pageIndex: 0,
			point: { x: 50, y: 50 },
			note: 'test standalone page note',
		});

		expect(loadSpy).toHaveBeenCalledTimes(2);
		expect(getVerifiedHighlightState(saved)).toBeDefined();
		await expectStateMatchesBytes(saved);
	});

	it('incrementally updates the verified index across a multi-page PDF and matches a full rebuild', async () => {
		const doc = await PDFDocument.create();
		doc.addPage([400, 300]);
		doc.addPage([400, 300]);
		doc.addPage([400, 300]);
		const initialBytes = await doc.save();

		let current = await addHighlightAnnotations(initialBytes, [
			{
				pageIndex: 0,
				quadPoints: [20, 40, 80, 40, 20, 20, 80, 20],
				box: { left: 20, right: 80, top: 40, bottom: 20 },
				color: YELLOW,
			},
			{
				pageIndex: 2,
				quadPoints: [30, 50, 90, 50, 30, 30, 90, 30],
				box: { left: 30, right: 90, top: 50, bottom: 30 },
				color: BLUE,
			},
		]);
		await expectStateMatchesBytes(current);

		current = await addHighlightAnnotations(current, [
			{
				pageIndex: 1,
				quadPoints: [10, 50, 70, 50, 10, 30, 70, 30],
				box: { left: 10, right: 70, top: 50, bottom: 30 },
				color: YELLOW,
			},
		]);
		await expectStateMatchesBytes(current);

		const indexAfterAdd = getVerifiedHighlightState(current)!.index;
		const targetPage1 = indexAfterAdd.get(1)![0]!.target!;
		const recolored = await setHighlightColorAt(current, { ...targetPage1, color: BLUE });
		current = recolored.bytes;
		await expectStateMatchesBytes(current);

		const noted = await setHighlightNoteForTarget(current, { ...recolored.target, note: 'page 1 note' });
		current = noted.bytes;
		await expectStateMatchesBytes(current);

		const removed = await removeHighlightForTarget(current, noted.target);
		current = removed.bytes;
		await expectStateMatchesBytes(current);
	});
});
