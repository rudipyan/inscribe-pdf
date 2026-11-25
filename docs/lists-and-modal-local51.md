# Lists and simplified annotation actions — local.51

Sol High provided the bounded plan; Luna Max implemented the change. Code-reviewer approved the final delta.

The note toolbar adds Numbered list. Bullets insert a visible Unicode • prefix; unordered previews use disc markers. Legacy dash/star lists still render, and numbered lists retain source start/item numbers. List conversion and toggle work on empty prefixed items as well as text; indentation, blank separators, trailing-newline selection bounds and caret mapping remain covered. Bold/italic preserve list prefixes.

Highlights & notes now offers only Copy annotations and Export annotations alongside existing color filters. Copy emits visible quoted text and notes as Markdown without links. Filtered export uses visible entries and captures the original fingerprint before closing; unfiltered export retains its original callback and filename behavior. Selection checkboxes and per-row copy controls were removed, with responsive CSS adjusted. No filter rescans were added.

Verification: 24 relevant tests passed across five files, including PDF note save/reopen. Production TypeScript/esbuild build and whitespace check passed. Full suite:438 passed/22 failed/460 total, versus local50:435 passed/22 failed/457 total. No new failed test names; pre-existing failures remain. The reading, native selection, hover and PDF mutation/persistence source paths are byte-identical to the before-change baseline.

Installed main.js, styles.css and manifest.json into the existing 1-Academic plugin directory; all three match source byte-for-byte. data.json, note-marker-positions.json and pomodoro.json remained byte-identical. No PDF files were edited during installation. Physical iPhone/iPad behavior remains unverified.
