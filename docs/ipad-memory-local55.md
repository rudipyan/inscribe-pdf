# PDF document lifetime audit — local.55

## Confirmed issue and change

The previous lifetime guard permanently retained a PDF document after any direct `streamTextContent()` call, including streams that had been completely read or cancelled. Native PDF text layers use this API when rebuilding their text. Repeated annotation revisions could therefore accumulate obsolete PDF loading tasks and their transports.

The new observer tracks the existing stream and reader without acquiring a reader, consuming text, creating a second stream, or changing backpressure. It preserves stream, reader, read-promise and cancel-promise identities. A finished native reader releases its pending work once. Cancellation waits for the underlying cancellation promise, since `reader.closed` can settle earlier. Releasing a reader lock does not finish an unread stream, and borrowed methods preserve their actual receiver.

Unread, unsupported, unwritable or failed-cancellation lifetimes remain retained conservatively until the normal document close/reload. The outer `getTextContent()` promise still covers its internal stream. Existing page, layer, thumbnail, search, link and print ownership guards remain unchanged. Idle completion uses the existing quiet retirement schedule; no polling, arbitrary worker cap, new dependency, or selection-path work was added.

## Verification

- Full project suite: **530 passed, zero failures**; baseline was 506 passed. The two final stream/document suites pass **35/35**. All five added lease regressions fail against the saved pre-fix source and pass with the fix.
- Production TypeScript/esbuild build passes. ESLint reports zero errors and the same 40 existing warnings. `git diff --check` passes.
- Independent Sol High code review approved the final helper, document-lifetime delta, and integration tests; the reviewer independently reran all 35 focused tests.
- Actual Obsidian-bundled PDF.js **5.3.34**, generated one-page PDF, 128 revisions: fully read and cancelled direct streams each end with **one live loading task, PDFWorker owner and transport**, compared with **128** before the fix. The `getTextContent()` control stays at one in both versions.
- Production viewer-retirement integration, 128 revisions: one-page and four-page fixtures stabilize at one and four temporary documents respectively, matching pages still retaining their revision. A transient extra document is released by the quiet sweep. Closing releases all temporary documents and retirement listeners, including the preserved original base task at normal close.
- Exact final helper: native stream safety **20/20**, borrowed-receiver safety **9/9**, both in Node and native macOS WKWebView. The WebKit probe uses deterministic promise flushing: initial real-timer runs timed out in the background view, so these results do not measure wall-clock latency.
- Native macOS WKWebView DOM/canvas stress: **240 cycles**, including successful, cancelled, failed, adopted, zoom-invalidated and closed-view previews; scratch drawing; immediate overlays; note-marker hover opening/cancellation. At each cycle, canvases with allocated dimensions, observers, tracked timers/animation frames, global listeners, preview DOM and styles return to zero. All 240 synthetic loading tasks are released; 40 adopted rasters are reused. Timers are manually accelerated, and this counts owned resources rather than measuring process RAM or GPU allocation.
- A separate 240-write mutation stress test returns pending-preview and active-action sets to zero after successful saves, byte conflicts and write failures. Existing full-suite tests cover PDF persistence, undo/redo, notes, colors and Pencil gesture/caret behavior.

Evidence: `/tmp/rudi-pdf-memory-audit55/*final*results.json`, `/tmp/rudi-pdf-stream55/results3.json`, `/tmp/rudi-pdf-canvas55/results.json`, `/tmp/rudi-pdf-canvas55/main-stress-results.json`, and `/tmp/rudi-pdf-memory55-tests.json`. These are local temporary artifacts, not shipped files. Generated PDFs were used; no user PDF or Obsidian workspace-state file was edited.

## Limits and device check

PDF.js experiments count Node fake-worker owner/transport objects, not OS threads. Native WebKit checks run on macOS, not physical iPadOS or an Apple Pencil. They establish the reproduced resource leak and cleanup behavior; they do not establish a measured iPad frame rate, RAM reduction, palm rejection, pinch/rotation smoothness, or the absence of every possible leak.

After local.55 syncs, fully close and reopen Obsidian on iPad. Repeat the recorded multi-line Pencil selection, including row gaps and margins; alternate Pencil and finger scrolling/pinch; rotate with a PDF open; annotate for 10–15 minutes; then reopen the PDF and verify highlights, colors, notes and undo/redo. Check whether interaction degrades over that session.

## Installation

The local installation uses only `main.js`, `styles.css` and `manifest.json`, replacing temporary siblings atomically and writing the manifest last. Source/install bytes and preservation of `data.json`, `note-marker-positions.json` and `pomodoro.json` are verified. The running Obsidian session is left untouched; iCloud delivery and physical-device activation require the device check above.

Sol supplied the diagnosis and final exact-source runtime checks. Luna added the initial stream regression tests before its usage-limit interruption; the parent completed the implementation and remaining checks locally. No changes were committed, published or pushed.
