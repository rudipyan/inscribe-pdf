import type { PDFDocument, PDFRef } from '@cantoo/pdf-lib';
import {
	addHighlightsToDoc,
	addPageNoteToDoc,
	applyUndoPatchToDoc,
	buildHighlightIndexFromDoc,
	loadPdfDocForSession,
	recolorHighlightInDoc,
	reinspectHighlightTargetInDoc,
	removeHighlightInDoc,
	replaceOverlappingHighlightsInDoc,
	serializeSessionBytes,
	setHighlightNoteInDoc,
	updateHighlightIndexForPages,
	type AddHighlightOptions,
	type DocumentSnapshot,
	type HighlightIndex,
	type HighlightTarget,
	type IncrementalSaveMode,
	type PdfObjectUndoPatch,
	type RgbColor,
} from './annotate';
import { fingerprintPdfBytes } from './pdf-in-place';
import { normalizeVaultRelativePath } from './pdf-mutation';

export const FLUSH_DEBOUNCE_MS = 1500;
export const FLUSH_MAX_WAIT_MS = 8000;
export const MAX_OPEN_SESSIONS = 3;
export const MAX_CLEAN_BASE_BYTES = 160 * 1024 * 1024;
export const MAX_UNDO_STEPS = 50;
const OWN_WRITE_EVENT_GRACE_MS = 2500;

export interface SessionFileLike {
	path: string;
	stat: { mtime: number; size: number };
}

export interface PendingOverlayEntry {
	readonly refKey: string;
	readonly pageIndex: number;
	readonly quadPoints: number[];
	readonly colorCss: string;
	readonly opacity: number;
	readonly revision: number;
	readonly isRegion?: boolean;
}

export type VisualRefreshMode =
	| 'overlay-only'
	| 'memory-canvas-refresh'
	| 'memory-annot-layer-refresh';

export interface SessionMutationResult {
	changed: boolean;
	revision: number;
	changedPageIndexes: number[];
	visualMode: VisualRefreshMode;
	memoryBytes?: Uint8Array;
	pendingOverlays: PendingOverlayEntry[];
	highlightIndex: HighlightIndex;
	sessionFingerprint: string;
}

export interface SessionUndoResult {
	status: 'applied' | 'empty';
	revision: number;
	changedPageIndexes: number[];
	visualMode: 'memory-canvas-refresh';
	memoryBytes?: Uint8Array;
	pendingOverlays: PendingOverlayEntry[];
	highlightIndex: HighlightIndex;
}

export type SessionMutationOp =
	| { kind: 'add-highlights'; optionsList: AddHighlightOptions[] }
	| { kind: 'replace-overlapping'; optionsList: AddHighlightOptions[] }
	| { kind: 'recolor'; target: HighlightTarget; color: RgbColor }
	| { kind: 'set-note'; target: HighlightTarget; note: string }
	| { kind: 'remove'; target: HighlightTarget }
	| { kind: 'add-page-note'; pageIndex: number; point: { x: number; y: number }; note: string };

export interface PdfSessionWriteContext {
	fingerprint: string;
	pagesToRefresh: number[];
	flushRevision: number;
	alreadyVisuallyRefreshed: boolean;
}

export interface PdfSessionAdapter<File extends SessionFileLike> {
	readBinary(file: File): Promise<Uint8Array>;
	writeBinary(file: File, bytes: Uint8Array, context: PdfSessionWriteContext): Promise<void>;
	isFileCurrent(file: File, path: string): boolean;
	onExternalConflict(file: File, path: string, reason: string): Promise<void> | void;
	onFlushError?(file: File, path: string, error: unknown): void;
	onHistoryChanged?(file: File, path: string): void;
	onVisualSynced?(file: File, path: string, flushRevision: number, refreshedPages: number[]): void;
}

interface UndoEntry {
	readonly patches: PdfObjectUndoPatch[];
	readonly pageIndexes: number[];
}

interface PdfWorkingSession<File extends SessionFileLike> {
	file: File;
	readonly path: string;
	baseBytes: Uint8Array;
	baseFingerprint: string;
	basePrevStartXRef: number;
	lastDiskFingerprint: string;
	lastDiskByteLength: number;
	openedStat: { mtime: number; size: number };
	pdfDoc: PDFDocument;
	baseSnapshot: DocumentSnapshot | null;
	incrementalMode: IncrementalSaveMode;
	revision: number;
	flushedRevision: number;
	pageVisualRevision: Map<number, number>;
	dirtyPages: Set<number>;
	pendingAddedRefs: Map<string, PendingOverlayEntry>;
	cachedSerialized: { revision: number; bytes: Uint8Array; fingerprint?: string } | null;
	highlightIndex: HighlightIndex;
	sessionFingerprint: string;
	acceptedCleanFingerprints: Set<string>;
	undoStack: UndoEntry[];
	undoCursor: number;
	debounceTimer: ReturnType<typeof setTimeout> | null;
	maxWaitTimer: ReturnType<typeof setTimeout> | null;
	inMemoryQueue: Promise<void>;
	flushQueue: Promise<void>;
	isFlushing: boolean;
	lastOwnWriteCompletedAt: number;
	lastUsed: number;
	disposed: boolean;
}

