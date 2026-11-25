# Inscribe PDF

Inscribe PDF is an Obsidian PDF reader and in-file annotator by **Rudi Sayat Pulatyan**.
Originally forked from [Study PDF](https://github.com/gris/study-pdf) `0.4.4` (commit
`b646a401c18624434f770b7a6d78ae725a91d437`) by João Gris, MIT License; see
[`LICENSE`](LICENSE).

Inscribe PDF retains standard in-file PDF highlights and notes while adding an editable
highlight palette, exact single-highlight color changes, exact-hex color export, an
in-memory editing session with incremental PDF saves, zoom/rotation-aware pending
highlight overlays, and debounced background disk flushes.

Highlight text and take notes in PDFs from inside Obsidian. Everything is written as
standard PDF annotations directly into the `.pdf` file, so it's portable — highlights
and notes show up in Obsidian's built-in PDF viewer (including inline
`![[file.pdf#page=3]]` embeds) as well as in Adobe Acrobat, Apple Preview, and any
other PDF reader. The file itself is the source of truth; nothing is stored on the
side.

## Screenshots

| Click a highlight | Add a note | Browse everything |
| --- | --- | --- |
| ![Click a highlight to copy or remove it](screenshots/click-popup.png) | ![Note editor popup](screenshots/note-editor.png) | ![Highlights & notes overview modal](screenshots/highlights-modal.png) |

## Features

- **Highlight**: choose a color from the persistent toolbar above the PDF, then
  select text. Each completed selection is highlighted automatically in that color.
  Choose *Select* to read without annotating; selections remain available for copying.
  You can also select text first and click a toolbar color (or use the
  *Highlight selection* command).
  The toolbar stays visible while reading; selecting text never opens a color popup.
  On iPad, choose a toolbar color and drag Apple Pencil across selectable PDF text
  to highlight whole words on release. Fingers remain available for scrolling, and
  Select mode keeps normal text selection. Pencil highlighting works on rendered text;
  it does not add freehand ink.
  New highlights replace existing highlights whose painted text overlaps the selection.
  Separate highlights and other annotation types are preserved. Replacement stops
  if an overlapping highlight has a note or cannot be safely edited; the existing
  annotation stays intact and an explanation is shown. Undo restores replaced highlights.
  Selections spanning rendered pages are saved together as one undo step.
  Full quotation text is stored; only list previews are shortened. Older truncated
  quotes can be recovered from the text layer when the recovered prefix matches,
  but recovery cannot guarantee the original wording or reading order.
  One quad per line, standard
  `/Highlight` annotations with a real appearance stream, so every reader renders
  them. Size and colors are calibrated to match desktop marker tools. Choose from
  the editable palette; changes to palette colors apply to future highlights.
- **Undo and redo**: use the toolbar buttons or the *Undo PDF annotation* and
  *Redo PDF annotation* commands. History stays in RAM and stores whole-PDF
  states, up to 30 steps per PDF and 64 MiB total across PDFs. It clears when
  Inscribe PDF unloads or a PDF is renamed or deleted. If saved bytes no longer match,
  undo stops and clears that history without changing the file. A PDF too large to
  fit one step is saved normally but cannot be undone.
- **macOS shortcuts**: with a PDF pane focused, press `H` to toggle Select and
  Highlight, `1`–`9` to choose a palette color in settings order, `Esc` to return
  to Select, `⌘Z` to undo, and `⌘⇧Z` to redo. Shortcuts stay inactive in editors,
  search fields, and modals. An open annotation popup handles its first `Esc`;
  press `Esc` again to return to Select.
- **Change highlight color**: click an annotation and choose a color dot directly
  in its compact popup. The palette is immediately visible, with the current color
  marked. No dropdown or quoted-text preview. Overlapping annotations have separate
  labeled controls so a change applies to the intended annotation.
- **Reader toolbar**: one icon-only row with Thumbnail first, a separator, grouped Select/Highlight/Area modes, the full custom color palette, and Undo/Redo. Page input/count, native zoom/display, and appearance form a reading group. The fixed right strip contains the compact countdown, Fullscreen, a separator, and Highlights & notes at the far right. Narrow panes keep all tools available through horizontal scrolling, with a thin scrollbar and a trailing fade confined to the scrolling region. Targets are 32px with a fine pointer and 44px whenever touch is available; fullscreen retains the existing translucent surface and safe-area allowances. The secondary native toolbar stays hidden, and its original controls are restored on unload.

