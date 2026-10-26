# @joinezco/markdown-editor

A Tiptap/ProseMirror Markdown editor (one document; the vault around it is
`@joinezco/vault`, files are `@joinezco/storage`, code fences are
`@joinezco/codeblock`). The README is the feature reference; the docs in
`docs/` are the design of record. This file is what an agent needs before
changing the editor's UI.

## Commands

- `pnpm dev`: the demo on http://127.0.0.1:5173 (it exposes `window.editor`).
  Check whether one is already listening before starting another.
- `pnpm test:run` (or `./node_modules/.bin/vitest run <file>`): every suite
  runs in headless Chromium through Playwright, so layout, computed styles
  and real keys are the browser's. Run vitest from this directory: from the
  monorepo root it picks no config and every browser test fails to import.
- `pnpm typecheck`: `tsc` against `tsconfig.app.json`. `tsc -p .` checks
  nothing (the root tsconfig is references only), so never report "typechecks"
  from it.
- `pnpm build`: the library (`tsconfig.lib.json`) to `dist/`, which the apps
  consume. The demo consumes `@joinezco/codeblock` from its `dist` too: after
  editing codeblock, run `npx tsc` there.
- `pnpm shot out.png --eval "…"` (`scripts/shot.mjs`): a screenshot of the
  demo after running a snippet against `editor`, at a given width, dark or
  light. The way to look at what you changed.
- `@joinezco/config` (`../config`), `@joinezco/vault` and
  `@joinezco/codemirror-json-schema` (the fork, a submodule at
  `../codemirror-json-schema`, behind the settings file's completion and
  checking) are consumed from their `dist`: after editing any of them,
  `pnpm build` there.

## Verify UI work in a browser, before and after

Earlier UI changes shipped with things nobody had looked at (cards rendered
off-screen, a panel on the wrong side, a style change that broke code
blocks). The suite did not catch them because most tests drive the editor
through `editor.commands` rather than input, measure little, never render
dark mode or narrow widths, never assert a screenshot, and never open the
demo. So, for any change that shows:

1. Shoot the state before and after with `scripts/shot.mjs`, light and
   dark (`--dark`), wide (1400) and narrow (1000, where the comments panel
   floats), and look at the images. Say in the hand-off what you looked at.
2. Add or extend a browser test that *measures* the change (rects, computed
   style) and drives it the way a person would (`userEvent.keyboard`,
   `userEvent.click`), not only through commands. `comment-margin.test.ts`
   and `lists.test.ts` show the pattern; `src/test/utils` has `waitFor`.
3. Run the suites of everything that shares the surface: a style under
   `.ezco-mde-body` reaches code blocks, comment bubbles and the composer
   (all are `.ezco-mde-body`); the gutter touches the rail; the measure
   touches the comments panel. `layout`, `list-alignment`, `codeblock`,
   `comment-margin`, `rail`, `nav-layout` are the usual set.
4. Failure screenshots land in `src/lib/editor/extensions/__screenshots__`
   (gitignored): read them before guessing at a failing layout test.

## Rules the owner has set

- Chrome is quiet: nothing shows beside or above the note until asked for
  (a key, a palette command, a click on an affordance). Hosts opt in.
- New UI reuses the chrome language in `src/lib/editor/styles.ts`:
  `--ezco-mde-chrome-font` at 13px, the `--ezco-mde-context-menu-*`
  surface, `--ezco-mde-accent`, `--ezco-mde-chrome-shadow`, meaning colours
  (`--ezco-mde-danger`, `--ezco-mde-warning`, `--ezco-mde-comment-color`).
  No colour literal or font stack in a component rule. The note's face is
  `--ezco-mde-font`; the chrome's is not.
- Comments (the work is off for every editor until it ships: the switch is
  `extensions/comments-feature.ts`; the tests turn it on in
  `src/test/utils/setup.ts`, the demo with `?comments` in its URL, so
  `pnpm shot` takes `--url 'http://127.0.0.1:5173/?comments'`): bubbles
  stand on the note, one renderer (`comment-render.ts`)
  for anything that shows a document, the composer's buttons inside the
  bubble, a floating card stays under its text (the note scrolls for it),
  the composer for a new comment floats over the note by its text in every
  layout (`.ezco-mde-comment-over`), the panel's settings live in its
  head's chevron as switches (`checked` menu items; the head has no ×),
  anchored cards are still (no scroll translation) under a sticky head,
  a panel's cards step out by the note's scroll alone (never because one
  was clicked), and a comment's mark is a bubble icon in the annotation
  column right of the note (`.ezco-mde-annotations`, `comment-gutter.ts`),
  the only way to a comment when nothing beside the note shows them: a
  click opens every comment on that line within the note, beside its
  text, the block narrowed into one column and the card in the other,
  level with the text's line (`comment-inline.ts`: a node decoration
  classes and pads the block, a widget at its start holds the card, the
  margin measures; under the block where it cannot be narrowed, code or a
  table's cell, or `comments.beside` is off; `comments.inline` off floats
  them over the note's edge instead), a second closes them; a draft put
  down keeps a dashed mark of its own; a
  click on commented text only places the caret unless the host sets
  `comments.openOnClick`. See the README.
