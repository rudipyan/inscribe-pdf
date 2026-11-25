# iPad Pencil caret correction — local.54

## Report and reproduction

The user confirmed that the supplied recording was made with local.53 active. The on-screen timestamp is not evidence that an earlier build was running.

The recording shows the temporary yellow selection covering a page number, running header, and a large body-text prefix before returning to the smaller saved highlights. Sol High reproduced the relevant failure in native macOS WKWebView; Luna Max implements the constrained fix.

The old Pencil hit test accepted any DOM caret inside a PDF text layer, including element boundaries. In the whitespace between absolutely positioned PDF text rows, WebKit can return the text-layer element at offset zero. Extending a selection to that endpoint selects the DOM prefix, including the header and page number. A wide text span can also return a distant Text caret over empty page space, so checking the node type alone is insufficient.

PDF.js also moves a full-page end-of-content sentinel beside the active native selection. In WebKit, an ordinary row gap can return that sentinel as the caret. Simply rejecting it without looking for nearby text would make a normal multi-line stroke clear at each gap.

The counterexample was reproduced with both a small synthetic layout and a layout derived read-only from the recorded article's page-four text, positions and DOM order. The latter uses an approximate Times font and is not an exact reproduction of the physical iPad renderer. No user PDF was modified.

## Fix contract

- Accept Pencil selection endpoints only on connected, owned, selectable Text with nearby glyph geometry.
- Validate a small range around the returned caret, rather than scanning the page or trusting a wide parent span's bounding box.
- Reject text-layer, sentinel and other element boundaries as endpoints; reject distant, empty, foreign or nonselectable text.
- During a continuing stroke, rescue normal row gaps using bounded vertical probes at the same horizontal position. Every candidate is checked against the original tip position. The nearest valid candidate wins, with stroke direction breaking distance ties.
- The sentinel may trigger a nearby search, but can never become an endpoint. Starting on an invalid boundary still fails safely.
- Preserve word-edge snapping, same-word no-op updates, reversed strokes, final lift-point capture, off-page clearing and return to text.
- Leave general native finger/mouse selection, parent-boundary capture, annotation persistence and PDF validation unchanged.

## Verification

Baseline: 495 tests passed, zero failures. The newly added caret regressions failed before the fix.

- Final full suite: **506 passed, zero failures**. Focused Pencil tests: 14/14 passed.
- Native macOS WKWebView: **49/49 combined checks** (37 selection/overlay/caret checks plus 12 capture checks), compared with 41/49 before the fix. All eight failing native cases now pass. These are cases of the reproduced defect, not eight independent root causes.
- The separate article-page counterexample passes: moving into the margin no longer produces the page-number/header/body-prefix selection.
- Plain and active-sentinel row gaps resolve to the nearest text row. Measured gap cases sample seven positions and inspect each of two distinct candidate ranges once, with no page traversal or broad-range geometry extraction. The bounded worst case is seven sampled positions, up to 14 native method calls if both caret API fallbacks are needed.
- Both source files remained byte-identical to the worker's frozen hashes throughout the final native probes. The public caret/text-layer APIs remain available from pencil-gesture.ts. The new resolver is isolated in pencil-caret.ts; both files are below 400 lines.
- Production TypeScript/esbuild build: passed.
- ESLint: zero errors, 40 existing compatibility warnings, matching the baseline count. No rules, configuration or suppressions changed.
- git diff --check: passed.
- Independent Sol High code-reviewer approved the complete new helper and baseline diff, with no release blocker. An earlier review caught same-row recovery being skipped and a test fixture key-type mismatch; both were corrected before final verification.
- The original article's SHA-256 hash was unchanged after read-only inspection and rendering. No PDF or workspace-state file was edited.

Reproduction artifacts are under /tmp/rudi-pdf-wkprobe54regression and /tmp/rudi-pdf-wkprobe53. They use native macOS WebKit, not physical iPadOS touch or Apple Pencil events. The complete device experience remains subject to an on-device check.

## Installation

Installed **0.4.4-local.54** into the existing 1-Academic/.obsidian/plugins/study-pdf-local directory. main.js, styles.css and manifest.json were verified byte-for-byte against source; data.json, note-marker-positions.json and pomodoro.json were verified unchanged during installation. No dependencies or toolbar design changed. The running Obsidian session was left alone.

After iCloud sync completes, fully close and reopen Obsidian on iPad, confirm local.54, and repeat the multi-line Pencil stroke from the recording. Check both row gaps and the right-hand text margin. This release fixes the reproduced caret error; physical-device smoothness and native touch-event delivery still require that check.
