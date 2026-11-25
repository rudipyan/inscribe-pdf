import { describe, expect, it } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import { addHighlightAnnotations, addPageNote, getStoredQuotesFromDoc } from '../src/annotate';
import { collectHighlights, type PdfJsDocument } from '../src/pdf-highlights';
import { loadPdfjsDoc, makeFixturePdfBytes } from './helpers/pdf-fixture';

describe('collectHighlights page-index optimization', () => {
	it('skips pdf.js getPage calls on unannotated pages while keeping highlights and text notes on annotated pages', async () => {
		const doc = await PDFDocument.create();
		doc.addPage([400, 300]);
		doc.addPage([400, 300]);
		doc.addPage([400, 300]);
		const baseBytes = await doc.save({ useObjectStreams: false });

		const withHighlight = await addHighlightAnnotations(baseBytes, [{
			pageIndex: 2,
			quadPoints: [10, 40, 80, 40, 10, 30, 80, 30],
			box: { left: 10, right: 80, top: 40, bottom: 30 },
			color: { r: 1, g: 1, b: 0 },
			quote: 'Third page quote',
		}]);
		const withNote = await addPageNote(withHighlight, {
			pageIndex: 0,
			point: { x: 50, y: 50 },
			note: 'First page note',
		});

		const reloaded = await PDFDocument.load(withNote);
		const storedQuotes = await getStoredQuotesFromDoc(reloaded);
		expect(storedQuotes.annotatedPageIndexes).toEqual(new Set([0, 2]));

		const pj = await loadPdfjsDoc(withNote);
		const progress: [number, number][] = [];
		try {
			const requestedPages: number[] = [];
			const trackedDoc: PdfJsDocument = {
				numPages: pj.numPages,
				getPage: async (pageNumber: number) => {
					requestedPages.push(pageNumber);
					return pj.getPage(pageNumber);
				},
			};
			const entries = await collectHighlights(trackedDoc, storedQuotes, {
				onProgress: (pageNumber, total) => progress.push([pageNumber, total]),
			});
			// Page 2 (1-based) had zero annotations and must never be touched by pdf.js.
			expect(requestedPages).toEqual([1, 3]);
			expect(entries).toHaveLength(2);
			expect(entries[0]).toMatchObject({ pageNumber: 1, standaloneNote: true, note: 'First page note' });
			expect(entries[1]).toMatchObject({ pageNumber: 3, quote: 'Third page quote' });
			expect(progress.at(-1)).toEqual([3, 3]);
		} finally {
			await pj.loadingTask.destroy();
		}
	});

	it('still scans all pages cleanly when getStoredQuotes comes from makeFixturePdfBytes', async () => {
		const bytes = await addHighlightAnnotations(await makeFixturePdfBytes(), [{
			pageIndex: 0,
			quadPoints: [10, 40, 80, 40, 10, 30, 80, 30],
			box: { left: 10, right: 80, top: 40, bottom: 30 },
			color: { r: 1, g: 1, b: 0 },
			quote: 'Only quote',
		}]);
		const reloaded = await PDFDocument.load(bytes);
		const storedQuotes = await getStoredQuotesFromDoc(reloaded);
		const pj = await loadPdfjsDoc(bytes);
		try {
			const entries = await collectHighlights(pj, storedQuotes);
			expect(entries).toHaveLength(1);
			expect(entries[0]!.quote).toBe('Only quote');
		} finally {
			await pj.loadingTask.destroy();
		}
	});
});
