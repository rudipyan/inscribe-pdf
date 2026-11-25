import { describe, expect, it, vi } from 'vitest';
import { PendingHighlightOverlay, type PendingOverlayViewHost } from '../src/ui/pending-highlight-overlay';
import type { PendingOverlayEntry } from '../src/pdf-working-session';

class FakeElement {
	tagName: string;
	attributes = new Map<string, string>();
	children: FakeElement[] = [];
	parentElement: FakeElement | null = null;
	classList: { contains: (cls: string) => boolean };
	ownerDocument: FakeDocument;

	constructor(tagName: string, doc: FakeDocument, classes: string[] = []) {
		this.tagName = tagName;
		this.ownerDocument = doc;
		const set = new Set(classes);
		this.classList = { contains: (cls: string) => set.has(cls) };
	}

	get firstChild() {
		return this.children[0] ?? null;
	}

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}

	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}

	appendChild(child: FakeElement) {
		child.parentElement = this;
		this.children.push(child);
		return child;
	}

	removeChild(child: FakeElement) {
		const idx = this.children.indexOf(child);
		if (idx >= 0) this.children.splice(idx, 1);
		child.parentElement = null;
		return child;
	}

	remove() {
		this.parentElement?.removeChild(this);
	}

	getBoundingClientRect() {
		return { left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800 };
	}
}

class FakeDocument {
	createElementNS(_ns: string, tagName: string) {
		return new FakeElement(tagName, this);
	}
}

function makeHost(rotated = false) {
	const doc = new FakeDocument();
	const page0 = new FakeElement('div', doc, ['page']);
	const textLayer0 = new FakeElement('div', doc, ['textLayer']);
	page0.appendChild(textLayer0);
	let renderCb: ((pageIndex: number) => void) | null = null;
	let scaleCb: (() => void) | null = null;
	let unwatchCalled = false;

	const host: PendingOverlayViewHost = {
		getRenderedPageElement: (pageIndex) => (pageIndex === 0 ? (page0 as unknown as HTMLElement) : null),
		getPageViewport: () => ({
			width: rotated ? 800 : 600,
			height: rotated ? 600 : 800,
			convertToPdfPoint: (x, y) => [x, y],
			convertToViewportPoint: (x, y) => (rotated ? [y, 600 - x] : [x, 800 - y]),
		}),
		watchPageRenderEvents: (onPage, onScale) => {
			renderCb = onPage;
			scaleCb = onScale;
			return () => { unwatchCalled = true; };
		},
	};

	return {
		host,
		page0,
		triggerRender: (p: number) => renderCb?.(p),
		triggerScale: () => scaleCb?.(),
		unwatchCalled: () => unwatchCalled,
	};
}

function entry(refKey: string, revision: number, colorCss = 'rgb(255, 255, 0)'): PendingOverlayEntry {
	return {
		refKey,
		pageIndex: 0,
		quadPoints: [10, 120, 110, 120, 10, 100, 110, 100],
		colorCss,
		opacity: 1,
		revision,
	};
}

describe('PendingHighlightOverlay', () => {
	it('renders SVG polygons directly on the page container outside .textLayer and updates on recolor/clear', () => {
		const h = makeHost(false);
		const overlay = new PendingHighlightOverlay(h.host);

		overlay.sync([entry('10:0', 1), entry('11:0', 2, 'rgb(0, 128, 255)')]);
		const svgs = h.page0.children.filter((c) => c.tagName === 'svg');
		expect(svgs).toHaveLength(1);
		const svg = svgs[0]!;
		expect(svg.getAttribute('viewBox')).toBe('0 0 600 800');
		expect(svg.children).toHaveLength(2);
		expect(svg.children[0]!.tagName).toBe('polygon');
		expect(svg.children[0]!.getAttribute('fill')).toBe('rgb(255, 255, 0)');
		expect(svg.children[0]!.getAttribute('points')).toBe('10,680 110,680 110,700 10,700');
		expect(svg.children[1]!.getAttribute('fill')).toBe('rgb(0, 128, 255)');

		// Clearing up to revision 1 leaves revision 2 intact
		overlay.clearUpToRevision([0], 1);
		expect(h.page0.children.filter((c) => c.tagName === 'svg')[0]!.children).toHaveLength(1);
		expect(h.page0.children.filter((c) => c.tagName === 'svg')[0]!.children[0]!.getAttribute('fill')).toBe('rgb(0, 128, 255)');

		// Clearing up to revision 2 removes the SVG cleanly
		overlay.clearUpToRevision([0], 2);
		expect(h.page0.children.filter((c) => c.tagName === 'svg')).toHaveLength(0);

		overlay.dispose();
		expect(h.unwatchCalled()).toBe(true);
	});

	it('re-projects polygons on rotated viewports and re-renders when pagerendered fires', () => {
		const h = makeHost(true);
		const spy = vi.spyOn(h.host, 'getPageViewport');
		const overlay = new PendingHighlightOverlay(h.host);

		overlay.sync([entry('10:0', 1)]);
		const svg = h.page0.children.filter((c) => c.tagName === 'svg')[0]!;
		expect(svg.getAttribute('viewBox')).toBe('0 0 800 600');
		expect(svg.children[0]!.getAttribute('points')).toBe('120,590 120,490 100,490 100,590');

		h.triggerRender(0);
		h.triggerScale();
		expect(spy).toHaveBeenCalledTimes(3);
		overlay.dispose();
	});

	it('avoids getBoundingClientRect reflow when viewport width and height are already provided', () => {
		const h = makeHost(false);
		const rectSpy = vi.spyOn(h.page0, 'getBoundingClientRect');
		const overlay = new PendingHighlightOverlay(h.host);

		overlay.sync([entry('10:0', 1)]);
		expect(rectSpy).not.toHaveBeenCalled();
		overlay.dispose();
	});
});
