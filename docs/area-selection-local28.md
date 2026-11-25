# Area selection — local.28

## Behavior

- Rectangle icon next to Select/Highlight enables area selection on a rendered page.
- Drag within one page, then use the Copy icon for a PNG or a palette dot for a standard PDF Highlight annotation.
- In Select mode, existing marked regions expose the usual note/color/remove controls, plus image Copy.
- Region metadata is embedded in the PDF. Region selections are kept separate from text highlights; neither operation deletes the other kind.
- Escape or choosing Select/Highlight leaves area mode. Unsaved rectangles clear on scrolling, resizing, or cancellation; zoom/viewport changes invalidate the selection before a write.

## Performance and lifecycle

- No PDF reads, worker requests, or PNG encoding while drawing or during ordinary text selection.
- Copy crops the existing fully rendered canvas. Display-only Dark/Sepia filters and selection UI are excluded.
- PNG output is capped at 4096 px per side and 16 million pixels total.
- Gesture listeners and observers exist only while area mode is enabled.
- Reference-counted host positioning is shared with the internal-link return arrow.
- Existing mutation coordination, source validation, in-place refresh, and undo/redo are reused.

## Checks performed 2026-10-23

- TypeScript check: passed.
- Production build: passed.
- Diff whitespace check: passed.
- Independent static code review: approved after fixing viewport identity, region/text coexistence, stale clipboard callbacks, and overlay positioning ownership.
- Installed main.js, styles.css, manifest.json match source byte-for-byte; version local.27 -> local.28; installed data.json unchanged.
- Targeted ESLint invocation produced no result and was interrupted. No lint pass claimed.
- No automated tests were added or run for this change.
- No live Mac/iPad UI or clipboard checks performed: native UI tools were unavailable this turn. Obsidian must reload Study PDF Local to load the installed bundle.
