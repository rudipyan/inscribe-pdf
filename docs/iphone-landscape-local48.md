# iPhone landscape performance — local.48

Implemented with Sol Medium; audited and final patch approved by Astra Max.

## Changes

- Skip horizontal-stability geometry and style work during pinch gestures. Reuse visible-page rectangles and cache clipping-ancestor classification while reading current geometry. Invalidate the cache on layout/scroller changes.
- Batch note-marker and selected-outline rebuilding behind a 150 ms zoom quiet window. Explicit note refreshes stay immediate.
- Debounce retired-document eligibility scans by 250 ms while retaining ownership, pending-request, stream and consumer safeguards.
- Disable backdrop blur for the mobile fullscreen annotation toolbar.
- Ignore queued observer callbacks after layout-controller disposal, preventing stale scroll listeners from being reattached.

Native rendering quality, manual zoom/panning, PDF content and annotation persistence are unchanged.

## Verification

- 87 targeted tests passed across eight suites, including pinch bypass, landscape resize, nested clipping, scroller replacement and disposal.
- Production build (TypeScript and esbuild): passed.
- git diff --check: passed.
- Full suite: 380 passed, 26 failed, 406 total. Before-change baseline: 366 passed, 26 failed, 392 total. Failed test names match exactly; no new failures. Existing fixture failures remain unresolved.
- Astra independently reran the six expanded layout tests and approved the final patch. Code-reviewer approved the main patch; its follow-up on the final disposal guards could not run due to its usage limit. Astra reviewed those guards.
- No physical iPhone performance measurement or native rendering-quality check was available. After iCloud sync, restart Obsidian and check landscape page scrolling and pinch zoom on the device.

## Installation

Install only main.js, styles.css and manifest.json into the existing study-pdf-local directory in the 1-Academic vault. Verify byte equality and preserve data.json, note-marker-positions.json and pomodoro.json. Do not modify PDFs or workspace state.
