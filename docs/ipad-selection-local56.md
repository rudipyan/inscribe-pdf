# Live Pencil selection — local.56

## Scope and diagnosis

The reported lag begins while selecting sentences, before choosing a color. This investigation targets live selection, separate from local.55's document-retirement fix.

The plugin has two selection routes. The custom Pencil Highlight route performs word snapping and paints its preview while the stylus moves. Native Select mode follows WebKit selection and adds an iOS visual overlay. The supplied recording shows the Highlight control active; the current tool-mode clarification remains unanswered. This release changes the custom Pencil route.

Sol High instrumented production event handling with native macOS WebKit DOM and Selection APIs. Neither route reads PDF files, captures the full quote, rebuilds indexes, or rescans notes/toolbars during dragging. Main-thread page lookup is avoidable work, but its measured page-four cost was too small to justify expanding this change.

Repeated native character hit-testing was the measurable selection-time cost. The existing same-word shortcut avoided selection writes but still asked WebKit for the character under every Pencil position. That cost grows with document text density, including offscreen text. This establishes redundant work; it does not establish the complete cause of the physical iPad symptom or a first-contact stall.

## Change

- After accepting a non-anchor whole word, retain its identity and one native word Range. Repeated moves strictly inside that word use its fresh client rectangles instead of another native character search.
- Validate the exact directional native selection, connected owned Text nodes, unchanged text, valid Range offsets, viewport and text-layer bounds, and a one-pixel interior inset. Anchor-word crossings, whitespace, word edges, invalidated selections and unfamiliar geometry use the normal resolver.
- Read word geometry freshly, including after font, position or zoom changes. Complex individual rotations, transforms and perspective on the ancestor chain fall back to normal resolution. The transform check runs only after an actual in-word candidate is found.
- Preserve the anchor and extend it when changing words. Use an atomic directional update when the anchor changes, with the existing compatibility fallback. Verify resulting endpoints before accepting a native update, including silent no-op cases involving detached text.
- Refresh word-boundary caches when Text data changes. A changed word is selected in full instead of reusing its old boundaries.

The cache is per gesture and uses a WeakMap. It adds no observers, timers, dependencies, whole-page scans or PDF work to selection. First contact and entry into a new word still use the native caret resolver. Native Select and finger selection continue through their existing route.

## Native measurements

These are synchronous scripted macOS WKWebView experiments, not physical iPad latency, frame-rate or Apple Pencil measurements. Each row measures 300 movements within one accepted word.

| Text spans | Before | Final | Native caret lookups |
| --- | ---: | ---: | ---: |
| 12 | 5 ms | 6 ms | 300 → 1 |
| 45 | 5 ms | 3 ms | 300 → 1 |
| 120 | 8 ms | 3 ms | 300 → 1 |
| 3,600 | 128 ms | 5 ms | 300 → 1 |
| 12,000 | 410 ms | 5 ms | 300 → 1 |
| 45 active-page spans, 12,000 total including offscreen pages | 454 ms | 5 ms | 300 → 1 |

The extracted article page has roughly 45 line-item spans, not 12,000 character spans. Large fixtures are stress cases. One-millisecond differences in small fixtures are timing noise; these results do not support a uniform speedup claim.

In the large fixture, created Ranges fell from 900 to four. The final path retains 300 fresh word-rectangle reads and 300 layer-bound reads, plus ancestor-style validation on accepted reuse candidates. For 1,000 movements into different words, time changed from 50 to 53 ms; native selection writes fell from 3,000 to 1,000. The improvement targets repeated within-word movement rather than every movement pattern.

Optional first-contact probes measured color-style invalidation and Intl.Segmenter initialization. They did not establish a severe first-contact cause on the article-like fixture, so those paths were left unchanged.

## Verification

- Final full suite: **539 passed, zero failures**; focused Pencil/word tests: **23/23**.
- Production TypeScript/esbuild build passes. ESLint: zero errors and 40 existing warnings. `git diff --check` passes.
- Exact final source in native WebKit: **37/37** existing selection/overlay/caret regressions and **10/10** invalidation checks. Forward/reverse strokes, anchor crossing, article margins and active-sentinel row gaps remain correct.
- Invalidation checks include changed text, detached nodes, external selection, moved text, zoom/offscreen coordinates, same-bounds font/transform changes, and individual/ancestor rotation. Changed-text behavior intentionally corrects an old stale-boundary result.
- Sol High diagnosed and tested the paths; Astra High reviewed cache safety; Luna Max implemented the change. Independent Sol High code review approved the exact final helper and independently passed **47/47** relevant integration tests.

Temporary evidence: `/tmp/rudi-pdf-selection-final56/summary-final2.json`, its `*-final2-results.json` files, `/tmp/rudi-pdf-selection-latency56/pipeline-call-counts.json`, and `/tmp/rudi-pdf-selection56-tests.json`. Source was checked against the fresh local.55 snapshot at `/var/folders/3l/q1qvjh013n9gxwlzn06hy0gr0000gn/T/rudi-pdf-selection56-baseline-fl2hd2se`. No user PDF or Obsidian workspace-state file was edited for tests.

## Local installation and device check

Installed **0.4.4-local.56** in the existing 1-Academic/.obsidian/plugins/study-pdf-local directory. Only `main.js`, `styles.css` and `manifest.json` were replaced, with the manifest last. Source/artifact equality and preservation of `data.json`, `note-marker-positions.json` and `pomodoro.json` were verified. The running Obsidian session was left alone. No changes were committed, published or pushed.

After iCloud sync, fully close and reopen Obsidian on iPad and confirm local.56. Test the exact live-selection phase in Highlight mode: first contact, moving through words and sentences, reversing, crossing row gaps, and leaving/returning from the margin. Check the delay before lifting or choosing a color separately from the subsequent save. Initial-contact latency and physical-device smoothness still need that check. If the reported lag occurs with the Select arrow, that native route requires separate on-device diagnosis.
