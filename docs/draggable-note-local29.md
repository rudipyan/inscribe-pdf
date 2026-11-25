# Draggable note editor — local.29

- Compact theme-aware note card with an icon-only drag grip, textarea, and save/cancel footer.
- Only the grip moves the editor; textarea editing and selection stay native.
- Pointer capture handles mouse/touch/pen, including release, cancellation, and lost capture. Focused grip supports arrow keys (Shift for larger steps).
- Position is retained for the open editor using a private mutable position, through scrolling and visible viewport changes. Existing viewport clamping keeps it within the screen/keyboard viewport.
- Dragging moves the editor UI only, not the PDF annotation or right-margin note marker. Position is not persisted after closing.
- Listeners, capture, ResizeObserver, and animation frames are limited to one open editor and removed on close. No PDF reads/renders or saved-file writes are triggered by moving the card.

## Checks performed 2026-10-23

- TypeScript check: passed.
- Production build: passed.
- Diff whitespace check: passed.
- Independent static code review: approved; no blockers found.
- Installed main.js, styles.css, manifest.json match source; local.28 -> local.29; data.json unchanged.
- No automated tests added or run. No lint pass claimed.
- Native UI tools unavailable: Mac/iPad runtime drag and keyboard checks remain unverified. Reload Study PDF Local to load the installed bundle.
