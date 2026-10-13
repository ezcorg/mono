# Test coverage: where the editor stands, and the plan

Surveyed 2026-10-12 against the working tree (46 test files, about 330
cases, all in headless Chromium through Playwright at 1280×720).

## What is covered

Nearly every extension is reached by some test, mostly indirectly through
`createEditor`. The strong files are `comment-margin.test.ts` (real keys,
measured layout, 31 cases), `lists.test.ts` (typed markers, round trips),
`file-tree`, `emoji-picker`, `region-fence`, `front-matter`, `wikilink`
and the round-trip tables (`table`, `math`, `footnote`, `image`, `callout`).

## How the tests drive the editor

| Kind of test | Cases |
|---|---|
| Real input (`userEvent.keyboard`, `userEvent.click`) | about 50, in 14 files |
| Synthetic events or direct handler calls (`dispatchEvent`, `handlePaste`) | about 75 |
| No input at all (`editor.commands`, raw transactions) | about 210 |
| Measures layout (`getBoundingClientRect`, `getComputedStyle`) | about 50, in 15 files |
| Dark theme | 0 |
| Narrow container (under 700px) | 3 |
| Screenshot assertions | 0 (the PNGs under `__screenshots__` are vitest's failure captures) |
| The demo app (`src/App.tsx`) | 0 |

This is why UI regressions got through: a feature can pass its tests while
nobody has rendered it. See the package `CLAUDE.md` for the working rule
(shoot before and after, measure in a test, run the neighbouring suites).

## Gaps

Features with no effective test:

- `slash-commands.ts`: the one test inserts `/` and asserts nothing. Typing,
  filtering, arrows, Enter, Escape and 12 of the 13 default commands are
  untested (Callout runs once, through the `>` palette).
- Selection menu actions: none of Bold, Italic, Strikethrough, Inline code,
  Link, headings, Quote, Indent, Outdent, Clear, Comment, or the model
  actions are run from the menu.
- The block menu: items are never clicked in the DOM; the context menu's
  keyboard navigation is untested.
- Keyboard shortcuts in the README: ⌘/ , ⌘⌥M, ⌘⌥B, ⌘⇧M and ⌘P are untested
  (tests call the commands); ⌘⇧E and ⌘⇧L use real keys but hard-code
  Control, so they would fail on macOS.
- Dark theme anywhere; `setCodeblockTheme` and theme detection from
  `data-theme`.
- Code blocks in the note: real typing, arrowing in and out, Backspace on an
  empty block, changing the language from the toolbar, copy and cut from
  CodeMirror, undo/redo across node views, LSP (0 tests).
- Tables: Tab and Shift-Tab between cells, Enter in a cell, arrowing out.
- Task lists: clicking a checkbox.
- Clipboard: cut; copy only as a synthetic event; image drop (`handleDrop`).
- Link popover: the URL is set with `input.value`, never typed; Escape; ⌘-click.
- The demo: drag-resizing the window, the theme toggle flipping code blocks.
- Viewport changes, touch, IME composition.
- The comment gutter marks (`comment-gutter.ts`, new) and the outline
  updating as headings are edited.

Tests that pass while checking little: `extensions.test.ts` ("trigger slash
commands" has no assertion, "table navigation" does no navigation, "toggle
task completion" uses `setContent`, "auto-detect URLs" asserts
conditionally); `editor.test.ts` "copy and paste" (no throw only);
`inline-code.test.ts` "real-keystroke" (returns early in a `catch`);
`bullet-to-task.test.ts` (uses `setContent`, never destroys its editors);
`block-actions.test.ts` table check (always truthy) and "Copy contents" (no
throw); `toolbar.test.ts` "opens on ⌘P" (fires ⌘⇧P); `layout.test.ts`
spinner and `codeblock.test.ts` search results (measure injected DOM).

## The plan, in order

1. **A rendering smoke suite** (`rendering.test.ts`): one long note with
   every block kind and an open comment, rendered light and dark at 1400
   and 1000, measuring what the owner has corrected before: glyphs level
   with their lines, the panel beside or floating, nothing wider than the
   host, the composer's buttons inside the bubble, no colour literal
   differing between themes except through tokens. Cheap to write with
   `getComputedStyle`; catches the class of bug that reached the owner.
2. **Real input for the menus**: slash menu (type, filter, arrow, Enter,
   Escape, each default command once), selection menu (each action on a
   selection), block menu (click an item in the DOM, arrow keys), the
   context menu's keyboard. Share one `menu(container, label)` finder in
   `src/test/utils`.
3. **Shortcuts as keys**: every README shortcut pressed with
   `userEvent.keyboard`, Mod resolved per platform (`pressKey` already
   does; use it, and fix the two Control-only suites).
4. **Code blocks as a person uses them**: type into a fence, arrow out and
   back, Backspace on an empty fence, change the language, cut and copy,
   undo across the fence boundary, flip the theme and read the CodeMirror
   theme. These exercise the `@joinezco/codeblock` seam that style changes
   broke before.
5. **Tables and tasks**: Tab/Shift-Tab, Enter in a cell, arrows out; a
   checkbox click; a mixed task and plain list typed.
6. **Clipboard and drop**: cut, copy and paste with real `ClipboardEvent`
   payloads of each kind (text, Markdown, HTML, image), image drop.
7. **Repair the hollow tests** listed above or delete them.
8. **Shared test utilities**: `created`/`afterEach` cleanup, `frames()`,
   `tool()`, `viaMenu()`, a `openVault(files, options)` factory, position
   finders and `filepath(editor)` are each written in 4 to 30 files; one
   module cuts the noise and makes the next test short to write.
9. Later: the demo app (resize, theme toggle), viewport resize while open,
   touch, IME.

Items 1 to 3 are a few days and remove most of the risk; 4 to 6 another
week. Each new test should measure or type, not only call a command.
