# iPad Pencil selection performance — local.53

## Scope

The reported bottleneck is selecting text and highlighting with Apple Pencil on iPad. Sol High diagnosed the selection and PDF-processing paths; Luna Max implements the fixes. This pass preserves the toolbar design, automatic highlighting on completed selections, annotation persistence, and PDF validation.

## Reproduced causes

- A normal three-text-node selection within a 10,000-text-node page visits all 10,000 nodes during full capture. Capture also runs before some selection checks determine whether a highlight will actually be saved.
- Pencil movement within an unchanged snapped word reports an existing range as a change and triggers another visual preview update.
- The live preview extracts native rectangles for offscreen selected pages before clipping their output. A synthetic selection across 100 rendered pages with one visible page performs 100 native rectangle extractions to paint one visible rectangle.
- The parser uses an uninterrupted batch for PDFs smaller than 8 MB. File size alone does not describe the number of objects or processing cost.

## Changes

- Pencil updates report whether the selection geometry actually changed, separately from whether a valid selection exists. Repeating the same snapped word skips selection writes and preview painting; invalidating a selection still clears its preview once. Coordinate-sensitive word-end hit testing and the final lift point remain intact.
- Preview and release eligibility use a shallow owned native selection. Full quote and quad capture runs for actual highlight actions. Non-color toolbar controls no longer capture the entire selection just to discard it.
- Text-to-text capture starts at the first selected text node and stops at the last selected text node. Cross-page selection retains the selected tail/head and any complete middle pages. Element-boundary fallback, fragment geometry, ownership, continuity and full-quote verification remain.
- Live preview skips native rectangle extraction for offscreen layers, and unchanged overlay geometry/color skips redundant style-helper assignments.
- iOS initializes a 500-object parser/writer batch cap, including input parsing, encrypted fallback, and saved-output verification. Desktop scheduling keeps the previous thresholds. The classic PDF writer, source-byte conflict checks, exact targets, persistence and post-save validation are unchanged.

## Processing experiment

Sol measured the installed PDF library with an in-memory generated 2,258,675-byte PDF containing 12,004 objects. No user PDF was read or modified. These are desktop scheduling measurements, not iPad performance measurements.

| Operation | Batch | Total time | Maximum timer gap | Timer ticks |
| --- | ---: | ---: | ---: | ---: |
| Parse | Unbounded | 59.34 ms | 59.38 ms | 0 |
| Parse | 500 objects | 83.64 ms | 6.01 ms | 24 |
| Parse | 100 objects | 198.48 ms | 6.00 ms | 120 |
| Save | Unbounded | 21.22 ms | 21.23 ms | 0 |
| Save | 500 objects | 74.74 ms | 2.96 ms | 48 |
| Save | 100 objects | 314.17 ms | 3.03 ms | 240 |

The previous writer already uses finite batches for this object-heavy fixture; the unbounded writer comparison illustrates the scheduling tradeoff. The parser previously chooses its batch from byte size alone. An object batch is not a fixed millisecond budget: an individual complex object can still take longer.

## Verification and installation

Baseline: 481 tests passed, no failures; ESLint has zero errors and 40 existing warnings.

A standalone native macOS WKWebView probe using the actual Selection/Range APIs improved from 19/25 passing baseline assertions to 25/25 after the Pencil and overlay changes. It verifies:

- 100 repeated same-word movements retain the range and report no geometry changes.
- Leaving the page clears the preview once; returning and reversing direction work.
- Glyph contact and following whitespace at the same native caret offset still produce the appropriate different word snapping.
- Trailing, middle, and nested PDF.js end-of-content sentinels are excluded without losing selected text.
- An offscreen page does not extract native range rectangles; the visible page still paints.
- Identical overlay updates perform no style-helper assignments. WebKit already suppresses redundant same-value CSS mutations; this check measures avoided JavaScript setter work, not a claim about avoided native style recalculations.

Probe source and results: /tmp/rudi-pdf-wkprobe53 (ephemeral fixture, no Obsidian workspace or user PDF access).

A second native WKWebView probe bundles the exact current capture function and its pure dependencies. All 12 assertions pass, including the 10,000-to-three intersection reduction while retaining three selected fragments and the full quote, nested marked content, cross-page tail/head selection, reversed native selection, parent-element boundary fallback, and rejection of missing pages or mismatched quotes. Combined native probes: 37/37 assertions passed.

Physical iPad Pencil latency and native iPadOS event delivery cannot be established by macOS tests. A native macOS WebKit probe can verify Selection/Range behavior but does not reproduce the hardware, iPadOS selection UI, or device memory pressure.

## Final verification

- Full suite: **495 passed, zero failures** (baseline 481 passed).
- Native macOS WKWebView: **37/37 assertions passed** across Pencil/overlay and exact-function capture probes.
- Production TypeScript/esbuild build: passed.
- ESLint: zero errors, 40 existing warnings, matching the baseline count; no configuration changes or suppressions.
- git diff --check: passed.
- Independent Sol High code-reviewer: approved the final four production files and four test files; independently passed 139 focused tests and TypeScript compilation.
- Existing PDF mutation-conflict, corrupted-output, encrypted-PDF, annotation identity, note persistence, selection-release, undo/history, and other regressions remain in the passing full suite. No user PDFs were mutated for tests.

## Installation

Installed **0.4.4-local.53** into the existing 1-Academic/.obsidian/plugins/study-pdf-local directory. main.js, styles.css and manifest.json were verified byte-for-byte against the build. data.json, note-marker-positions.json and pomodoro.json were verified unchanged during installation. No PDF or workspace-state file was edited, and no dependency was added or updated. The running Obsidian session was not restarted.

After iCloud sync completes, fully close and reopen Obsidian on iPad, and confirm version 0.4.4-local.53. The on-device check is Pencil selection/highlighting in the same article, including repeated strokes, reverse selection and leaving/returning to text. This build addresses verified bottlenecks; the physical-device outcome still needs that check.
