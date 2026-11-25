# Saved region interaction inside Select area — local.31

## Cause and fix

The drawing overlay intercepted all page presses. Releasing a small selection simply cleared it, so saved regions were reachable only after switching to Select.

- Short taps (<=6px displacement, <=800ms, no earlier movement beyond6px) now invoke the existing saved-annotation chooser for region annotations.
- Dragging remains area creation. Starting inside an existing region does not prevent drawing a new region.
- Annotation controls remain available without leaving area mode: image Copy, color, Note, Remove.
- Tap coordinates are frozen in PDF space. Viewport/geometry, view identity, and interaction generation are checked after async cached-index lookup, which waits for pending PDF writes.
- A new interaction cancels stale lookups and dismisses the prior chooser. Escape is delegated to an open annotation/note popup before leaving area mode.
- No annotation reads or image encoding on pointer moves. Copy still uses the existing explicit image-copy path.

## Checks performed2026-10-23

- TypeScript / production build passed.
- git diff --check passed.
- Independent static review approved; its movement-path suggestion was applied to avoid treating an out-and-back drag as a tap.
- Installed artifacts match source; local.30->local.31. data.json and any note-marker-positions.json were preserved byte-for-byte.
- No tests added/run, no lint pass claimed, and no live Mac/iPad UI check performed (native UI tools unavailable).
- Reload Study PDF Local to load the installed bundle.
