# Annotation notes and color filters — local.50

Sol High designed the changes; Luna Max implemented them. No new runtime dependencies. The PDF mutation, native reading/selection, and annotation persistence source paths are unchanged from local.49.

## Behavior

- Highlights & notes derives color/count buttons from its existing immutable annotation snapshot, including custom and legacy colors. Multiple selected colors match with OR; All colors resets the filter. Filter changes clear checked rows. Copy-visible and filtered export use only displayed entries; filtered export retains the original snapshot fingerprint and its verification.
- The note editor adds Bold, Italic, Bullets and Preview icons, plus Cmd/Ctrl+B and I. Formatting keeps text/newlines/bullet prefixes and selection offsets. Existing save/cancel, composition handling, dragging, word limit and autosizing remain. During preview or composition, inappropriate formatting controls are disabled.
- Notes are saved as Markdown in the existing PDF /Contents string, with no sidecar for formatting. Study PDF safely renders the supported subset in editor preview, list and hover. Other readers may display Markdown punctuation. Standard PDF /RC rich text is not introduced; imported rich-text behavior remains the existing behavior.
- Mouse hover over a comment icon opens a cached, read-only preview after 150ms. Leaving closes after a 120ms grace period; moving into the preview allows reading/selecting/scrolling. A click follows the existing persistent editor path. Touch/pen input does not trigger hover. There is one hover card per document; editor opening, drag/click, scroll, blur, note refresh and disposal cancel it and its pending work. Hover does not read/parse/write PDFs or move focus. Observation is scoped to the annotation layer while hover work is active.
- The renderer creates text nodes and fixed safe formatting tags, without HTML injection, links, embeds, images or network requests.

## Verification

- New feature tests: 21 passed across five files, including actual PDF note save/reopen with Markdown preserved verbatim.
- Parent production build (TypeScript and esbuild) and git diff --check passed.
- Full suite: 435 passed, 22 failed, 457 total. Baseline local.49: 410 passed, 26 failed, 436 total. No new failed test names; four older fixture failures were resolved. The suite is not fully green.
- Independent browser fixture: nine rendering cases passed (combined/nested emphasis, Turkish Unicode, lists, inert markup, escaping, unmatched markers, line breaks).
- Independent browser fixture: 14 hover cases passed, including cached formatted content without focus, preview transfer/re-entry, subsequent scroll dismissal, pending blur/scroll cancellation, touch/pen exclusion, internal preview scroll, persistent editor suppression, cached note updates, pointer-down cancellation and disposal.
- Physical iPhone/iPad interaction remains unverified. Desktop in-app verification is separate from the synthetic browser fixtures.

## Local installation

Installed main.js, styles.css and manifest.json into the existing 1-Academic/.obsidian/plugins/study-pdf-local directory. All three installed artifacts match source byte-for-byte. data.json, note-marker-positions.json and pomodoro.json remained byte-identical. No PDFs/workspace files were changed. Final source was approved by Sol High and code-reviewer.

## Live macOS check

Obsidian initially retained its older running plugin despite refreshing manifest metadata. The existing plugin was disabled and re-enabled through Community plugins, then its new controls were confirmed live. On the open slater2022 PDF, the green filter changed six visible annotations to one and updated copy/export controls to visible entries. An existing comment opened with Bold/Italic/Bullets/Preview controls. A selected phrase was bolded in the unsaved draft and rendered in Preview; the draft was cancelled without clicking Save. The plugin remains enabled and the article is open. Physical-device hover and iPhone/iPad behavior were not tested; browser hover event fixtures are separate.