function refKeyOf(ref: PDFRef): string {
	return `${ref.objectNumber}:${ref.generationNumber}`;
}

function targetRefKey(target: Pick<HighlightTarget, 'objectNumber' | 'generationNumber'>): string {
	return `${target.objectNumber}:${target.generationNumber}`;
}

function rgbToCss(color: RgbColor): string {
	return `rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`;
}

async function syntheticRevisionFingerprint(baseFingerprint: string, revision: number): Promise<string> {
	if (revision === 0) return baseFingerprint;
	const encoded = new TextEncoder().encode(`study-pdf-session:${baseFingerprint}:${revision}`);
	return fingerprintPdfBytes(encoded);
}

/** Manages in-memory PDFDocument editing sessions with O(1) undo/redo,
 * incremental delta serialization, and debounced background disk flushes. */
export class PdfSessionManager<File extends SessionFileLike> {
	private readonly sessions = new Map<string, PdfWorkingSession<File>>();
	private readonly opening = new Map<string, Promise<PdfWorkingSession<File>>>();
	private readonly adapter: PdfSessionAdapter<File>;
	private readonly debounceMs: number;
	private readonly maxWaitMs: number;
	private readonly maxOpenSessions: number;
	private readonly maxCleanBaseBytes: number;
	private useCounter = 0;

	constructor(
		adapter: PdfSessionAdapter<File>,
		options?: {
			debounceMs?: number;
			maxWaitMs?: number;
			maxOpenSessions?: number;
			maxCleanBaseBytes?: number;
		},
	) {
		this.adapter = adapter;
		this.debounceMs = options?.debounceMs ?? FLUSH_DEBOUNCE_MS;
		this.maxWaitMs = options?.maxWaitMs ?? FLUSH_MAX_WAIT_MS;
		this.maxOpenSessions = Math.max(1, options?.maxOpenSessions ?? MAX_OPEN_SESSIONS);
		this.maxCleanBaseBytes = Math.max(1, options?.maxCleanBaseBytes ?? MAX_CLEAN_BASE_BYTES);
	}

	hasSession(path: string): boolean {
		return this.sessions.has(normalizeVaultRelativePath(path));
	}

	hasDirtySessions(): boolean {
		for (const session of this.sessions.values()) {
			if (!session.disposed && session.revision > session.flushedRevision) return true;
		}
		return false;
	}

	isDirty(path: string): boolean {
		const session = this.sessions.get(normalizeVaultRelativePath(path));
		return Boolean(session && !session.disposed && session.revision > session.flushedRevision);
	}

	getPendingOverlays(path: string): PendingOverlayEntry[] {
		const session = this.sessions.get(normalizeVaultRelativePath(path));
		if (!session || session.disposed) return [];
		return [...session.pendingAddedRefs.values()].sort(
			(a, b) => a.pageIndex - b.pageIndex || a.revision - b.revision,
		);
	}

	historyStatus(file: File, path: string): { canUndo: boolean; canRedo: boolean } {
		const key = normalizeVaultRelativePath(path);
		const session = this.sessions.get(key);
		if (!session || session.disposed || session.file !== file) {
			return { canUndo: false, canRedo: false };
		}
		return {
			canUndo: session.undoCursor > 0,
			canRedo: session.undoCursor < session.undoStack.length,
		};
	}

	async warmSession(file: File): Promise<void> {
		const key = normalizeVaultRelativePath(file.path);
		if (this.sessions.has(key) || this.opening.has(key)) return;
		await this.ensureSession(file);
	}

	/** Records that the UI successfully painted pages up through revision and
	 * returns the remaining pending overlays (preserving newer edits). */
	confirmVisualRefresh(path: string, pageIndexes: readonly number[], revision: number): PendingOverlayEntry[] {
		const key = normalizeVaultRelativePath(path);
		const session = this.sessions.get(key);
		if (!session || session.disposed) return [];
		this.markPagesVisuallyRefreshed(session, pageIndexes, revision);
		return this.getPendingOverlays(key);
	}

