import type { PendingOverlayEntry } from '../pdf-working-session';

export interface OverlayViewportLike {
	width?: number;
	height?: number;
	convertToViewportPoint?: (x: number, y: number) => [number, number];
	convertToPdfPoint(x: number, y: number): [number, number];
}

export interface PendingOverlayViewHost {
	getRenderedPageElement(pageIndex: number): HTMLElement | null;
	getPageViewport(pageIndex: number): OverlayViewportLike;
	watchPageRenderEvents?(
		onPageRendered: (pageIndex: number) => void,
		onScaleChanging?: () => void,
	): (() => void) | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const OVERLAY_CLASS = 'study-pdf-highlight-preview study-pdf-pending-highlight-overlay';

/** Renders unflushed in-memory highlights in PDF coordinates onto each open
 * page element so zoom, rotation, and scroll keep overlays aligned until flush. */
export class PendingHighlightOverlay {
	private readonly host: PendingOverlayViewHost;
	private entries: PendingOverlayEntry[] = [];
	private readonly svgsByPage = new Map<number, SVGSVGElement>();
	private readonly unwatch: (() => void) | null;
	private scaleFrameId: number | null = null;
	private disposed = false;

	constructor(host: PendingOverlayViewHost) {
		this.host = host;
		this.unwatch = host.watchPageRenderEvents?.(
			(pageIndex) => {
				if (!this.disposed) this.renderPage(pageIndex);
			},
			() => {
				if (this.disposed) return;
				if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
					if (this.scaleFrameId !== null) return;
					this.scaleFrameId = window.requestAnimationFrame(() => {
						this.scaleFrameId = null;
						if (!this.disposed) this.renderAll();
					});
				} else {
					this.renderAll();
				}
			},
		) ?? null;
	}

	sync(entries: readonly PendingOverlayEntry[]): void {
		if (this.disposed) return;
		const previousPages = new Set(this.svgsByPage.keys());
		for (const entry of this.entries) previousPages.add(entry.pageIndex);
		this.entries = [...entries];
		const nextPages = new Set(this.entries.map((entry) => entry.pageIndex));
		const touched = new Set<number>([...previousPages, ...nextPages]);
		for (const pageIndex of touched) this.renderPage(pageIndex);
	}

	clearUpToRevision(pageIndexes: readonly number[], maxRevision: number): void {
		if (this.disposed) return;
		const pageSet = new Set(pageIndexes);
		this.entries = this.entries.filter(
			(entry) => !(pageSet.has(entry.pageIndex) && entry.revision <= maxRevision),
		);
		for (const pageIndex of pageSet) this.renderPage(pageIndex);
	}

	renderAll(): void {
		if (this.disposed) return;
		const pages = new Set<number>([
			...this.svgsByPage.keys(),
			...this.entries.map((entry) => entry.pageIndex),
		]);
		for (const pageIndex of pages) this.renderPage(pageIndex);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.scaleFrameId !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
			window.cancelAnimationFrame(this.scaleFrameId);
		}
		this.scaleFrameId = null;
		this.unwatch?.();
		for (const svg of this.svgsByPage.values()) svg.remove();
		this.svgsByPage.clear();
		this.entries = [];
	}

	private renderPage(pageIndex: number): void {
		const pageEntries = this.entries.filter((entry) => entry.pageIndex === pageIndex);
		const existingSvg = this.svgsByPage.get(pageIndex);
		if (pageEntries.length === 0) {
			if (existingSvg) {
				existingSvg.remove();
				this.svgsByPage.delete(pageIndex);
			}
			return;
		}
		const pageEl = this.host.getRenderedPageElement(pageIndex);
		if (!pageEl) {
			if (existingSvg) {
				existingSvg.remove();
				this.svgsByPage.delete(pageIndex);
			}
			return;
		}
		let viewport: OverlayViewportLike;
		try {
			viewport = this.host.getPageViewport(pageIndex);
		} catch {
			return;
		}
		if (typeof viewport.convertToViewportPoint !== 'function') return;

		let width = viewport.width;
		let height = viewport.height;
		if (!Number.isFinite(width) || width! <= 0 || !Number.isFinite(height) || height! <= 0) {
			const bounds = pageEl.getBoundingClientRect();
			width = bounds.width;
			height = bounds.height;
		}
		if (!Number.isFinite(width) || !Number.isFinite(height) || width! <= 0 || height! <= 0) return;

		const doc = pageEl.ownerDocument;
		const svg = existingSvg && existingSvg.ownerDocument === doc
			? existingSvg
			: doc.createElementNS(SVG_NS, 'svg');
		if (existingSvg && existingSvg !== svg) existingSvg.remove();

		svg.setAttribute('class', OVERLAY_CLASS);
		svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
		svg.setAttribute('preserveAspectRatio', 'none');
		svg.setAttribute('aria-hidden', 'true');
		while (svg.firstChild) svg.removeChild(svg.firstChild);

		for (const entry of pageEntries) {
			const qp = entry.quadPoints;
			for (let i = 0; i + 7 < qp.length; i += 8) {
				// QuadPoints are stored in PDF Z-order: TL, TR, BL, BR.
				// Project to viewport polygon perimeter: TL -> TR -> BR -> BL.
				const tl = viewport.convertToViewportPoint(qp[i]!, qp[i + 1]!);
				const tr = viewport.convertToViewportPoint(qp[i + 2]!, qp[i + 3]!);
				const bl = viewport.convertToViewportPoint(qp[i + 4]!, qp[i + 5]!);
				const br = viewport.convertToViewportPoint(qp[i + 6]!, qp[i + 7]!);
				const polygon = doc.createElementNS(SVG_NS, 'polygon');
				polygon.setAttribute(
					'points',
					`${tl[0]},${tl[1]} ${tr[0]},${tr[1]} ${br[0]},${br[1]} ${bl[0]},${bl[1]}`,
				);
				polygon.setAttribute('fill', entry.colorCss);
				if (entry.opacity < 1) polygon.setAttribute('fill-opacity', String(entry.opacity));
				svg.appendChild(polygon);
			}
		}

		// Keep the SVG directly on the containing .page element (outside .textLayer)
		// so Obsidian's text-layer opacity does not desaturate the highlight color.
		const targetParent = pageEl.classList.contains('textLayer')
			? pageEl.parentElement ?? pageEl
			: pageEl;
		if (svg.parentElement !== targetParent) targetParent.appendChild(svg);
		this.svgsByPage.set(pageIndex, svg);
	}
}
