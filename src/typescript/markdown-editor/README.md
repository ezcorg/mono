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
    fileTree: {}, // the vault beside the note
})
```

With `fs` alone the editor keeps a vault of its own over it, so wikilinks,
search and renames work without the host building one.

## What it understands

| Syntax | Notes |
|---|---|
| CommonMark + GFM | headings, lists (marker kept), task lists, tables, quotes, code fences (CodeMirror, real LSP; a fence named by a file writes through to it) |
| Wikilinks `[[note]]`, `[[note\|text]]`, `[[note#heading]]`, `[[#heading]]` | resolved by the host; a dangling link is dimmed and creates its note when followed; `[[` offers the vault's notes |
| Embeds `![[target]]` | an image by name, a note or one of its sections (read-only), lines of a file `![[src/lib.rs#L40-L80]]`, or a file card |
| Images `![alt](path)` | read from the vault as bytes; `\|200` in the alt sizes; pasted or dropped images are stored under `attachments/` |
| Front matter | a properties table, YAML on focus; `id:` assigned on first open when the host asks |
| Math `$…$`, `$$…$$` | KaTeX by default (loaded on first use), any `MathRenderer` otherwise; prices stay text |
| Footnotes `[^1]` | numbered by first use, definitions kept where written |
| Callouts `> [!note] Title` | kinds and aliases, fold markers, Obsidian's syntax |

Every extension is exported on its own; `markdownSetup()` returns the default
set (`minimalSetup()` a lean one) for `new Editor({ extensions })`, and
`createEditor()` also builds the default layout (toolbar slot, left column,
block-action gutter).

## Keys

- ⌘P / Ctrl+P: the toolbar as a command palette (files by name, notes by
  text, opening at the match); ⇧⌘P, or `>` first: the editor's commands.
- `/`: slash commands; `:` then two letters: emoji; `[[`: link to a note.
- ⌘/Ctrl+Enter or a click: follow a link. Backspace after a wikilink: edit its
  source.
- In the file tree: arrows, Enter, F2 to rename, Delete (asks first).

## Develop

```sh
pnpm dev          # the demo page (the package's own files as a vault)
pnpm test:run     # vitest in browser mode
pnpm typecheck
pnpm build        # dist/, which dependents consume
```

Browser suites can fail cold and pass warm when Vite re-optimizes
dependencies; run again before believing a failure.