	/** Returns the highlight index from memory in O(1) without waiting for any
	 * in-flight background flush, loading once when the session is cold. */
	async getHighlightIndex(file: File): Promise<HighlightIndex> {
		const key = normalizeVaultRelativePath(file.path);
		const existing = this.sessions.get(key);
		if (existing && !existing.disposed && existing.file === file) {
			if (this.isCleanSessionStale(existing, file)) {
				this.dropSession(key);
			} else {
				existing.lastUsed = ++this.useCounter;
				return existing.highlightIndex;
			}
		}
		const session = await this.ensureSession(file);
		session.lastUsed = ++this.useCounter;
		return session.highlightIndex;
	}

	async mutate(file: File, op: SessionMutationOp): Promise<SessionMutationResult> {
		const key = normalizeVaultRelativePath(file.path);
		let session = await this.ensureSession(file);
		if (this.isCleanSessionStale(session, file)) {
			this.dropSession(key);
			session = await this.ensureSession(file);
		}
		return this.enqueueInMemory(session, async () => {
			if (session.disposed || !this.adapter.isFileCurrent(file, key)) {
				throw new Error(`PDF is no longer at "${key}". Select it again before changing highlights.`);
			}
			session.lastUsed = ++this.useCounter;

			if (op.kind === 'add-highlights') {
				const { addedRefs, changedPageIndexes, patches } = addHighlightsToDoc(
					session.pdfDoc,
					session.baseSnapshot,
					op.optionsList,
				);
				return this.commitInMemoryMutation(session, changedPageIndexes, patches, 'overlay-only', (revision) => {
					op.optionsList.forEach((opt, idx) => {
						const ref = addedRefs[idx];
						if (!ref) return;
						const refKey = refKeyOf(ref);
						session.pendingAddedRefs.set(refKey, {
							refKey,
							pageIndex: opt.pageIndex,
							quadPoints: [...opt.quadPoints],
							colorCss: rgbToCss(opt.color),
							opacity: opt.opacity ?? 1,
							revision,
							isRegion: opt.isRegion,
						});
					});
				});
			}

			if (op.kind === 'replace-overlapping') {
				const { addedAnnotations, removedRefs, changedPageIndexes, patches } = replaceOverlappingHighlightsInDoc(
					session.pdfDoc,
					session.baseSnapshot,
					op.optionsList,
				);
				const removedBaked = removedRefs.some((ref) => !session.pendingAddedRefs.has(refKeyOf(ref)));
				const mode: VisualRefreshMode = removedBaked ? 'memory-canvas-refresh' : 'overlay-only';
				return this.commitInMemoryMutation(session, changedPageIndexes, patches, mode, (revision) => {
					for (const ref of removedRefs) session.pendingAddedRefs.delete(refKeyOf(ref));
					for (const { ref, replacement } of addedAnnotations) {
						const refKey = refKeyOf(ref);
						session.pendingAddedRefs.set(refKey, {
							refKey,
							pageIndex: replacement.options.pageIndex,
							quadPoints: [...replacement.options.quadPoints],
							colorCss: rgbToCss(replacement.options.color),
							opacity: replacement.opacity,
							revision,
						});
					}
				});
			}

			if (op.kind === 'recolor') {
				this.assertTargetMatchesSession(session, op.target);
				const { updatedCount, patches } = recolorHighlightInDoc(session.pdfDoc, session.baseSnapshot, {
					pageIndex: op.target.pageIndex,
					objectNumber: op.target.objectNumber,
					generationNumber: op.target.generationNumber,
					geometrySignature: op.target.geometrySignature,
					color: op.color,
				});
				if (updatedCount === 0) {
					return {
						changed: false,
						revision: session.revision,
						changedPageIndexes: [],
						visualMode: 'overlay-only',
						pendingOverlays: this.getPendingOverlays(key),
						highlightIndex: session.highlightIndex,
						sessionFingerprint: session.sessionFingerprint,
					};
				}
				const refKey = targetRefKey(op.target);
				const pending = session.pendingAddedRefs.get(refKey);
				const mode: VisualRefreshMode = pending ? 'overlay-only' : 'memory-canvas-refresh';
				return this.commitInMemoryMutation(session, [op.target.pageIndex], patches, mode, (revision) => {
					if (pending) {
						session.pendingAddedRefs.set(refKey, {
							...pending,
							colorCss: rgbToCss(op.color),
							revision,
						});
					}
				});
			}

			if (op.kind === 'set-note') {
				const effectiveTarget = this.resolveTargetForNote(session, op.target);
				const { updatedCount, patches } = setHighlightNoteInDoc(session.pdfDoc, session.baseSnapshot, {
					pageIndex: effectiveTarget.pageIndex,
					objectNumber: effectiveTarget.objectNumber,
					generationNumber: effectiveTarget.generationNumber,
					geometrySignature: effectiveTarget.geometrySignature,
					note: op.note,
				});
				if (updatedCount === 0) {
					return {
						changed: false,
						revision: session.revision,
						changedPageIndexes: [],
						visualMode: 'memory-annot-layer-refresh',
						pendingOverlays: this.getPendingOverlays(key),
						highlightIndex: session.highlightIndex,
						sessionFingerprint: session.sessionFingerprint,
					};
				}
				// Upgrading to a full page canvas refresh when unflushed highlights exist on
				// this page prevents skipCanvas from hiding them before the disk flush runs.
				const hasPendingOnPage = [...session.pendingAddedRefs.values()].some(
					(entry) => entry.pageIndex === effectiveTarget.pageIndex,
				);
				const noteMode: VisualRefreshMode = hasPendingOnPage ? 'memory-canvas-refresh' : 'memory-annot-layer-refresh';
				return this.commitInMemoryMutation(
					session,
					[effectiveTarget.pageIndex],
					patches,
					noteMode,
					() => {},
				);
			}

			if (op.kind === 'remove') {
				this.assertTargetMatchesSession(session, op.target);
				const { removedCount, removedRef, patches } = removeHighlightInDoc(
					session.pdfDoc,
					session.baseSnapshot,
					{
						pageIndex: op.target.pageIndex,
						objectNumber: op.target.objectNumber,
						generationNumber: op.target.generationNumber,
						geometrySignature: op.target.geometrySignature,
					},
				);
				if (removedCount === 0) {
					return {
						changed: false,
						revision: session.revision,
						changedPageIndexes: [],
						visualMode: 'overlay-only',
						pendingOverlays: this.getPendingOverlays(key),
						highlightIndex: session.highlightIndex,
						sessionFingerprint: session.sessionFingerprint,
					};
				}
				const refKey = refKeyOf(removedRef);
				const wasPending = session.pendingAddedRefs.has(refKey);
				const mode: VisualRefreshMode = wasPending ? 'overlay-only' : 'memory-canvas-refresh';
				return this.commitInMemoryMutation(session, [op.target.pageIndex], patches, mode, () => {
					if (wasPending) session.pendingAddedRefs.delete(refKey);
				});
			}

			// add-page-note
			const { patches } = addPageNoteToDoc(session.pdfDoc, session.baseSnapshot, {
				pageIndex: op.pageIndex,
				point: op.point,
				note: op.note,
			});
			return this.commitInMemoryMutation(session, [op.pageIndex], patches, 'memory-canvas-refresh', () => {});
		});
	}

