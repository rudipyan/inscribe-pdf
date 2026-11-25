# Minimal page-label navigation — local.44

Implements the approved Astra Max concept: borderless `p. 3` in the toolbar; a small tap/click panel shows an editable Page label field and physical PDF position separately.

- Preserves the original native page input/count inside the toolbar for restoration. The draft field submits exactly one native change event, retaining PDF.js label resolution and avoiding blur-triggered navigation. Escape/outside press cancel the draft.
- Native page events update ordinary unlabelled PDFs as well as labelled papers; subscriptions follow the current file in the same pane and detach on destruction. Count-text metadata changes share a coalesced microtask update. No polling, PDF scans, or per-selection processing.
- Left/Right editing uses the same protective Obsidian key scope as existing popups. Close removes that scope and all popup listeners; keyboard cancellation restores focus. Touch controls keep 44px targets.

## Checks

Production build/TypeScript and whitespace checks passed; independent code review approved. 31 targeted page-control and PDF-adapter tests passed, including native node restoration, draft cancellation, one-change submission, arrow-key scope cleanup, unlabelled page updates and pane reuse.

The additional existing `icon-popup.test.ts` suite failed 10 tests because its fake DOM elements lack the `style` property used by the existing popup positioning code. Its production modules were not changed in this patch; no whole-suite pass is claimed.

Actual Mac/iPad/iPhone layout and keyboard behavior remain unverified on device. Installed settings, note marker positions and timer state are preserved.
