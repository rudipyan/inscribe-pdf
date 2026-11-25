# Toolbar design — local.39

Astra Max made the design decisions and approved the implemented source/diff.

## Applied design

- One icon-only row: Thumbnail | segmented Select/Highlight/Area, palette, Undo/Redo; grouped page/zoom/appearance; pinned Timer, Fullscreen | Highlights & notes.
- Page input/count moved into the reading group, freeing pinned width on narrow panes. Every native node keeps its identity and restoration placeholder.
- Left-aligned annotation tools with flexible spacing before reading controls. Removed duplicate group borders/separators.
-32px fine-pointer controls,44px whenever a coarse pointer exists;16px icons,18px swatches, neutral active modes, selected swatch rings and subtle inner edges.
- Stable56px tabular-numeral countdown; its phase icon lives in the popup. Timer semantics, subscriptions and saved state are unchanged.
- CSS-only scroll frame, thin3px scrollbar on Chromium/WebKit, and pointer-transparent trailing fade with end padding. No new JS scroll/resize listeners or layout measurements.
- Existing fullscreen positioning, titlebar/safe-area allowances, translucency, reduced-transparency and forced-colors fallbacks retained.

## Checks2026-10-24

- Production build including TypeScript passed; git diff --check passed.
- Independent code review approved native restoration, selection handlers, shrinkable layout and pinned controls.
- Astra Max confirmed design compliance; no blocking findings.
- Installed artifacts match source byte-for-byte; local.38→local.39; data.json, note marker positions and timer sidecar preserved.
- No tests added/run and no lint pass claimed.
- Native UI tools unavailable: actual Mac/iPad/iPhone/split-pane layout and fullscreen reachability remain unverified on-device. Reload Rudi's Study PDF to load the new row.