	async undoOrRedo(file: File, direction: 'undo' | 'redo'): Promise<SessionUndoResult> {
		const key = normalizeVaultRelativePath(file.path);
		const session = this.sessions.get(key);
		if (!session || session.disposed || session.file !== file) {
			return {
				status: 'empty',
				revision: 0,
				changedPageIndexes: [],
				visualMode: 'memory-canvas-refresh',
				pendingOverlays: [],
				highlightIndex: new Map(),
			};
		}
		return this.enqueueInMemory(session, async () => {
			if (session.disposed || !this.adapter.isFileCurrent(file, key)) {
				throw new Error(`PDF is no longer at "${key}".`);
			}
			const stepIndex = direction === 'undo' ? session.undoCursor - 1 : session.undoCursor;
			if (stepIndex < 0 || stepIndex >= session.undoStack.length) {
				return {
					status: 'empty',
					revision: session.revision,
					changedPageIndexes: [],
					visualMode: 'memory-canvas-refresh',
					pendingOverlays: this.getPendingOverlays(key),
					highlightIndex: session.highlightIndex,
				};
			}
			const entry = session.undoStack[stepIndex]!;
			const changedPageIndexes = applyUndoPatchToDoc(session.pdfDoc, session.baseSnapshot, entry.patches, direction);
			session.undoCursor += direction === 'undo' ? -1 : 1;
			const result = await this.finalizeRevisionChange(session, changedPageIndexes, 'memory-canvas-refresh', () => {});
			this.adapter.onHistoryChanged?.(session.file, session.path);
			return {
				status: 'applied',
				revision: result.revision,
				changedPageIndexes: result.changedPageIndexes,
				visualMode: 'memory-canvas-refresh',
				memoryBytes: result.memoryBytes,
				pendingOverlays: result.pendingOverlays,
				highlightIndex: result.highlightIndex,
			};
		});
	}