- **Study timer**: a compact toolbar countdown shared across PDF tabs and visible in full screen. Its small popup has two minute fields (Study 1–180, Break 1–60), Start/Pause, Reset, Skip break, an optional Repeat toggle, mute/volume, and a gong preview. Repeat is off by default: one study session runs into its break, then stops ready for the next study round. Enabling Repeat cycles continuously. Existing timer state without a Repeat preference also defaults to off. The notification sound is a quiet, locally synthesized gong-style strike. No preset buttons or explanatory paragraph appear in the popup. Running duration changes apply to the next phase; changing the current phase duration while paused resets that phase. A small `pomodoro.json` sidecar preserves preferences/progress/deadline. The clock updates its own subscribers once per second only while running, without PDF work or per-tick disk writes. Background catch-up does not replay old alarms; mobile background chimes remain subject to system restrictions.

- **Return after an internal link**: after a citation or figure link jumps within the PDF, a small arrow appears in the reader's bottom-left corner. Click it to return to the prior reading position and zoom. Consecutive jumps can be retraced up to 20 steps per open pane; this temporary history clears when the pane is replaced or the plugin reloads. It does not scan the PDF or track normal scrolling/text selection.
- **Reading appearance**: use the appearance icon to choose *Original*, *Dark*, or *Sepia*. Dark displays white page text on a black background. The choice applies to the current reader pane, including full screen, and resets when the reader is closed or the plugin restarts. It changes the displayed page only; saved PDFs and stored annotation colors are unchanged. Highlights painted into the page may look different under a display filter.
- **Copy**: click a highlight and use the Copy icon beside the Note icon to copy its full saved highlighted text. Copy is unavailable for imported highlights without saved text.
- **Note markers**: highlights with saved notes show a small message icon in the right page margin. Click it to open the exact note directly. Markers use the viewer's already-rendered annotation data; selection and scrolling do not scan files or rebuild the markers. Drag the closed comment icon with a mouse, or hold it for 350 ms then drag with touch/pen; a short tap opens the note. Custom positions are stored as PDF-space points in the plugin's small `note-marker-positions.json` UI sidecar and reapplied through the native viewport on zoom/rotation. Moving an icon does not move the underlying highlight or rewrite the PDF. The store is bounded to 2,000 placements and 1 MiB and writes only after a drop. Clearing a note or removing a highlight removes its marker; Undo and Redo restore the corresponding state.
- **Notes**: click a highlight and use the Note icon in the popup. The note is
  stored in the annotation's `/Contents` — the standard field — so it appears as the
  highlight's comment in Adobe/Preview too. Unicode-safe. Editing or clearing a note
  also clears imported rich text so an older comment cannot reappear. The editor
  shows pending/saved/failed status, prevents duplicate submission, and retains
  your draft after a failed save so you can retry. Enter/Escape respect IME
  composition. The compact note card has an icon-only grip above the text area:
  drag it with a mouse, touch, or pen to move the open editor over the PDF. The
  text area remains dedicated to typing and selecting. Position is retained while
  the editor is open and clamped to the visible viewport when the keyboard or
  window changes. Focus the grip and use arrow keys to move it with a keyboard.
  The editor automatically fits its content: short notes start at 340 px, longer
  notes at 460/600 px, capped to the visible screen. Height grows with the text,
  then scrolls internally at the screen limit. New notes have a 500-word save
  limit with a visible counter; existing longer notes are never truncated and
  may be edited without exceeding their original word count. Moving the card
  does not move the annotation or write to the PDF.
- **Backspace**: click a text or area annotation, then press unmodified Backspace to remove that exact annotation while its actions popup is open. Typing in a note, editor, page input, search field, or modal retains normal Backspace behavior. Ambiguous overlapping-annotation choosers do not pick a deletion target automatically. Removal uses the usual Undo history.
- **Remove**: click an annotation and choose the white circle with a red slash
  beside its colors. This deletes that exact annotation, including its comment.
  The *Remove highlight at selection* command also opens these controls.
- **Overview**: *Show all highlights and notes* — from the command palette or the
  list button in the unified PDF toolbar — lists every highlight
  in the document (color, recovered quoted text, note, page), with click-to-jump and
  copy buttons — as Obsidian annotation deep links (`#page=N&annotation=ID`) or as
  plain Markdown. Select individual entries to copy or export a subset. The list
  shows scan progress and cancels unfinished work when closed.
- **Export to a note**: *Export highlights to note* writes every highlight into
  `<PDF name> (highlights).md` beside the PDF — grouped by page, colour-swatched,
  each quote a deep link back to its annotation, with your note beneath it. It's a
  sync, not a dump: only the block between the `%%study-pdf:begin%%` /
  `%%study-pdf:end%%` markers is rewritten, so anything you add around it survives.
  Custom and off-palette colors retain their exact hex; palette colors also include
  their name. Existing notes are merged atomically against their latest saved text.
