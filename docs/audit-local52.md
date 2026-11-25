# Bug audit and fixes — local.52

## Scope and model routing

Sol High audited the source and all 22 failing baseline tests, with an independent Sol High UI audit. Astra High investigated only the unresolved direct-Node/ESLint import stall. Luna Max implemented every production and test-fixture fix. Code-reviewer approved the completed patch, including the final region Escape integration.

## Confirmed production bugs fixed

1. **P1: external PDF update overwritten during preparation.** The original-byte comparison now runs immediately before every PDF modification, after awaited native preparation. Conflicts abort and release prepared resources/history safely. This is a fresh byte read/comparison, not another PDF parse or backup. Obsidian does not expose cross-process compare-and-swap; an external write racing after the last check remains an API boundary.
2. **P2: unreadable existing annotation data replaced.** Adding highlights rejects present-but-unreadable /Annots instead of replacing it with a new array. Valid absent/direct/indirect arrays continue to work.
3. **P2: flashcard annotation identity collision.** Matching uses the exact annotation identity in the final generated answer link; IDs such as 12R and 12R1 and their schedules remain independent. Mentions in question text do not hijack another card.
4. **P2: repeated fallback flashcards.** Sources without annotation IDs reuse an exact generated body in the matching page section while preserving schedules. Ambiguous legacy page-only cards are not broadly overwritten or auto-orphaned.
5. **P2: duplicate unchanged note submission.** Enter during the saved-success delay cannot submit the same draft twice; editing re-enables submission and failed saves remain retryable.
6. **P2: overlapping visual selection rectangles.** Rectangle normalization merges transitively connected same-line boxes and preserves genuine gaps, avoiding double-painted intersections without changing saved annotation geometry.
7. **P2: area selection consumes unrelated Escape.** Escape respects prior handling, IME composition, key repeats/modifiers, existing popups, editable/modal/search contexts and ownership of the focused PDF pane. Valid owning-pane Escape still exits area mode, including body focus after dragging.

## Baseline test failures

The 22 original failures were outdated/incomplete test fixtures or superseded interface expectations, not 22 independent runtime bugs. Repairs preserve atomic latest-note merging, immutable snapshot/byte validation, exact targets, no-focus/selection behavior, drag suppression, marker lifecycle and bounded DOM assertions. Tests now model the approved icon-only/no-generic-tooltip interface, stable PDF geometry and realistic window/pointer APIs.

## Verification

- Before changes:438 passed, 22 failed, 460 total.
- After source fixes:481 passed, 0 failed, 481 total.
- Focused worker verification:135 tests across 10 affected files passed.
- Production TypeScript/esbuild build and git diff --check passed.
- Final code-reviewer source review found no remaining blocker in the patch.
- Independent core audit ran 261 existing tests and a temporary timer oracle covering 72 suspension/settings combinations; source coverage included mutation/capture/queues/history/export/snapshots, in-place refresh/lifetimes/retirement, settings/positions/timer/startup/unload and UI interactions.
- No user PDFs were used for mutation regressions. No physical iPhone/iPad/Pencil, native popout memory or printing validation was performed. Passing tests and a source audit do not prove absence of every possible device-specific bug.

## Tooling diagnosis

Direct Node imports stalled while macOS hydrated evicted node_modules files. Astra reproduced cold files with dataless flags/zero disk blocks and 1.3-second reads, then verified fast imports after concurrent reads. Luna completed read-only hydration of 4,653 existing runtime files in 471.2 seconds. File contents, package versions, configuration and lint rules were unchanged. Normal ESLint then completed and reported 21 errors / 43 warnings; the safe cleanup was applied by Luna and verified without rule or configuration changes. Final unchanged ESLint reports 0 errors / 40 warnings. Those warnings cover intentional WebKit/IME compatibility, native DOM helpers, timer and owner-window checks, pure headless hashing and brand capitalization. No new lint suppressions were added.

## Final verification and installation

Parent reran the complete suite after lint cleanup: **481 passed / 0 failed**. The production build (TypeScript and esbuild), git diff --check, and unchanged ESLint invocation all completed successfully; lint has **0 errors / 40 documented warnings**. Code-reviewer approved the final callback/style/type cleanup.

Installed main.js, styles.css and manifest.json into the existing 1-Academic/.obsidian/plugins/study-pdf-local directory and verified all three byte-for-byte against source. data.json, note-marker-positions.json and pomodoro.json were preserved byte-for-byte. No PDF or workspace files were edited by this installation. The running Obsidian session was left alone; reload the plugin or restart Obsidian to activate local.52.