	/** Immediately writes any pending edits for this PDF path to disk after checking
	 * for external modifications. Safe to call when no session or clean session exists. */
	async flushNow(path: string): Promise<void> {
		const key = normalizeVaultRelativePath(path);
		const session = this.sessions.get(key);
		if (!session || session.disposed) return;
		this.clearSessionTimers(session);

		if (session.revision <= session.flushedRevision) {
			await session.flushQueue;
			return;
		}

		// Serialize the disk flush through flushQueue so two concurrent flushNow
		// callers never race writeBinary calls, while keeping inMemoryQueue unlocked
		// during the slow disk I/O.
		const run = session.flushQueue.then(() => this.performFlush(session));
		session.flushQueue = run.then(() => undefined, () => undefined);
		await run;
	}

	async flushAllDirty(): Promise<void> {
		const dirtyPaths = [...this.sessions.values()]
			.filter((session) => !session.disposed && session.revision > session.flushedRevision)
			.map((session) => session.path);
		await Promise.allSettled(dirtyPaths.map((path) => this.flushNow(path)));
	}

	/** Flush dirty sessions that are no longer open in any PDF view (e.g. tab closed). */
	async flushClosedSessions(openPaths: ReadonlySet<string>): Promise<void> {
		const closedDirty = [...this.sessions.values()]
			.filter((session) => !session.disposed && session.revision > session.flushedRevision && !openPaths.has(session.path))
			.map((session) => session.path);
		await Promise.allSettled(closedDirty.map((path) => this.flushNow(path)));
	}

	/** Notifies the session manager of an Obsidian vault 'modify' event. Clean
	 * sessions modified externally are evicted; own flush echoes are ignored. */
	onExternalModify(path: string, currentStatSize?: number): boolean {
		const key = normalizeVaultRelativePath(path);
		const session = this.sessions.get(key);
		if (!session || session.disposed) return false;
		if (session.isFlushing) return false;
		const sizeChangedExternally = currentStatSize !== undefined && currentStatSize !== session.lastDiskByteLength;
		if (!sizeChangedExternally && Date.now() - session.lastOwnWriteCompletedAt <= OWN_WRITE_EVENT_GRACE_MS) {
			return false;
		}
		if (session.revision > session.flushedRevision) {
			// Preserve unsaved edits in memory; the next flushNow will run the exact
			// disk byte comparison and invoke onExternalConflict before any write.
			return false;
		}
		this.dropSession(key);
		return true;
	}

	onFileRemovedOrRenamed(path: string): void {
		const key = normalizeVaultRelativePath(path);
		this.dropSession(key);
	}

	disposeAll(): void {
		for (const key of [...this.sessions.keys()]) this.dropSession(key);
		this.opening.clear();
	}

	private async ensureSession(file: File): Promise<PdfWorkingSession<File>> {
		const key = normalizeVaultRelativePath(file.path);
		const existing = this.sessions.get(key);
		if (existing && !existing.disposed && existing.file === file) {
			return existing;
		}
		if (existing) this.dropSession(key);

		const pending = this.opening.get(key);
		if (pending) return pending;

		const loadPromise = (async () => {
			if (!this.adapter.isFileCurrent(file, key)) {
				throw new Error(`PDF is no longer at "${key}".`);
			}
			const raw = await this.adapter.readBinary(file);
			const baseBytes = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw);
			const baseFingerprint = await fingerprintPdfBytes(baseBytes);
			if (!this.adapter.isFileCurrent(file, key)) {
				throw new Error(`PDF changed while loading "${key}".`);
			}
			const loaded = await loadPdfDocForSession(baseBytes);
			const highlightIndex = buildHighlightIndexFromDoc(loaded.pdfDoc, baseFingerprint);
			const session: PdfWorkingSession<File> = {
				file,
				path: key,
				baseBytes,
				baseFingerprint,
				basePrevStartXRef: loaded.basePrevStartXRef,
				lastDiskFingerprint: baseFingerprint,
				lastDiskByteLength: baseBytes.byteLength,
				openedStat: { mtime: file.stat.mtime, size: file.stat.size },
				pdfDoc: loaded.pdfDoc,
				baseSnapshot: loaded.baseSnapshot,
				incrementalMode: loaded.incrementalMode,
				revision: 0,
				flushedRevision: 0,
				pageVisualRevision: new Map(),
				dirtyPages: new Set(),
				pendingAddedRefs: new Map(),
				cachedSerialized: null,
				highlightIndex,
				sessionFingerprint: baseFingerprint,
				acceptedCleanFingerprints: new Set([baseFingerprint]),
				undoStack: [],
				undoCursor: 0,
				debounceTimer: null,
				maxWaitTimer: null,
				inMemoryQueue: Promise.resolve(),
				flushQueue: Promise.resolve(),
				isFlushing: false,
				lastOwnWriteCompletedAt: -Infinity,
				lastUsed: ++this.useCounter,
				disposed: false,
			};
			this.evictCleanSessionsIfNeeded(key, baseBytes.byteLength);
			this.sessions.set(key, session);
			return session;
		})();

