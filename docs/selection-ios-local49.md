# iOS live selection — local.49

The recording revealed fixed selection tint escaping over the toolbar. Source audit found full annotation capture on every selection/scroll event and a recognized native-handle release branch that skipped committing.

Sol Medium implemented lightweight native per-text-layer visual geometry, frame-coalesced native events, rectangle reuse, clipping to the visible PDF area, and committing the original capture on actual handle release. PDF.js moves an invisible full-page endOfContent sentinel beside the anchor, including into nested markedContent; visual subranges split around it and preserve text on both sides. Empty/loading selections clear safely. Full quote/quad validation for saved annotations is unchanged, and commit clears the overlay immediately. Select copying, native iOS menu policy, Pencil gesture ownership and document lifetime safeguards remain.

Astra Max and code-reviewer approved the final source. Astra independently ran44 focused tests. Parent production build and whitespace checks passed. Full suite:410 passed/26 failed/436 total; baseline local48:380 passed/26 failed/406 total. Failed test names match exactly; no new failures.

Independent macOS WKWebView synthetic DOM tests reproduced a240px clipped full-page tint before sentinel exclusion, then passed9 cases for trailing/middle/nested sentinels with text endpoints, entire-layer and cross-page ranges. Corrected text rectangles were18–20px high. Those checks validate DOM geometry and original-Range preservation; they do not measure physical iPhone gesture performance.

Installed main.js, styles.css and manifest.json into1-Academic/.obsidian/plugins/study-pdf-local and byte-verified all three. Preserved data.json, note-marker-positions.json, pomodoro.json. No PDFs/workspace files changed.
