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
    fileTree: {}, // the vault beside the note (closed until asked for, ⌘⇧E)
    comments: { author: 'theo', index: vault.comments }, // threads in the margin
})
```

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

A thread is a footnote whose first line says who started it, when, whether
it is open and what it is about. What it is about is links into the note's
text, the strings "copy link to highlight" makes, so a comment's anchor and
a link to a passage are one thing ([the comments RFC](docs/comments-discussions-rfc.md)):

```markdown
The quick brown fox jumps over the [lazy dog]{#c-01JAB3C4D5EFGHJK}.

[^c-01JAB3C4D5EFGHJK]: @theo 2026-09-13T12:04Z · open · [[#:~:text=brown%20fox]] [[#c-01JAB3C4D5EFGHJK]]
    Are both of these the same animal?
    - @alice 2026-09-13T12:10Z: No, and the second one should be a cat.
      - @theo 2026-09-13T12:12Z: 👍
```

The editor finds each target (a quote as written, regardless of case, or
approximately after an edit made elsewhere; a pin; a block id), highlights
it, and shows the thread in a margin beside the note, level with its text
(over the note's edge, as a popover, when there is no room). Anchors keep
up with editing: a quote whose words are changed is rewritten, in the same
undo step, to quote what is there now; text no quote can tell apart is
pinned instead. Given `comments: { author, index }`, threads are written as
`author` (select text, then Comment or ⌘⌥M) and threads about the note that
live in other notes (a review, a day's notes) come from `index`, a vault's
`comments`, and are changed where they live. `editor.storage.comments` has
the threads, `exportAnnotations()` (W3C Web Annotations) and
`markdownWithoutComments()`.

## What it understands

| Syntax | Notes |
|---|---|
| CommonMark + GFM | headings, lists (marker kept), task lists, tables, quotes, code fences (CodeMirror, real LSP; a fence named by a file writes through to it) |
| File regions ```` ```src/lib.rs#L40-L80 ```` | some lines of a file, numbered as the file numbers them. The file is the source of truth: the fence's body is the lines as last seen, taken from the file when the note opens (found where they moved to, if they did); an edit goes back into the file where the lines are then, and the range follows the lines it holds. A save whose lines changed in the file meanwhile is kept as a conflict copy |
| Wikilinks `[[note]]`, `[[note\|text]]`, `[[note#heading]]`, `[[#heading]]` | resolved by the host; a dangling link is dimmed and creates its note when followed; `[[` offers the vault's notes |
| Embeds `![[target]]` | an image by name, a note or one of its sections (read-only), or a card that opens the file (`![[src/lib.rs#L40-L80]]` names its lines; to show and edit them, use a fence) |
| Images `![alt](path)` | read from the vault as bytes; `\|200` in the alt sizes; pasted or dropped images are stored under `attachments/` |
| Front matter | a properties table, YAML on focus; `id:` assigned on first open when the host asks |
| Math `$…$`, `$$…$$` | KaTeX by default (loaded on first use), any `MathRenderer` otherwise; prices stay text |
| Footnotes `[^1]` | numbered by first use, definitions kept where written |
| Comment threads `[^c-…]: @who TIME · open · [[#…]]` | shown in the margin, hidden in the note; written back byte for byte until changed (see Comments) |
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
- ⌘⇧E / Ctrl+Shift+E, or its header: show or hide the file tree (closed until
  asked for; `fileTree: { open: true }` starts it open). In it: arrows,
  Enter, F2 to rename, Delete (asks first).
- ⌘⌥M / Ctrl+Alt+M: comment on the selection. In a comment box, ⌘/Ctrl+Enter
  posts and Escape cancels.

## Develop

```sh
pnpm dev          # the demo page (the package's own files as a vault)
pnpm test:run     # vitest in browser mode
pnpm typecheck
pnpm build        # dist/, which dependents consume
```

Browser suites can fail cold and pass warm when Vite re-optimizes
dependencies; run again before believing a failure.
