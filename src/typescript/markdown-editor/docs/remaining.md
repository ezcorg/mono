# What remains, 2026-10-13

What was asked for and not done, what was found on the way and left, and
what was offered and not taken up. Each item says where it would go. The
survey (`duplication-survey.md`), the test plan (`test-coverage-plan.md`)
and the settings design (`settings.md`) hold the record of what was done.

## Comments, off until they ship

The comments work (`comments.ts`, `comment-gutter.ts`, `comment-margin.ts`,
`comment-inline.ts`, `comment-composer.ts`, `comment-render.ts`, the
`comments` group of the settings) is behind `extensions/comments-feature.ts`,
off for every editor: how a comment is shown is not settled, and the
storage model is likely to change. The tests run with it on
(`src/test/utils/setup.ts`); the demo shows it with `?comments`. To ship
it, flip the switch, then take the gate out of `index.ts` and
`settings.ts` and the switch with it.

## Duplication, for a later pass

From the survey's "Still duplicated" list, unchanged:

- 60 bare `createElement` + `className` pairs in fifteen files the DOM
  pass did not touch (`slash-commands`, `wikilink`, `embed`, `sidebar`,
  `ui/context-menu`, `ui/link-popover`, `callout`, `comment-composer`,
  `conflict-notice`, `footnote`, `front-matter`, `folding`, `image`,
  `filesystem`, `source-view`): `el`/`button` from `ui/dom.ts`.
- The storage casts other than `persistence` (`comments`, `markdown`,
  `blockActions`, `settings`, `commentMargin`): a typed accessor each, as
  `settingsOf` and `persistenceOf` are. `comment-inline.ts`,
  `comment-gutter.ts` and `comments.ts` reach `commentMargin` through a
  cast today; `marginOf(editor)` would take the three.
- Seven `const esc = md.utils.escapeHtml` lines and the
  `(tokens, idx) => tokens[idx]` renderer preamble.
- Test files casting `(editor.storage as any).persistence` (30 sites):
  the `filepath()` utility covers the common one.

## Tests still missing

From the plan's "Still untested": the demo app (drag-resizing, the theme
toggle flipping code blocks), viewport changes while panels are open,
touch, IME composition, LSP in code blocks, the outline following edited
headings. Added today:

- The animations of a comment coming into the note and going back (the
  block's padding and height, the card's slide from under the mark) are
  measured at their start, half way and at rest by pausing them; the
  scroll that brings the card into view is not, nor is the under-the-block
  form's motion.
- An inline comment on text in a list item or a quote (beside the
  item's paragraph, narrower), in a table cell or code (under the block,
  as the cell or the fence cannot be narrowed): nothing measures those.
- The draft mark when the note's words change under a kept draft (the
  anchor is a text fragment: found again when the words are, dropped
  when they are not): only the found case is tested.
- Dark theme, still only by screenshot.

## Comments within the note: the experiment's open ends

`comments.inline` (default on) stands open comments in the note's flow,
beside their text (`comments.beside`, default on: `comment-inline.ts`
classes and pads the block through a node decoration and puts the box at
its start; `comment-margin.ts` hosts the card, measures the line and the
card, and slides it in from under its mark as the column opens) or under
the block. Left open:

- Keyboard: the card is reached by a click or its mark; Tab from the
  note does not enter the widget (ProseMirror skips it). A key from the
  mark (Enter on the mark opens; the card could take focus then).
- Selection: a selection dragged across the box skips it
  (`ignoreSelection`); copying such a range copies the note alone, which
  is right, but the box flashes no selection colour of its own.
- The card's column is half the block, up to 300px: a short paragraph
  beside a tall card leaves a hole under its text (the block grows to
  hold the card); a deep list item gets a narrow card. A floor on the
  text's column (falling back to under the block) if asked.
- As the column opens the paragraph's words move between lines for the
  300ms: inherent in a slide that pushes text aside. A cross-fade of the
  text, or narrowing first and sliding after, if it reads as jitter.
- Under the block, the card stands at the note's left across the column's
  width: a reader may prefer it at the text's end. A setting if asked.
- Printing: the box prints with the note. Probably wanted; not decided.
- `comments.inline` off is the floating card as before; the setting could
  go once the inline form has been lived with, taking the floating code
  (`place`, `cap`, `grow`, `settle` in `comment-margin.ts`) with it.

## Offered, not asked for

- **A three-way merge on stale writes in `VersionLog`** (`@joinezco/vault`):
  today a save over a version that moved makes a conflict copy even when
  the two edits touch different paragraphs; only region fences merge
  targeted edits. The design: a stale write becomes a merge version with
  two parents, the base being the common ancestor in the log, merged
  with diff3 and applied as a minimal transaction (as `edits.ts` applies
  a file's change to the open note); a true overlap still makes the
  conflict copy. Tests first. Not started.
- **Live editing**: the RFC keeps live mode opt-in. The bake-off to run
  before choosing: `y-prosemirror`, `loro-prosemirror` and
  `@automerge/prosemirror` against this editor's custom nodes (fences,
  embeds, front matter, callouts, footnotes), measuring what each loses
  in the round trip. Patchwork's pinned Automerge is not the one to take.
  A CRDT kept as files is a sidecar (per-device append-only changes and
  snapshots next to the `.md`, never the `.md` itself).

## Settings

- The code block's own settings (the pseudo-file behind its toolbar
  search) and the editor's schema are two systems. The bridge: a
  `codeblock` section in `EditorSettingsSchema` the block reads through
  `settingsOf`, and the pseudo-file retired, or made a view of the same
  file.
- Access across users is a client-side check (`access.editors`); nothing
  stops a client that lies about who it is. A real guarantee needs the
  filesystem to know users (a server, or replicas verifying signed
  versions). See `settings.md`, "Several users, one vault".

## Housekeeping

- The root `pnpm.overrides` pin one CodeMirror for the workspace because
  the codemirror-json-schema fork's ranges ran ahead; drop them when the
  fork is published with the editor's ranges.
- `@joinezco/config`, `@joinezco/vault` and the fork are consumed from
  `dist`: a build step for the workspace, or source resolution in
  vitest/vite, would end "rebuild after editing" from the hand-offs.
