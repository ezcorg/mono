# `@joinezco/markdown-editor`

A WYSIWYG Markdown editor built on Tiptap/ProseMirror: files stay plain
Markdown, and every syntax the editor understands serializes back to the
text it was parsed from.

It owns the syntax and editing of one document. Everything that spans
documents (what a link points at, backlinks, search, moving files) comes from
the host as an interface, most often a `Vault` from
[`@joinezco/storage`](../storage), so the same editor runs over OPFS in a
browser, the host disk in eznote, or a granted directory through the icanhaz
daemon.

```ts
import { createEditor } from '@joinezco/markdown-editor'
import { Vault, newNoteId } from '@joinezco/storage'

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
backlinks (⌘⇧L), a note's properties (one small line at its top opens them) and
its comments (a click on commented text opens that comment over the note's
edge) all keep out of the way until then. A host that wants a panel in view
from the start says so (`fileTree: { open: true }`,
`links: { panel: { open: true } }`, `comments: { margin: { layout: 'column' } }`).

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
it answers) highlights nothing and sits at the top. Clicking a highlight
opens the comment as a card over the note's edge: who and when, the text
in a bubble (the reader's own on the right), and under it one quiet row
with its reactions, React, how many replies it has, and "…" for the rest
(Reply, Resolve, Edit, Delete, Open document). The count unfolds the
thread under the message, each reply a message of its own, a reply with
answers folding them with [−]/[+], and a field for the next reply at the
end. Escape or a click elsewhere closes the card. A host that wants every
open comment in view asks for a column beside the note
(`comments: { margin: { layout: 'column' } }`). Quotes keep up with
editing: words changed here are re-quoted where the comment lives when the
note is saved; text no quote can tell apart is pinned instead.

Given `comments: { author, index, reactions }` (a vault's `comments` and
`reactions`; the editor's own vault's with `fs` alone), comments are
written as `author`: select text, then Comment or ⌘⌥M, and a small
composer opens at the end of the selection. A comment or a reply is typed
in the editor itself, in small, and posting makes its document,
`comments/<note>/<author> <date> <time>.md`, whose name is read back as who
and when. **Draft** keeps it in this browser instead: a draft is marked as
such in the note (a dashed underline) and on its card, its own replies are
drafts too, and a bar over the note counts the note's drafts and publishes
or discards them all at once (or one at a time, from a draft's "…"). The
open glyph in the field's corner (⌘⇧↩) makes the document with what was
written, even nothing, and loads it: the editor is then the editor of the
comment, the caret under the reference, whose first block quotes what it
answers and opens the note there with the comment looked at. A document
opened before anything was written, and left so, is removed again.
Reactions are per-identity state in the vault, not documents; a ✅
resolves. `editor.storage.comments` has the comments, `drafts()` and
`exportAnnotations()` (W3C Web Annotations).

## What it understands

| Syntax | Notes |
|---|---|
| CommonMark + GFM | headings, lists (marker kept), task lists, tables (a cell's blocks on one line, a table without a header row under an empty one: never a marker in place of the table), quotes, code fences (CodeMirror, real LSP; a fence named by a file writes through to it). `<` and `>` are text, escaped only where `<` would open an autolink |
| Unnamed fences ```` ```ts ```` | with `codeblock: { standIns: true }` (off by default: it writes into the host's filesystem), a fence of a language with language services (`ts`, `js`, `py`, `rs`, `go`) is opened as a hidden stand-in file beside the note (`.plan.1.ts` for the first `ts` fence of `plan.md`), so completions and diagnostics work without naming a file; the note stays as written, and the block's toolbar names the language, not the file |
| File regions ```` ```src/lib.rs#L40-L80 ```` | some lines of a file, numbered as the file numbers them. A block's toolbar takes `path#L2-L3` to open those lines; its menu has "Show only these lines", "Show the whole file" and "Copy link to lines" (the `path#L…` a fence or an embed takes). The file is the source of truth: the fence's body is the lines as last seen, taken from the file when the note opens (found where they moved to, if they did); an edit goes back into the file where the lines are then, and the range follows the lines it holds. A save whose lines changed in the file meanwhile is kept as a conflict copy |
| Wikilinks `[[note]]`, `[[note\|text]]`, `[[note#heading]]`, `[[#heading]]` | resolved by the host; a dangling link is dimmed and creates its note when followed; `[[` offers the vault's notes |
| Embeds `![[target]]` | an image by name, a note or one of its sections (read-only), or a card that opens the file (`![[src/lib.rs#L40-L80]]` names its lines; to show and edit them, use a fence) |
| Images `![alt](path)` | read from the vault as bytes; `\|200` in the alt sizes; pasted or dropped images are stored under `attachments/` |
| Front matter | one small line at the top of the note ("2 properties") that opens into a table of them; "Edit YAML" beside it, or arrowing up into it, shows the YAML; `id:` assigned on first open when the host asks |
| Math `$…$`, `$$…$$` | KaTeX by default (loaded on first use), any `MathRenderer` otherwise; prices stay text |
| Footnotes `[^1]` | numbered by first use, definitions kept where written |
| Bracketed spans `[text]{#id .class key=value}` | Pandoc's and Djot's attributed text; a comment's pin |
| Callouts `> [!note] Title` | kinds and aliases, fold markers, Obsidian's syntax |

Every extension is exported on its own; `markdownSetup()` returns the default
set (`minimalSetup()` a lean one) for `new Editor({ extensions })`, and
`createEditor()` also builds the default layout (toolbar slot, left column,
block-action gutter).

## Models and plugins

Given `inference` (storage's interface; icanhaz-web's `editorInference`
makes the daemon's capability one), the selection and slash menus offer
Rewrite, Summarize, Continue writing and Ask…: the answer streams into a
panel under the text and goes in only when accepted. `plugins` takes a
`PluginHost`'s contributions: slash commands that insert text, and a
theme's variables.

## Keys

- ⌘P / Ctrl+P: the toolbar as a command palette (files by name, notes by
  text, opening at the match); ⇧⌘P, or `>` first: the editor's commands.
- `/`: slash commands; `:` then two letters: emoji; `[[`: link to a note.
- ⌘/Ctrl+Enter or a click: follow a link. Backspace after a wikilink: edit its
  source.
- ⌘⇧E / Ctrl+Shift+E: show or hide the file tree (nothing of it shows until
  then; `fileTree: { open: true }` starts it open). In it: arrows, Enter, F2
  to rename, Delete (asks first), Escape to close it and return to the note.
- ⌘⇧L / Ctrl+Shift+L: show or hide the backlinks under the note (`links:
  { panel: { open: true } }` starts them open).
- ⌘⌥M / Ctrl+Alt+M: comment on the selection. In a comment box, ⌘/Ctrl+Enter
  posts and Escape cancels; in an open comment, Escape closes it.

## Develop

```sh
pnpm dev          # the demo page (the package's own files as a vault)
pnpm test:run     # vitest in browser mode
pnpm typecheck
pnpm build        # dist/, which dependents consume
```

Browser suites can fail cold and pass warm when Vite re-optimizes
dependencies; run again before believing a failure.
