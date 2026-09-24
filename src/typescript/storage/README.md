# `@joinezco/storage`

Folders of documents behind environment-agnostic interfaces: the
filesystem contract every environment implements, implementations of it,
and the indexes derived from a vault (links, full text). No DOM, no
ProseMirror: the editor, the code block and every host depend on it.

The files are the truth. Everything here is rebuilt from them and kept
current as they change; nothing is synced.

## The contracts

- `VfsInterface`: text and bytes, directories, stat, rename, watch. Paths
  are vault-relative with `/` separators.
- `LinkResolver` / `LinkIndex`: what a link points at; backlinks, dangling
  links, a rename that rewrites links. The editor takes these from its host.
- `FileSearch`: files by path and name, notes by their text, with the line
  and a snippet of a text match.
- `FileOperations`: create, mkdir, rename, remove, the way a host means them.

## Implementations

| | |
|---|---|
| `memoryVfs(files?)` | in memory, with watch: tests, scratch vaults |
| `nodeVfs(root)` (`@joinezco/storage/node`) | Node's `fs`, jailed to `root` |
| elsewhere | the OPFS worker (codeblock's `CodeblockFS.worker`), Tauri (eznote), the icanhaz daemon (icanhaz-web); each held to the same conformance behaviour |

`Vault` wraps any of them:

```ts
const vault = await Vault.open(fs) // walks once; `new Vault(fs)` indexes in the background
vault.fs // the same filesystem, observed: writes through it update the indexes
vault.links // LinkIndex & LinkResolver
vault.search // FileSearch
vault.files // FileOperations; rename keeps every link meaning what it meant
```

## Links

One grammar, used by the editor's parser and the index alike
(`links/syntax.ts`): wikilinks and embeds (Obsidian's syntax), Markdown links
and images, reference definitions, wikilinks in front matter; code is
skipped. A Markdown link is a path from its note. A wikilink is a name,
resolved as Obsidian does so existing vaults keep working: beside the note,
from the root, then by path tail anywhere, closest first. A rename moves the
file and rewrites links to it as qualified as they were written, fixes links
inside the moved note, and lengthens a wikilink the new name would capture.

## Notes

`newNoteId()` makes ULIDs for a note's `id:`; `noteIdOf(text)` reads it.

## Test

```sh
pnpm test:run   # Node; includes a rebuild of the fixture vault in src/__fixtures__
pnpm typecheck
pnpm build
```
