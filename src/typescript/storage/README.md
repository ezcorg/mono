# `@joinezco/storage`

Folders of documents behind environment-agnostic interfaces: the
filesystem contract every environment implements, implementations of it,
and the indexes derived from a vault (links, full text). No ProseMirror,
and no DOM outside `/browser`: the editor, the code block and every host
depend on it.

The files are the truth. Everything here is rebuilt from them and kept
current as they change; nothing is synced.

## The contracts

- `VfsInterface`: text and bytes, directories, stat, rename, watch. Paths
  are vault-relative with `/` separators.
- `LinkResolver` / `LinkIndex`: what a link points at; backlinks, dangling
  links, a rename that rewrites links. The editor takes these from its host.
- `FileSearch`: files by path and name, notes by their text, with the line
  and a snippet of a text match.
- `FileOperations`: create, mkdir, rename, remove, the way a host means them
  (`pathTaken` tells a rename's destination from its source on a disk that
  ignores case).

## Implementations

| | |
|---|---|
| `memoryVfs(files?)` | in memory, with watch: tests, scratch vaults |
| `nodeVfs(root)` (`@joinezco/storage/node`) | Node's `fs`, jailed to `root` |
| `browserVfs(name, { snapshot? })` (`@joinezco/storage/browser`) | a vault in the origin's OPFS (in memory without one), shared by every tab and worker of the origin |
| `opfsVfs(dir)` (`/browser`) | one OPFS directory, on the current thread |
| `remoteVfs(port)` / `serveVfs(fs, port)` | any of these on the other side of a `MessagePort` |
| elsewhere | Tauri (eznote), the icanhaz daemon (icanhaz-web) |

Every one is held to one contract, `src/testing/conformance.ts`: in Node
for memory, Node and remote; in Chromium for the OPFS and the workers.

`Vault` wraps any of them:

```ts
const vault = await Vault.open(fs) // walks once; `new Vault(fs)` indexes in the background
vault.fs // the same filesystem, observed: writes through it update the indexes
vault.links // LinkIndex & LinkResolver
vault.search // FileSearch
vault.files // FileOperations; rename keeps every link meaning what it meant
vault.versions // VersionLog
vault.comments // CommentIndex: references by what they are about
vault.reactions // Reactions: an identity's emoji on documents and references
```

A vault keeps its own state in one dot-directory, `.vault/` by default
(`Vault.open(fs, { dir })`): the version log, the installed plugins, and
each identity's state under `.vault/state/<identity>/`. Dot-directories are
out of every index.

## In the browser

`browserVfs` keeps the files off the main thread. Each page talks to one
shared worker per origin (the broker); the broker keeps the files in a
dedicated worker a page lends it, because only a dedicated worker gets
synchronous OPFS access and Chromium lets no shared worker start one. So
every tab reads and writes through the same store, and each one's `watch`
hears the others' writes. Pages hold a Web Lock for as long as they live:
when the page lending the store closes, the broker asks another page for
one and carries on (calls that are safe to repeat are repeated, watches
resume). `connect()` hands a worker a port of its own to the same vault;
codeblock's language server reads the editor's files that way
(`vfsPort(fs)` gives a port for any filesystem, serving it from the
current thread when it is not already remote).

Consumers serve storage's built files as they are (Vite: leave it out of
`optimizeDeps`), since the workers are found beside `browser/index.js`.

## Snapshots

`takeSnapshot(fs, { filter })` packs a folder of any VFS into one gzipped
CBOR blob (memfs's format); `restoreSnapshot(fs, bytes)` writes it into
another. `browserVfs(name, { snapshot })` restores one (bytes or a URL)
as the vault opens: the markdown-editor demo ships its own sources that
way.

## Links

One grammar, used by the editor's parser and the index alike
(`links/syntax.ts`): wikilinks and embeds (Obsidian's syntax), Markdown links
and images, reference definitions, wikilinks in front matter; code is
skipped. A Markdown link is a path from its note. A wikilink is a name,
resolved as Obsidian does so existing vaults keep working: beside the note,
from the root, then by path tail anywhere, closest first. A rename moves the
file and rewrites links to it as qualified as they were written, fixes links
inside the moved note, and lengthens a wikilink the new name would capture.

## Comments

A comment is a document that references a range of another document. Any
note may hold **references**: a paragraph that is exactly one embed,
`![[Plan#:~:text=ship%20it]]`, whose fragment is a text fragment (the
anchor `textFragmentFor` makes and `findTextFragment` finds), a pin
(`c-…`), a block id (`^abc`), a heading, or absent for the whole document.
The Markdown under the embed, up to the next reference, the next heading
or the end, is the comment's **body**; an embed with no body is a
transclusion, not a comment.

```markdown
![[Plan#:~:text=ship%20it]]
Which release?

![[Plan#^abc]]
Done, I think.
```

`referencesIn(markdown)` reads them (`comments.ts`; fenced code and front
matter are skipped), `formatReference` and `spliceReference` write them
back: one that did not change goes back byte for byte. `vault.comments`
(a `CommentIndex`) answers `about(note)`, the references in other
documents whose link resolves to it, and `in(doc)`, what a document
comments on, and `update(ref, { link, body } | null)` changes or removes
one where it lives, refusing when the text is no longer what was read;
removing the last thing in a document removes the document. A rename
rewrites the links in references like any other.

A **reaction** is an identity's emoji on a document or one of its
references, kept as per-identity state rather than as a document:
`.vault/state/<identity>/reactions.jsonl`, one JSON line each
(`{"at","doc","ref","emoji"}`; `ref` is the reference's link as
`referenceKey` writes it, null for the document). `vault.reactions.on(doc)`
reads every identity's; `toggle(to, emoji)` adds or takes away the vault's
own, given as `Vault.open(fs, { identity })`; without one it is read-only.

## Versions

`vault.versions` (a `VersionLog`, over any VFS) keeps every file's
versions in `.vault/`: the bytes once, by blake3 hash, and each version's
parents. A write names the version it was made on:

```ts
const head = await vault.versions.head('notes/plan.md')
const result = await vault.versions.put('notes/plan.md', head.id, text)
if (!result.ok) result.conflict.path // the bytes, kept beside the file
```

A stale write changes nothing at the path; its bytes become a conflict
copy (`plan (conflict, 2026-09-23 12.04).md`). A change made by anything
else becomes a version on the head it replaced when the log next looks.
`history`, `read`, `move` and `remove` complete it; versions are signed
when the log is given a `Signer`. A file's history goes with the file: a
vault rename moves the log before the file (and back, if the store cannot
move the file), `vault.files.remove` removes it with the file, and a log
left behind by a file removed some other way is replaced when a file is
renamed onto its name. The bytes in `.vault/objects/` are shared by every
version made of them and stay.

## Models and plugins

`Inference` is the interface for a model (a streamed completion); the
prose actions (`PROSE_ACTIONS`: rewrite, summarize, continue, ask) are
requests built from a selection and its note. `PluginHost` reads plugin
manifests (`manifest.toml`: `wants` by WIT path, slash commands, themes
over the editor's variables), asks a `Granter` for each want, hands the
plugin a provider exposing only what was granted, and keeps the installed
set in `.vault/plugins.toml`, pinned by sha256.

## Notes

`newNoteId()` makes ULIDs for a note's `id:`; `noteIdOf(text)` reads it.

## Test

```sh
pnpm test:run   # Node, against the fixture vault in src/__fixtures__, then Chromium
pnpm typecheck
pnpm build
```
