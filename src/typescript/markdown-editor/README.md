# `@joinezco/markdown-editor`

A WYSIWYG Markdown editor built on Tiptap/ProseMirror: files stay plain
Markdown, and every syntax the editor understands serializes back to the
text it was parsed from.

It owns the syntax and editing of one document. Everything that spans
documents (what a link points at, backlinks, search, moving files) comes from
the host as an interface, most often a `Vault` from
[`@joinezco/vault`](../vault) over a [`@joinezco/storage`](../storage)
filesystem, so the same editor runs over OPFS in a
browser, the host disk in eznote, or a granted directory through the icanhaz
daemon.

```ts
import { createEditor } from '@joinezco/markdown-editor'
import { Vault, newNoteId } from '@joinezco/vault'

const vault = await Vault.open(fs) // any VfsInterface
const editor = createEditor({
    element,
    fs: { fs: vault.fs, filepath: 'index.md', autoSave: true },
    links: { resolver: vault.links, index: vault.links }, // wikilinks, backlinks panel
    search: vault.search, // the ⌘P palette
    files: vault.files, // create / rename (links kept) / delete
    frontMatter: { assignId: () => newNoteId() }, // stable note ids
    fileTree: {}, // the vault as a tree, shown on ⌘⇧E and not before
    comments: { author: 'theo', index: vault.comments, reactions: vault.reactions }, // documents, opened from their text
})
```

Nothing shows beside the note until asked for: the file tree (⌘⇧E), the
backlinks (⌘⇧L) and a note's properties (one small line at its top opens
them) all keep out of the way until then. A host that wants a panel in view
from the start says so (`fileTree: { open: true }`,
`links: { panel: { open: true } }`). The column the outline and the file tree
share folds away on the chevron in its corner, or ⌘⌥B. The note's text keeps
to a column of some seventy-five characters (`--ezco-mde-measure`); the row
of rail, gutter, column and comments is centred as one in a wider host, so
the gutter stays at the text's edge. Right of the note stands the
annotation column, with a mark on the first line of each comment's text.
The note's comments take what is past that, in a panel beside the note,
and open from their marks within the note, each under its text, where
there is no such room (or when the panel has been put away; the setting
`comments.inline: false` floats them over the note's edge instead); asked
for all the same, the panel slides over the note's edge instead.

With `fs` alone the editor keeps a vault of its own over it, so wikilinks,
search and renames work without the host building one.

## Versions and edits from elsewhere

Given `versions: vault.versions`, the editor loads and saves through the
vault's version log: a save names the version it was made on, and if the
file changed underneath, the edits are kept as a conflict copy
(`persistence.subscribe` hears `conflict`) and the note shows the file as
it now is. A note with nothing unsaved follows its file when something
else changes it.

Something other than the person typing (an agent, a tool) changes an open
file through the editor, not under it:

```ts
const docs = openDocuments(editor)
const doc = await docs.read('notes/plan.md') // { text, version }
await docs.edit('notes/plan.md', doc.version, [{ range: { from: 0, to: 5 }, text: 'Hello' }])
```

Edits are LSP-shaped (offsets, or lines and characters) on a document
version that moves with every change; a stale one is refused. They are
applied as one transaction that keeps the caret, then saved.

## Comments

A comment is a document that quotes a passage of another and says
something under it: the reference is an embed of a range, the text is what
follows it, and a reply is a document quoting a comment's text ([the
comments RFC](docs/comments-discussions-rfc.md)):

```markdown
![[Plan#:~:text=ship%20it]]

Which release? The next one, I'd say.
```

The editor finds each comment's passage in the open note (a quote as
written, regardless of case, or approximately after an edit made elsewhere;
a pin; a block id) and highlights it; where two comments' passages overlap,
the overlap is marked deeper, and clicking it looks at each in turn. A
comment on the whole of a document (a reply quotes the whole of the comment
it answers) highlights nothing and sits at the top.

