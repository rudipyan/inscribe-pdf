# Note markers — local.26 checks

## Implementation

- Icons use the native rendered annotation layer's synchronous `getAnnotation(id)` lookup. No extra PDF file read, parsing, page load or `getAnnotations` worker request is used to discover notes.
- Discovery runs when an annotation layer renders, when affected pages finish an in-place update, or when a view opens. It is not connected to selection or scroll handlers. Native viewer readiness retries are limited to three attempts and canceled on unload.
- Clicking resolves the exact page/object/generation to the existing verified highlight target. Saving uses the existing guarded note operation. Stale/ambiguous targets are rejected.
- Cleared/removed notes reconcile their buttons; native layer replacement and plugin/window disposal clean up markers/listeners. Same-file viewer replacement rebinds the native event bus.
- Margin buttons keep a small visual icon and a 44 px hit target. Native percent positions use the viewer's already-computed height; nearby notes are separated when the page has sufficient room. Unsupported synthetic/direct IDs do not show an unusable edit button.

## Verification

- Production build and TypeScript passed.
- 46 focused tests passed across marker rendering/actions, native layer lifecycle, existing selection interactions, index caching, verified highlight state and in-place PDF refresh.
- Isolated headless Chrome checks passed: desktop and touch-size viewport, keyboard activation, same-height note reachability, clearing notes, retained text selection, no marker scan on selection/scroll, and no DOM mutation during unchanged refresh.
- Additional legacy `main-note-sync` export/flashcard fixture checks failed (5 cases). Those fixtures do not supply the native snapshot adapter required by the current export path. Production export/flashcard code was not changed for this feature. These failures are separate from the 46 focused checks above.
- Scoped ESLint did not finish and was stopped; no lint pass is claimed.
- Live Obsidian 1.14.4 on Mac: enabled the installed build, opened an existing noted highlight in `milgram1994.pdf` through its margin button, confirmed the exact stored note appeared, and canceled without saving. Returned to the previous page and Highlight mode. Physical iPad behavior remains unverified.

## Browser timing

30 iterations per case, 10 noted highlights in each rendered page fixture. Times measure marker JavaScript/DOM updates, not whole PDF rendering or physical-device latency.

| Rendered highlight annotations | Initial median | Initial p95 | Unchanged refresh median | Unchanged refresh p95 |
| --- | --- | --- | --- | --- |
| 100 | 0.2 ms | 0.4 ms | <0.1 ms | 0.1 ms |
| 1,000 | 0.4 ms | 0.9 ms | 0.2 ms | 0.3 ms |

Fixture results support a low bounded rendering cost and no added work while selecting or scrolling; they do not establish zero overhead on all PDFs or physical iPads.
