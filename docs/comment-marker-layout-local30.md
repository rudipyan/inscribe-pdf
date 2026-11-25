# Closed comment icon movement and note sizing — local.30

## Behavior

- The closed comment icon is draggable on its page. Mouse: drag directly. Touch/pen: hold350ms then drag. Short tap/keyboard activation opens the existing note; dragging does not open it.
- Positions use original PDF coordinates through guarded native viewport conversion, including zoom/rotation. Layout keys contain PDF path, page, annotation reference and original geometry to avoid reusing a moved icon for a different annotation.
- UI positions are stored separately in note-marker-positions.json inside the plugin directory, loaded once and saved only after a drop; bounds2000records/1MiB, ordered writes. Moving markers does not rewrite, scan, or render the PDF. Normal text selection has no extra marker work.
- A note opens at340/460/600px according to content, capped to the visual viewport. Textarea height expands to fit its text, then scrolls internally within viewport/keyboard limits. Content sizing is scoped to the open editor.
- New notes:500word save limit and visible word count. Existing longer notes remain intact and can be edited up to their original word count. Over-limit text remains editable and is not silently cut; Save is disabled until within limit.
- Existing editor drag grip remains available. Marker movement changes the closed icon's location; it does not move highlight geometry.

## Checks performed2026-10-23

- TypeScript and production build passed.
- git diff --check passed.
- Independent static review approved after resolving rotation coordinates and matching the persistence writer/loader size budget.
- Installed main.js, styles.css, manifest.json match source byte-for-byte; local.29->local.30; existing data.json unchanged.
- No tests added/run and no lint pass claimed.
- Native UI tools unavailable: actual Mac/iPad drag, text fitting and keyboard behavior remain unverified. Reload Study PDF Local to load the installed bundle.

## Limits

- Marker layout is plugin UI data, not a PDF annotation position understood by other readers. Renaming a PDF currently changes its placement lookup key; its PDF notes remain intact.
- Sidecar changes from another running device are read on plugin reload; simultaneous layout edits have no merge protocol.