Each comment is marked in the annotation column right of the note too: a
speech bubble in the comment colour on the first line of its text (empty
and grey for a resolved comment, whose text reads as text again; one mark
for a line two comments start on). The mark is the way to the comment: with
nothing beside the note showing the comments, a click on it opens every
comment on that line as a bubble within the note, right under the block
its text is in, in the note's own flow, so what follows moves down and
nothing is covered (one under the other where they share a line; the note
scrolls to show the whole bubble; the bubble slides in sideways from under
the mark's column, clipped at the note's edge so it passes over nothing,
as its row opens and what follows moves down, and goes back out the same
way, so the eye can follow from the mark), and a second click closes
them. The setting `comments.inline` (off; or the host's
`comments: { margin: { inline: false } }`) floats the bubbles over the
note's edge instead, under their text and never off it, the note's end
extended for one under the last lines. A click on the
highlighted text only places the caret, unless the host asks for more
(`comments: { openOnClick: true }` looks at the comment clicked, or at each
in turn where comments overlap). A bubble shows who and when, and
its text shown exactly as the note shows text (a read-only editor of the
note's make, so a fence named by a file holds the file's lines, fences
inside it included). Under the text, in the bubble, are its reactions,
React (the common and recent reactions by the control, the whole grid
behind them) and, at the row's end, the reply count. The chevron in the
bubble's corner opens on the reactions to give too, and then the actions
in groups: Edit and Reply, Resolve, Open as file, Delete, Show in comments
panel and Close. Long
text folds after a few lines, with "Show more" under it. The reply count is
the handle of the comment's thread: pressed, its pill grows into a frame
around the row and the replies under it, each a bubble of its own, and
shrinks back into the pill when they are folded away; a reply being
written goes last in the frame. A reply's own answers stay behind its own
count. [−] after any byline collapses that message and everything under it
to the byline; [+] brings it back. Nothing holds the bubbles: they stand on
the note (a floating bubble never runs past the note's frame: what is more
scrolls inside it). Escape or Close closes the bubble, a click elsewhere in
the note every one. With room past the note's text column, every comment
shows from the start in a panel beside the note, a list that scrolls on
its own under a fixed head; there the mark looks at its comment (at each in
turn where two share the line). A bubble in the panel is the way to its
text: a click on it (its text included) takes the note to it, the text's
first line level with the top of the bubble (the list meeting it where the
note cannot). As the note scrolls, each bubble steps out towards the text
(32px at most) by how near the reading line is to its lines, and by that
alone, so one steps out at a time; the one nearest is the current one, with
the accent's hairline. The chevron in the panel's head holds its settings, as switches:
"Anchor comments to text" keeps every bubble level with its lines instead,
still, scrolling with the note under a head that stays at the top of the
frame (the choice is kept), "Show resolved" brings the resolved ones back,
and "Hide comments panel" puts the panel away, as ⌘⇧M does; it
stays away, across notes and sessions, until "Show in comments panel" (or
⌘⇧M) brings it back; asked for where there is no room beside the note, it
slides over the note's right edge instead, and
rests at the edge, with a handle, when the pointer leaves it. A host can
keep comments over the note (`comments: { margin: { layout: 'float' } }`) or
start anchored (`layout: 'column'`). Quotes
keep up with editing: words changed here are re-quoted where the comment
lives when the note is saved; text no quote can tell apart is pinned instead.

Given `comments: { author, index, reactions }` (a vault's `comments` and
`reactions`; the editor's own vault's with `fs` alone), comments are
written as `author`: select text, then Comment or ⌘⌥M, and a composer opens
over the note by the end of the selection, whatever the layout (a panel
beside the note shows the comments, never the composer). A comment, a reply (right under the comment it
answers) or an edit is typed in a bubble, in the editor's own syntax, its
Cancel and its one filled button in the bubble's foot; ⌘/Ctrl+Enter posts. What is
typed and not posted is a draft, kept in this browser on its own and back
in the field when it is opened again. A new comment put down with
something typed keeps a mark of its own on its line, a dashed bubble in
the accent (lit while its composer is open): a click on it brings the
composer back on the same words; a comment whose reply is drafted carries
a dot on its mark. Posting makes the comment's document,
`comments/<note>/<author> <date> <time>.md`, whose name is read back as
who and when.

A comment written at length is a document like any other: Open as file
(in a bubble's menu, or a composer's) loads it in the editor itself, where
the reference at its top is an embed of the passage and the text goes
under it; a document left with nothing written under its reference is
removed again.