		this.opening.set(key, loadPromise);
		try {
			return await loadPromise;
		} finally {
			if (this.opening.get(key) === loadPromise) this.opening.delete(key);
		}
	}

	private isCleanSessionStale(session: PdfWorkingSession<File>, file: File): boolean {
		if (session.revision > session.flushedRevision || session.isFlushing) return false;
		if (Date.now() - session.lastOwnWriteCompletedAt <= OWN_WRITE_EVENT_GRACE_MS) return false;
		return session.openedStat.mtime !== file.stat.mtime || session.openedStat.size !== file.stat.size;
	}

	private assertTargetMatchesSession(session: PdfWorkingSession<File>, target: HighlightTarget): void {
		if (target.sourceFingerprint === session.sessionFingerprint ||
			session.acceptedCleanFingerprints.has(target.sourceFingerprint)) {
			return;
		}
		throw new Error('Study PDF: highlight target belongs to an earlier PDF state. Click the highlight again before changing it.');
	}

	private resolveTargetForNote(session: PdfWorkingSession<File>, target: HighlightTarget): HighlightTarget {
		if (target.sourceFingerprint === session.sessionFingerprint ||
			session.acceptedCleanFingerprints.has(target.sourceFingerprint)) {
			return target;
		}
		const reinspected = reinspectHighlightTargetInDoc(session.pdfDoc, target, session.sessionFingerprint);
		if (!reinspected) {
			throw new Error('The original highlight is no longer uniquely identifiable. Reopen its popup before trying again; your draft is still here.');
		}
		return reinspected;
	}

	private async commitInMemoryMutation(
		session: PdfWorkingSession<File>,
		changedPageIndexes: number[],
		patches: PdfObjectUndoPatch[],
		visualMode: VisualRefreshMode,
		onBeforeFinalize: (nextRevision: number) => void,
	): Promise<SessionMutationResult> {
		if (session.undoCursor < session.undoStack.length) {
			session.undoStack.splice(session.undoCursor);
		}
		session.undoStack.push({ patches, pageIndexes: changedPageIndexes });
		session.undoCursor++;
		while (session.undoStack.length > MAX_UNDO_STEPS) {
			session.undoStack.shift();
			session.undoCursor = Math.max(0, session.undoCursor - 1);
		}

		const result = await this.finalizeRevisionChange(session, changedPageIndexes, visualMode, onBeforeFinalize);
		this.adapter.onHistoryChanged?.(session.file, session.path);
		return { changed: true, ...result };
	}

	private async finalizeRevisionChange(
		session: PdfWorkingSession<File>,
		changedPageIndexes: number[],
		visualMode: VisualRefreshMode,
		onUpdateOverlays: (nextRevision: number) => void,
	): Promise<Omit<SessionMutationResult, 'changed'>> {
		const nextRevision = session.revision + 1;
		session.revision = nextRevision;
		session.lastUsed = ++this.useCounter;
		for (const pageIndex of changedPageIndexes) session.dirtyPages.add(pageIndex);
		onUpdateOverlays(nextRevision);

		const nextFingerprint = await syntheticRevisionFingerprint(session.baseFingerprint, nextRevision);
		session.sessionFingerprint = nextFingerprint;
		session.acceptedCleanFingerprints = new Set([nextFingerprint]);
		session.highlightIndex = updateHighlightIndexForPages(
			session.pdfDoc,
			nextFingerprint,
			session.highlightIndex,
			changedPageIndexes,
		);
		session.cachedSerialized = null;

		let memoryBytes: Uint8Array | undefined;
		if (visualMode !== 'overlay-only') {
			memoryBytes = await serializeSessionBytes(
				session.pdfDoc,
				session.baseBytes,
				session.baseSnapshot,
				session.incrementalMode,
				session.basePrevStartXRef,
			);
			session.cachedSerialized = { revision: nextRevision, bytes: memoryBytes };
		}

		this.scheduleFlush(session);

		return {
			revision: nextRevision,
			changedPageIndexes,
			visualMode,
			memoryBytes,
			pendingOverlays: this.getPendingOverlays(session.path),
			highlightIndex: session.highlightIndex,
			sessionFingerprint: nextFingerprint,
		};
	}

	private markPagesVisuallyRefreshed(
		session: PdfWorkingSession<File>,
		pageIndexes: readonly number[],
		revision: number,
	): void {
		for (const pageIndex of pageIndexes) {
			const prev = session.pageVisualRevision.get(pageIndex) ?? 0;
			if (revision > prev) session.pageVisualRevision.set(pageIndex, revision);
			for (const [refKey, entry] of session.pendingAddedRefs) {
				if (entry.pageIndex === pageIndex && entry.revision <= revision) {
					session.pendingAddedRefs.delete(refKey);
				}
			}
		}
	}

	private scheduleFlush(session: PdfWorkingSession<File>): void {
		if (session.disposed) return;
		if (session.debounceTimer !== null) clearTimeout(session.debounceTimer);
		session.debounceTimer = setTimeout(() => {
			session.debounceTimer = null;
			void this.flushNow(session.path).catch(() => {
				// Errors are reported through adapter.onFlushError inside performFlush.
			});
		}, this.debounceMs);

		if (session.maxWaitTimer === null) {
			session.maxWaitTimer = setTimeout(() => {
				session.maxWaitTimer = null;
				if (session.debounceTimer !== null) {
					clearTimeout(session.debounceTimer);
					session.debounceTimer = null;
				}
				void this.flushNow(session.path).catch(() => {
					// Errors are reported through adapter.onFlushError inside performFlush.
				});
			}, this.maxWaitMs);
		}
	}

	private clearSessionTimers(session: PdfWorkingSession<File>): void {
		if (session.debounceTimer !== null) {
			clearTimeout(session.debounceTimer);
			session.debounceTimer = null;
		}
		if (session.maxWaitTimer !== null) {
			clearTimeout(session.maxWaitTimer);
			session.maxWaitTimer = null;
		}
	}

	private async performFlush(session: PdfWorkingSession<File>): Promise<void> {
		if (session.disposed || session.revision <= session.flushedRevision) return;
		if (!this.adapter.isFileCurrent(session.file, session.path)) {
			const reason = `PDF is no longer at "${session.path}".`;
			this.dropSession(session.path);
			await this.adapter.onExternalConflict(session.file, session.path, reason);
			return;
		}

		// Snapshot + serialize under the fast in-memory queue, then release it
		// before touching disk so user edits never block on slow iCloud I/O.
		const snapshot = await this.enqueueInMemory(session, async () => {
			if (session.disposed || session.revision <= session.flushedRevision) return null;
			const flushRevision = session.revision;
			let bytes: Uint8Array;
			let fingerprint: string;
			if (session.cachedSerialized?.revision === flushRevision) {
				bytes = session.cachedSerialized.bytes;
				fingerprint = session.cachedSerialized.fingerprint ?? await fingerprintPdfBytes(bytes);
				session.cachedSerialized.fingerprint = fingerprint;
			} else {
				bytes = await serializeSessionBytes(
					session.pdfDoc,
					session.baseBytes,
					session.baseSnapshot,
					session.incrementalMode,
					session.basePrevStartXRef,
				);
				fingerprint = await fingerprintPdfBytes(bytes);
				session.cachedSerialized = { revision: flushRevision, bytes, fingerprint };
			}
			const dirtySnapshot = [...session.dirtyPages].sort((a, b) => a - b);
			const pagesToRefresh = dirtySnapshot.filter((pageIndex) => (session.pageVisualRevision.get(pageIndex) ?? 0) < flushRevision);
			return {
				flushRevision,
				bytes,
				fingerprint,
				dirtySnapshot,
				pagesToRefresh,
				alreadyVisuallyRefreshed: pagesToRefresh.length === 0,
			};
		});

		if (!snapshot || session.disposed) return;

		session.isFlushing = true;
		try {
			// Verify the on-disk file was not modified externally (e.g. from iPad via iCloud).
			const diskRaw = await this.adapter.readBinary(session.file);
			const diskBytes = diskRaw instanceof Uint8Array ? diskRaw : new Uint8Array(diskRaw);
			if (session.disposed) return;

			let diskMatches = diskBytes.byteLength === session.lastDiskByteLength;
			if (diskMatches) {
				const diskFingerprint = await fingerprintPdfBytes(diskBytes);
				diskMatches = diskFingerprint === session.lastDiskFingerprint;
			}
			if (!diskMatches) {
				const reason = `PDF changed externally on disk ("${session.path}"). Reloading the disk version to avoid overwriting external edits.`;
				this.dropSession(session.path);
				await this.adapter.onExternalConflict(session.file, session.path, reason);
				return;
			}

			await this.adapter.writeBinary(session.file, snapshot.bytes, {
				fingerprint: snapshot.fingerprint,
				pagesToRefresh: snapshot.pagesToRefresh,
				flushRevision: snapshot.flushRevision,
				alreadyVisuallyRefreshed: snapshot.alreadyVisuallyRefreshed,
			});

			session.lastOwnWriteCompletedAt = Date.now();
			session.lastDiskFingerprint = snapshot.fingerprint;
			session.lastDiskByteLength = snapshot.bytes.byteLength;
			session.openedStat = { mtime: session.file.stat.mtime, size: session.file.stat.size };
			session.flushedRevision = Math.max(session.flushedRevision, snapshot.flushRevision);
			session.acceptedCleanFingerprints.add(snapshot.fingerprint);
			if (session.cachedSerialized?.revision === snapshot.flushRevision) {
				session.cachedSerialized = null;
			}

			this.markPagesVisuallyRefreshed(session, snapshot.pagesToRefresh, snapshot.flushRevision);
			if (session.revision === snapshot.flushRevision) {
				session.dirtyPages.clear();
				// If an encrypted PDF required a full rewrite on first save, upgrade the
				// now-decrypted bytes into a fast classic-xref incremental session.
				if (session.incrementalMode === 'full-rewrite') {
					await this.enqueueInMemory(session, async () => {
						if (session.disposed || session.revision !== snapshot.flushRevision) return;
						const upgraded = await loadPdfDocForSession(snapshot.bytes);
						if (session.disposed || session.revision !== snapshot.flushRevision) return;
						session.baseBytes = snapshot.bytes;
						session.baseFingerprint = snapshot.fingerprint;
						session.basePrevStartXRef = upgraded.basePrevStartXRef;
						session.pdfDoc = upgraded.pdfDoc;
						session.baseSnapshot = upgraded.baseSnapshot;
						session.incrementalMode = upgraded.incrementalMode;
						session.sessionFingerprint = snapshot.fingerprint;
						session.acceptedCleanFingerprints = new Set([snapshot.fingerprint]);
						session.highlightIndex = buildHighlightIndexFromDoc(upgraded.pdfDoc, snapshot.fingerprint);
						session.undoStack = [];
						session.undoCursor = 0;
						this.adapter.onHistoryChanged?.(session.file, session.path);
					});
				}
			}

			this.adapter.onVisualSynced?.(session.file, session.path, snapshot.flushRevision, snapshot.pagesToRefresh);

			if (!session.disposed && session.revision > session.flushedRevision) {
				this.scheduleFlush(session);
			}
		} catch (error) {
			this.adapter.onFlushError?.(session.file, session.path, error);
			throw error;
		} finally {
			session.isFlushing = false;
		}
	}

	private enqueueInMemory<T>(session: PdfWorkingSession<File>, task: () => Promise<T>): Promise<T> {
		const next = session.inMemoryQueue.then(task);
		session.inMemoryQueue = next.then(() => undefined, () => undefined);
		return next;
	}

	private dropSession(path: string): void {
		const session = this.sessions.get(path);
		if (!session) return;
		session.disposed = true;
		this.clearSessionTimers(session);
		session.pendingAddedRefs.clear();
		session.cachedSerialized = null;
		this.sessions.delete(path);
	}

	private evictCleanSessionsIfNeeded(incomingPath: string, incomingByteLength: number): void {
		const cleanSessions = () => [...this.sessions.values()]
			.filter((s) => s.path !== incomingPath && s.revision <= s.flushedRevision && !s.isFlushing)
			.sort((a, b) => a.lastUsed - b.lastUsed);

		while (this.sessions.size >= this.maxOpenSessions) {
			const victim = cleanSessions()[0];
			if (!victim) break;
			this.dropSession(victim.path);
		}

		let cleanBytes = cleanSessions().reduce((sum, s) => sum + s.baseBytes.byteLength, 0);
		while (cleanBytes + incomingByteLength > this.maxCleanBaseBytes) {
			const victim = cleanSessions()[0];
			if (!victim) break;
			cleanBytes -= victim.baseBytes.byteLength;
			this.dropSession(victim.path);
		}
	}
}