- **Flashcards**: *Sync flashcards from notes* writes spaced-repetition cards into
  `<PDF name> (flashcards).md` — your note is the question, the highlighted text and
  a deep link back are the answer. Only highlights that carry a note become cards.
  The sync **converges**: run it again
  and the file only changes if your highlights did. Edit a note in the PDF and its
  card is rewritten in place; delete a highlight and its card moves to an
  `## Orphaned` section rather than disappearing (put the highlight back and the
  card returns to its page). Either way the card's review schedule travels with it
  — [obsidian-spaced-repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition)
  stores that inline, on the line after the card, so nothing you've already studied
  is reset. Anything you wrote in the file yourself is left where it is. Existing
  notes are merged atomically to preserve concurrent edits and review updates.
  Empty paragraphs inside generated cards become single line breaks; exact old
  card blocks are migrated while ambiguous surrounding text is preserved.
- **Settings**: edit color names and hex values, add or remove colors, and choose
  which color is the default. At least one color remains in the palette.
- **Mobile UI**: touch selection and visual-viewport popup handling are implemented.
  The local palette and recolor UI have not yet been runtime-checked on macOS or
  iPadOS. The updated annotation toolbar and full-screen reading layout still need
  confirmation in a running Obsidian pane. Apple Pencil drag highlighting has not
  yet been verified on a physical iPad.
- **Encrypted PDFs**: permission-restricted files (owner password, no open password —
  the common "protected" textbook/scan) are decrypted transparently. Note the saved
  file comes out decrypted. Files that genuinely require a password to open are
  rejected with a clear message.
- **Annotation updates without a full reload**: on supported Obsidian viewers,
  plugin saves redraw changed pages in the background and refresh their annotation
  layers while preserving the page elements and reading position. Previously
  edited pages are not rebuilt again unless changed; workers remain alive while
  visible layers still reference them. Exact saved-byte checks still allow outside
  edits to reload normally. Unsupported viewers use the reload curtain fallback.

- **Scan and save scheduling**: completed highlight scans reuse an exact-source
  cache limited to four documents, 2,048 entries, and approximately 1 MiB of
  retained entry data. It retains no PDF bytes or PDF.js workers. Large files use
  cooperative parsing/saving; output verification remains enabled. These changes
  have not been timed on physical devices.
- **Earlier color feedback**: new highlights receive an immediate, temporary visual
  preview. Recolors render the updated PDF while the save finishes; parsing and
  rendering still take time. Previews are removed after save completion or failure.
- **Uninterrupted selection**: colors stay in the top toolbar. Highlight mode
  applies after release; intermediate selection changes remain editable. Select mode
  keeps normal text selection available. Reading/highlighting mode and the selected
  color are separate for each PDF pane, including detached windows.
- **Reading layout**: use *Fit width* for PDF.js's native page-width scale. Later
  manual zoom and pinch zoom remain available. Horizontal scrolling is held at the
  page edge only while the visible pages fit the pane, and returns when a page is
  wider or pinch zoom begins.
- **Full-screen reading**: the toolbar stays visible while the selected PDF pane
  expands and its header is hidden. Page, thumbnail, zoom, and annotation controls share the same row; the pinned full-screen button always exits.
  Controls use icons with accessible labels and tooltips. On macOS, Escape first
  leaves Highlight mode, then exits reading mode; editors, popups, and modals keep
  their usual Escape priority.

## Safety