- Lists: every kind round-trips as written (markers, numbers, letters,
  delimiters); a marker typed at the start of an item retypes the item
  (`lists.ts`); Backspace in an empty item removes that item and nothing
  else (`ListItemBackspace`): taking items out of a list is ⇧Tab's job.
- Settings (`settings.ts`, `docs/settings.md`): a feature that prefers one
  of several reasonable behaviours declares a setting for it in
  `EditorSettingsSchema` (a default and a line of description), reads it
  where the choice is made (`settingsOf(editor)`: `get` for the editor's
  own default, `chosen(path) ?? option` where the host's option is the
  default), and never keeps a reader's choice in localStorage of its own.
  What only a host can know stays an option. The schema is the toolbar's
  settings mode, `schema.json` and the file's completion: nothing to add
  elsewhere.

## Gotchas that cost a round each

- Block spacing lives under `.ezco-mde-body` as `&.ezco-mde-body > * + *`
  (the class doubled for specificity); written `& > * + *` it loses.
- CodeMirror sets `display: flex !important` on `.cm-editor`: hiding one
  needs `display: none !important`.
- The note's column is `--ezco-mde-measure` on `.ezco-mde-body-host`;
  `comment-margin.ts` reads that `max-width` to decide whether a panel fits.
  A host must let the editor's row shrink (`min-width: 0` up the chain) or
  the panel widens the page instead of floating.
- Tiptap mounts after a tick: a test that creates an editor and types at
  once sees the pre-mount selection. Wait a frame, then focus.
- HTML matches the `type` attribute without regard to case: `ol[type="A"]`
  takes `type="a"` lists too. Style on `data-list-type`.
- A floating card is part of the scroller's overflow: to scroll it into
  view past the note's end, grow the note's host (padding), not the scroll
  range, and force a layout before a smooth scroll (Chromium clamps the
  target to the range as it was).
- Looking at a comment redraws its card on `mousedown`, so no `click` is
  delivered: act on `mouseup` with a press recorded.
- Lettered lists (`a.`, `a)`) are parsed by swapping each letter marker for
  `1` while markdown-it's own list rule runs (`lists.ts`); a numbered list
  with the same delimiter right after must bound that rule's `endLine`.
- `new Editor({ editable: undefined })` makes every code block read-only:
  `createEditor` spreads only the options given.
- The shell's working directory is not stable across parallel tool calls:
  use absolute paths or a subshell `(cd … && …)`.
- A gutter glyph is placed from its block's line box (the block's content
  top and line-height), never centred on the first character's rect:
  Chromium floors the half-leading when a face's rounded content height
  is odd, so the character sits half a pixel off the line's middle. Set
  `top` to the subpixel (`toFixed(2)`), not rounded.
- The face's own ¶ hangs below the baseline: the paragraph glyph is drawn
  (`PARA_ICON`) at the cap height measured from the face with canvas
  `measureText('H')`, on a line of the text's font.
- Comment ids have spaces in them (`comments/Review/alice 2026-09-13
  12.01.md#1`): never join them with spaces in a data attribute.
