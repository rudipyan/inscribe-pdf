# Selected annotation outline and keyboard copy — local.46

Clicking one unambiguous annotation marks its rendered PDF.js highlight fragments with faint 1px neutral dashed borders inside the native clip bounds. Only the selected page's exact numeric annotation ID is queried. Native annotation-layer redraw events reapply the class; dismissing/replacing the selection unregisters the listener and clears the classes. No PDF changes, geometry recomputation, pointer interception or polling are added for the outline.

Command-C copies the selected quotation or region image using the existing Copy action paths. Keyboard copying keeps the chooser/outline open and omits success toasts. It is disabled for ambiguous or unavailable targets, stale captures, other panes, editable fields, modal/search contexts, real DOM text selections, composing/repeated keys and modified shortcuts. Normal copying takes priority. The Copy icon and Backspace removal remain available.

## Checks

Production build/TypeScript, whitespace checks and independent source review passed. All 37 targeted annotation-selection and PDF-adapter tests passed, covering text/image clipboard routing, normal-copy precedence, shortcut guards, outline cleanup, exact annotation IDs and Backspace removal. No live Mac/iPad appearance or system clipboard validation is claimed.

Installed settings, note marker positions and timer state are preserved.