The PDF is fully re-serialized on every save (that's how pdf-lib works), so every
write is verified before it touches your file: the output is re-parsed and checked
(page count, annotation counts) and the write is aborted loudly if anything looks
wrong. Non-highlight annotations — links, form fields, XFA — are covered by
round-trip tests against real-world PDFs.

The plugin modifies PDF files in place and does not create automatic PDF backups.

To keep its popup UI from colliding with Obsidian's built-in annotation popup, the
plugin patches one internal viewer method (restored on unload) and reads the viewer's
internal PDF.js objects. An Obsidian update can break these integration points; the
plugin fails loudly with a clear message rather than misbehaving silently.

## Installation

Disable the original **Study PDF** plugin before enabling **Inscribe PDF** under Community
Plugins so both plugins do not install PDF viewer hooks at the same time.

### Via BRAT (automatic updates)

1. Install the **BRAT** community plugin in Obsidian and enable it.
2. Open **Settings → BRAT → Add Beta plugin**.
3. Enter `https://github.com/rudipyan/inscribe-pdf` and add the plugin.
4. Enable **Inscribe PDF** under **Settings → Community Plugins**.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the
[latest GitHub Release](https://github.com/rudipyan/inscribe-pdf/releases/latest), copy
them into `<vault>/.obsidian/plugins/inscribe-pdf/`, reload Obsidian, and enable **Inscribe PDF**.

## Development

Inscribe PDF is distributed via GitHub Releases and BRAT rather than the Obsidian Community
Plugins directory.

```bash
npm ci
npm test
npm run build
npm run lint
npm run dev     # esbuild watch mode
```

To install locally, build the plugin, then copy the generated `main.js`,
`manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/inscribe-pdf/`. Reload Obsidian, then disable the
original **Study PDF** plugin before enabling **Inscribe PDF** under Community
Plugins, so both plugins do not install PDF viewer hooks at the same time. Copying
the actual build files allows them to sync with the vault; separately verify that both the
plugin files and enabled-plugin setting reach each device, then check the plugin
there. Do not use a machine-specific symlink.

Tests cover the pure modules and the PDF viewer adapter with controlled fixtures;
visual behavior, popups, and selection still need to be checked in a running Obsidian. To update a local install, build
and copy the actual artifacts into the target vault before reloading. Replace
`<vault>` with the vault's absolute path:

```bash
npm run build
mkdir -p "<vault>/.obsidian/plugins/inscribe-pdf"
cp main.js manifest.json styles.css "<vault>/.obsidian/plugins/inscribe-pdf/"
obsidian plugin:reload id=inscribe-pdf
```

then `obsidian dev:errors`, `obsidian dev:console`, `obsidian dev:dom selector=...`,
and `obsidian dev:screenshot path=...` to inspect the result.

`npm run lint` should exit clean. The two intentional exceptions (a version-gated
settings-tab call the linter can't statically verify as safe) are downgraded to
warnings in `eslint.config.mjs`, with the reasoning next to each call site in
`src/settings.ts`.

### Code map

- `src/annotate.ts` — PDF mutation (add/remove/note/recolor/inspect), pure, no
  Obsidian imports. Uses `@cantoo/pdf-lib` (pdf-lib fork with decryption support).
- `src/pdf-annotation-history.ts` — bounded, RAM-only whole-PDF undo history with
  exact-byte validation and per-step page indexes.
- `src/pdf-keyboard-shortcuts.ts` — pure classification for the guarded macOS
  PDF-pane shortcuts.
- `src/palette-editor.ts` — palette model, serialized persistence, and focus-safe
  editor session, with no runtime Obsidian import.
- `src/geometry.ts` — pure coordinate mapping: selection rects → PDF `QuadPoints`,
  calibrated against reference marker software.
- `src/pdf-text-extraction.ts` — pure text recovery: maps a highlight's quads back
  onto a page's text items to reconstruct the quoted text when a highlight has no
  quote stored (highlights made in other readers, or by older plugin versions).
- `src/pdf-highlights.ts` — collects highlights from a PDF.js document, recovering
  page text only where stored quotation metadata is missing or legacy-truncated.
- `src/pdf-highlight-snapshot.ts` — serializes collection with PDF mutations, pairs
  stable annotation references with a same-byte PDF.js snapshot, and rechecks the
  source before derived-note writes.
- `src/highlight-export.ts` — pure Markdown formatting for the exported note and
  the modal's copy buttons, including the managed-block merge.
- `src/flashcards.ts` — pure card formatting and the converging merge (update in
  place, orphan rather than delete) that keeps spaced-repetition schedules intact.
- `src/obsidian-pdf-internals.ts` — the ONLY module touching undocumented
  Obsidian/PDF.js internals (viewer access, native popup suppression).
- `src/pencil-gesture.ts` — Pencil-only text-layer hit testing and DOM selection
  helpers for drag-to-highlight.
- `src/ui/` — icon popup, note editor, reload curtain, highlights list modal.
- `src/settings.ts`, `src/main.ts` — settings tab and plugin wiring.

## Known limitations

- Password-protected PDFs (real open password) can't be modified.
- Scanned PDFs without a text layer can't be text-highlighted.
- The local palette and recolor UI still need runtime verification in Obsidian on
  macOS and iPadOS.
- Annotation deep links (and the flashcard cards keyed on them) depend on the
  annotation's object number. This plugin's own writes preserve them — measured
  across adding, removing, and note-editing highlights on a real document — but
  another tool re-saving the file may renumber, and then only the page part of
  the link keeps working.
- On iOS, pinch-zooming a PDF flickers each page and occasionally lands on a
  different page. This is Obsidian's PDF viewer, not this plugin — it happens
  with the plugin disabled too.
- On iOS, the text you are selecting looks fainter than elsewhere in Obsidian:
  the system draws its own selection tint over the PDF text layer and ignores
  any colour a plugin or theme sets. The saved highlight is unaffected.