- `frames()` in `comment-margin.test.ts` waits on every animation in the
  cards; with a composer open one never ends. Wait for a measurable state
  (the card's `style.top`) instead.
- Tiptap 3.31's list keymap (priority 101) lifts an empty item on
  Backspace, dragging the items after it along and out of the list a level
  per press; `ListItemBackspace` (priority 110) runs first. Tiptap's `Link`
  is inclusive whenever `autolink` is on (typing after a pasted URL extends
  it): `ExtendedLink` sets `inclusive: false`.
- The demo's `App.css` once zeroed the note's 4px left padding, so spacing
  judged in the demo differed from the library's. Measure in the demo and
  in a test, and keep the demo on the library's paddings.
- `region-fence.test.ts`'s file-search case times out under the whole
  suite's load (it passes alone every time): re-run the file alone before
  calling it a regression. A vitest run can also wedge on a cold cache's
  "optimized dependencies changed. reloading" mid-run; if a run is silent
  for minutes with idle Chromium processes, kill it and run again.
- Comment ids in a mark's `data-comments` are in text order: on a line two
  comments start on, the one whose text starts first comes first, and is
  the one a toggle looks at.
- Settings are read asynchronously (a file read): a feature built before
  they arrive sees the defaults, then `subscribe` fires once they are in.
  Tests `await settingsOf(editor).ready`, or `waitFor` the effect.
- zod's `.parse({})` on the editor's schema throws (nested objects have no
  default of their own); the defaults come from `defaultsOf` over the JSON
  schema instead.
- tiptap-markdown gives only `bulletList` and `orderedList` a `tight`
  attribute and writes task lists with its one `bulletListMarker`, so the
  task list is ours (`TaskList` in `lists.ts`): marker, tightness, our
  serializer, its task-list plugin applied once through `setupOnce`.
- The root `package.json` pins one CodeMirror for the workspace
  (`pnpm.overrides` for `@codemirror/state`, `view`, `language`,
  `@lezer/common`): the codemirror-json-schema fork's own node_modules
  held newer minors, and an extension made by another copy of
  `@codemirror/state` is not recognised by the editor's. Vite's
  `resolve.dedupe` in vitest.config.ts is the belt to those braces.
- The demo serves the workspace packages as source, so Vite pre-bundles
  their dependencies as it finds them: a language the code block loads
  lazily was bundled apart from the CodeMirror the block had already
  loaded, two `@codemirror/state`, and nothing was highlighted, with no
  error. `optimizeDeps.include` in vite.config.ts names all of CodeMirror
  (mirroring vitest.config.ts); after changing either list, or the
  lockfile, `rm -rf node_modules/.vite` and restart the dev server, and
  wait for its two reloads before shooting.
- A ProseMirror plugin that reads another plugin's state in its `apply`
  must come after it in the state: Tiptap puts a later extension of the
  same priority *first*, so `CommentInline` is `priority: 90` to follow
  `Comments`. Read too early, `getState` is the previous transaction's.
- A quoted passage is looked for in the prose first and only then in
  code (`locateTextFragment`, `proseOf`): a fence that embeds a file
  holding the note's own words (the demo's `src/example.ts`) used to take
  a comment meant for the paragraph.
- A row animated shut by `height` alone still holds its neighbours
  apart: the margins of a box of no height collapse through it. Animate
  `marginTop`/`marginBottom` to 0 with the height (`shut()` in
  `comment-margin.ts`), and clip with `overflow: clip` plus an
  `overflow-clip-margin` for the bubble's shadow, not `hidden`.
- ProseMirror hands a selection to a node view (`setSelection`, which the
  front matter uses to open its YAML) only when the editable itself holds
  the focus: `view.hasFocus()` is `activeElement === view.dom`, false with
  the focus in the block's own header or a menu, though both are inside
  `view.dom`. A command that sends the caret into such a node focuses the
  view when `!view.hasFocus()`, not when `!view.dom.contains(activeElement)`.
- The front matter's header is a CodeMirror panel (`showPanel`) with the
  code block toolbar's classes, so the toolbar's rules draw it; its
  dropdown is the toolbar's `cm-search-results` markup. Folded, the
  `.cm-scroller` is hidden, not the `.cm-editor`, or the header would go too.
- A style set straight on a block's element in the editable is a DOM
  change ProseMirror observes (a node with content ignores no mutation):
  it marks the block dirty and draws it again, without the style. A
  block's padding and height for a card beside it go through the node
  decoration's `style` (`rowStyle`), applied with the view's observer
  stopped; the margin measures, and dispatches when the numbers change.
  Only a widget's own box may be styled directly (its mutations are
  ignored). WAAPI animations are no mutation, so a row can still be
  animated on the element.
- The icon font is the Nerd Font's *Propo* build
  (`public/fonts/UbuntuMonoNerdFontPropo-Regular.ttf`, the same file in
  codeblock, eznote and ezco-web). Its icons' advance widths are their
  drawn widths, so an icon centred or right-aligned by its box lands where
  it looks; the plain build keeps every icon to one cell and overhangs the
  next, which put every icon a few pixels right of centre. Letters stay
  monospace, so `ch` still measures a cell. Icon columns are padded `3px`
  (CodeMirror's gutter padding), no longer `1ch + 3px`.
- CodeMirror's base theme makes `.cm-scroller` a flex box with
  `!important`: hiding it (a folded code block, the folded front matter)
  needs `display: none !important`.
- The menus that filter by typing without a trigger in the text (the
  callout kinds, `CalloutKindMenu`) take their keys on the document in the
  capture phase, ahead of ProseMirror, so nothing lands in the note while
  they stand; `SuggestionMenu` takes a `rect` to open by a button instead
  of a range, and `show()` a selected index.
- A fold's head keeps `max-height: 1lh` with `overflow: hidden`
  (content-box, so a padded block's first line is whole); the ellipsis is
  a widget *between* blocks, placed by script at the first line's end
  (`FoldMarks` in folding.ts), since a mark inside the head would be cut
  with the head's second line.
