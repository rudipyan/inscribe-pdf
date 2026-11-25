# Scoped performance changes — local.38

## Scope

Luna Max implemented Astra's recommended findings 1, 3, 5, and 6. Preview-raster reuse and PDF worker ownership were deliberately left outside this patch.

- Ordinary text-layer selection geometry traverses only the normalized selected page interval, with a direct path for a selection inside one Text node. Existing full-quote and contiguous-page validation remain. Completed selections share their capture with the iOS overlay.
- Pencil updates skip DOM selection rewrites when snapped endpoints already match; final pointer release still uses the synchronous path.
- Valid, disjoint highlight bounds are rejected before precise polygon intersections. Existing malformed geometry, note protection, and exact polygon checks remain.
- Routine selection changes no longer trigger reconciliation of all PDF toolbars and reading layouts. Lifecycle/file-open discovery has bounded retries; actual completed selections can recover the owning toolbar. Action callbacks still resolve the live view/file.
- Each popup has one frame scheduler for scroll, resize, drag, and note autosizing. The duplicate window/document scroll and main reposition passes are removed. Initial display and final drag release remain synchronous. Closing disposes queued work, listeners, and observer callbacks.

## Verification

- Luna's TypeScript check and diff whitespace check passed.
- Parent production build (including TypeScript) and git diff --check passed.
- Astra Max approved the exact delta against the saved .37 baseline after two compatibility corrections: preserving the original pane traversal for unusual owned container-boundary ranges, and stable max-content popup width during viewport changes.
- Installed main.js, styles.css, and manifest.json match source byte-for-byte; local.37 -> local.38. data.json, note-marker-positions.json, and pomodoro.json were preserved byte-for-byte.
- No tests or benchmarks added/run. No lint pass or measured speedup claimed.
- Native UI tools are unavailable: live Mac/iPad/Pencil, cross-page selection, keyboard, and popup interaction behavior still need device verification.
