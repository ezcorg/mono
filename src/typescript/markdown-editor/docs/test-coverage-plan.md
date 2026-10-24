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

## Done, 2026-10-13

The plan below was carried out in one day, items 1 to 8, each suite
driven by real input and measuring what it claims; the counts at the end
of this file are the suite after it.

- **Rendering** (`rendering.test.ts`): one note with every block kind and
  an open comment, light and dark at 1400 and 1000, measuring the glyphs
  on their lines, the columns in order, the panel beside or floating,
  nothing wider than the host, the composer's buttons in the bubble, and
  every computed colour of the note, the chrome, the cards and the menus
  being one of the theme's tokens.
- **Menus by real input**: the selection menu's every action
  (`selection-menu.test.ts`), the block menu clicked and keyed
  (`block-actions.test.ts`), the context menu alone
  (`ui/context-menu.test.ts`), the slash menu (`slash-commands.test.ts`),
  the `[[` menu (`wikilink.test.ts`). `menuItem` and `menuLabels` in
  `src/test/utils`.
- **Shortcuts** (`shortcuts.test.ts`): every key in the README's list,
  Mod resolved per platform; the two Control-only suites resolve it too.
- **Code blocks as used** (`codeblock.test.ts`, `code-files.test.ts`):
  typing, arrows out and back, Backspace on an empty fence, the language
  through the toolbar, copy, cut and paste inside CodeMirror, undo across
  the boundary, the theme flipped.
- **Tables and tasks** (`table.test.ts`, `bullet-to-task.test.ts`): Tab,
  Shift-Tab, Enter and the arrows in a table; tasks typed, clicked, mixed.
- **Clipboard and drop** (`clipboard.test.ts`, `markdown-paste.test.ts`,
  `image.test.ts`): real events for every payload, image paste and drop.
- **The hollow tests** listed above all assert now, or are deleted in
  favour of the suite that covers them.
- **Shared utilities** (`src/test/utils/`): editors and vaults, frames,
  tools and menus, positions, keys, clipboard events, in one place.

What the new tests found, each fixed the same day: a list converted from
its menu lost the caret; block Markdown pasted mid-paragraph swallowed the
text after the caret into its last item; `- [x] ` typed on a line made an
unchecked task; a task list was written back with the wrong marker and
blank lines; ⌘Enter just after a wikilink inserted a hard break; the `[[`
menu opened off the page in the demo (found by the dedup pass). The tests
were worth writing.

Still untested: the demo app (resizing, its theme toggle), viewport
changes while panels are open, touch, IME composition, LSP in code blocks,
the outline following edited headings.

## The plan, in order (as written on 2026-10-12)

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