A quoted passage, wherever it is shown (a comment document opened as a
note, a reply's reference), is a portal into the other
document: the words in full, their paragraph around them in the muted
colour when the passage sits in plain prose, named over them with who
wrote the document (a comment's) and the lines they are on; its header
opens the note there. Reactions are per-identity state in the vault, not
documents; a ✅ resolves. `editor.storage.comments` has the comments and
`exportAnnotations()` (W3C Web Annotations).

## What it understands

| Syntax | Notes |
|---|---|
| CommonMark + GFM | headings, lists (the marker kept: `-` or `*`, `1.` or `1)`), task lists (their marker and tightness kept too), tables (a cell's blocks on one line, a table without a header row under an empty one: never a marker in place of the table), quotes, code fences (CodeMirror, real LSP; a fence named by a file writes through to it). `<` and `>` are text, escaped only where `<` would open an autolink |
| Lettered lists `a.`, `a)` | Pandoc's fancy lists: `a.` or `a)` (and `A)`, or `A.` with two spaces after it, so an initial is not a list), kept as written, numbered on from the letter typed. Lists of one kind nest in another; a marker typed at the start of an item (`1. `, `a) `, `- `, `* `, `- [ ] `) makes the item one of that kind, in a list of its own |
| Unnamed fences ```` ```ts ```` | with `codeblock: { standIns: true }` (off by default: it writes into the host's filesystem), a fence of a language with language services (`ts`, `js`, `py`, `rs`, `go`) is opened as a hidden stand-in file beside the note (`.plan.1.ts` for the first `ts` fence of `plan.md`), so completions and diagnostics work without naming a file; the note stays as written, and the block's toolbar names the language, not the file |
| File regions ```` ```src/lib.rs#L40-L80 ```` | some lines of a file, numbered as the file numbers them. A block's toolbar takes `path#L2-L3` to open those lines; its menu has "Show only these lines", "Show the whole file" and "Copy link to lines" (the `path#L…` a fence or an embed takes). The file is the source of truth: the fence's body is the lines as last seen, taken from the file when the note opens (found where they moved to, if they did); an edit goes back into the file where the lines are then, and the range follows the lines it holds. A save whose lines changed in the file meanwhile is kept as a conflict copy |
| Wikilinks `[[note]]`, `[[note\|text]]`, `[[note#heading]]`, `[[#heading]]` | resolved by the host; a dangling link is dimmed and creates its note when followed; `[[` offers the vault's notes |
| Embeds `![[target]]` | an image by name, a note or one of its sections (read-only), or a card that opens the file (`![[src/lib.rs#L40-L80]]` names its lines; to show and edit them, use a fence) |
| Images `![alt](path)` | read from the vault as bytes; `\|200` in the alt sizes; pasted or dropped images are stored under `attachments/` |
| Front matter | the YAML in a code block of its own (as the note's fences are, without the toolbar), folded to one small line at the top of the note ("2 properties · id, title") when it is not being edited; a click on the line, arrowing up into it, or "Edit properties" in its gutter menu opens it, and leaving it folds it again, unless "Collapse when not editing" in that menu is turned off (the choice is kept); `id:` assigned on first open when the host asks |
| Blank lines | blocks are spaced by the editor; a run of blank lines between two paragraphs, typed or pasted, is kept all the same, each past the first an empty paragraph (written as `&nbsp;`) |
| Math `$…$`, `$$…$$` | KaTeX by default (loaded on first use), any `MathRenderer` otherwise; prices stay text |
| Footnotes `[^1]` | numbered by first use, definitions kept where written |
| Bracketed spans `[text]{#id .class key=value}` | Pandoc's and Djot's attributed text; a comment's pin |
| Callouts `> [!note] Title` | kinds and aliases, fold markers, Obsidian's syntax |

Every extension is exported on its own; `markdownSetup()` returns the default
set (`minimalSetup()` a lean one) for `new Editor({ extensions })`, and
`createEditor()` also builds the default layout (toolbar slot, left column,
block-action gutter).

In the gutter every block has its glyph (what it is: ¶, H2, •, </>, ---),
soft until pointed at, the active block's at full strength beside the
indicator's line, which alone follows the caret from block to block. A
glyph opens the block's menu (⌘/ from the keyboard): what its type can
become or do, then Comment (the block quoted, the composer by it) and Fold,
which folds the block to one line of its first words and a count; the
line, its glyph in the gutter, or the caret moving into it opens it again.
Folds are the view's, not the note's. A selection spanning blocks folds, or
is commented on, together.

The outline lights the section being read as the note scrolls, and scrolls
itself to keep that entry in view when it is longer than its column.

## Models

Given `inference` (the editor's `Inference` interface, a streamed
completion; icanhaz-web's `editorInference` makes the daemon's capability
one), the selection and slash menus offer Rewrite, Summarize, Continue
writing and Ask…: the answer streams into a panel under the text and goes
in only when accepted.

## Keys

- ⌘P / Ctrl+P: the toolbar as a command palette (files by name, notes by
  text, opening at the match); ⇧⌘P, or `>` first: the editor's commands.
- `/`: slash commands; `:` then two letters: emoji; `[[`: link to a note.
- ⌘/Ctrl+Enter or a click: follow a link. Backspace after a wikilink: edit its
  source. A link ends with its text: what is typed after a pasted URL is
  text; "Link" in the selection menu takes the link off what is selected.
- `` ` `` around text makes it code, the closing one first or last: with a
  lone backtick after the caret, a backtick typed closes the pair around
  what is between. Over a selection, `` ` `` makes it code and `[` brackets it.
- In a list, Backspace in an empty item takes the item away and nothing
  else (the items after it keep their place and depth; ⇧Tab takes items
  out of a list). Enter in an empty item leaves the list.
- ⌘⇧E / Ctrl+Shift+E: show or hide the file tree (nothing of it shows until
  then; `fileTree: { open: true }` starts it open). In it: arrows, Enter, F2
  to rename, Delete (asks first), Escape to close it and return to the note.
- ⌘⇧L / Ctrl+Shift+L: show or hide the backlinks under the note (`links:
  { panel: { open: true } }` starts them open).
- ⌘⌥M / Ctrl+Alt+M: comment on the selection. In a comment box,
  ⌘/Ctrl+Enter posts and Escape cancels; in an open comment, Escape closes
  it.
- ⌘⌥B / Ctrl+Alt+B: fold the column beside the note (the outline, the file
  tree) away, or bring it back.
- ⌘⇧M / Ctrl+Shift+M: every comment in a panel beside the note, or the
  panel put away.

## Settings

What the editor does by default, a reader may want otherwise: where
comments show, how far a card steps out, the face the note is set in,
whether a note's properties fold. Those are settings, kept as files in
the vault (`.settings/<user>/`, YAML; [docs/settings.md](docs/settings.md)
has the design), in scopes: everywhere, this device, this editor
instance (`settings: { instance: 'notes-pane' }`); a more specific scope
wins. Type `settings` in the toolbar for them as switches and values (the
scope a change goes to first, the file to open last); or open the file
as code, with completion and checking from the schema; the panel's own
switches write the same files. A file edited by hand, or by a sync from
another device, reaches the editor as it changes. `settings: false`
leaves every choice the editor's own, and the panel's choices in this
browser as before.

## Type and theme

The note is set in `--ezco-mde-font`, Source Serif 4 by default. The
package ships the face (`import '@joinezco/markdown-editor/fonts.css'`,
the two variable files under `fonts/`, OFL licensed); without that import
the system serif stands in. A host sets the token to use its own face,
and a browser fetches a face only once text is set in it, so one that
does never downloads ours. The chrome around the note (menus, panels,
cards) is set in `--ezco-mde-chrome-font`. Colours follow `data-theme`
(`light`, `dark`) on the root or the editor, or the system when there is
none; every colour is a `--ezco-mde-*` custom property.

## Develop

```sh
pnpm dev          # the demo page (the package's own files as a vault; its window is dragged narrower by its edges)
pnpm test:run     # vitest in browser mode
pnpm typecheck
pnpm build        # dist/, which dependents consume
```

Browser suites can fail cold and pass warm when Vite re-optimizes
dependencies; run again before believing a failure.
