# `@joinezco/storage`

Folders of files behind one environment-agnostic contract: the filesystem
every environment implements, implementations of it, a filesystem over a
message port, snapshots, file operations, and a per-file version log. No
Markdown (that is [`@joinezco/vault`](../vault)), and no DOM outside
`/browser`: the editor, the code block, the vault and every host depend on
it.

The files are the truth. Nothing here is synced.

## The contracts

- `VfsInterface`: text and bytes, directories, stat, rename, watch. Paths
  are vault-relative with `/` separators.
- `FileOperations`: create, mkdir, rename, remove, the way a host means them
  (`pathTaken` tells a rename's destination from its source on a disk that
  ignores case). `fileOperations(fs)` is the plain kind over any VFS; a
  `Vault`'s keeps links.
- `FileSearch`: files by path and name, notes by their text, with the line
  and a snippet of a text match. The vault implements it; so can a daemon.

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
CBOR blob (memfs's format, with a small codec of its own);
`restoreSnapshot(fs, bytes)` writes it into another. `browserVfs(name, {
snapshot })` restores one (bytes or a URL) as the vault opens: the
markdown-editor demo ships its own sources that way. The snapshot restored
last time, unchanged since (the server's validator, else the bytes), is
neither fetched nor written again.

## Versions

`VersionLog` keeps every file's versions in `.vault/`, over any VFS: the
bytes once, by blake3 hash, and each version's parents. A write names the
version it was made on:

```ts
const log = new VersionLog(fs)
const head = await log.head('notes/plan.md')
const result = await log.put('notes/plan.md', head.id, text)
if (!result.ok) result.conflict.path // the bytes, kept beside the file
```

A stale write changes nothing at the path; its bytes become a conflict
copy (`plan (conflict, 2026-09-23 12.04).md`, `conflictCopyPath`). A change
made by anything else becomes a version on the head it replaced when the
log next looks. `history`, `read`, `move` and `remove` complete it;
versions are signed when the log is given a `Signer`. A vault moves a
file's log with the file (`vault.versions`).

`Locks` runs operations on a key one after another; the version log, the
OPFS store and the vault's comment writes keep one per path.

## Test

```sh
pnpm test:run   # Node for memory, Node and remote; then Chromium
pnpm typecheck
pnpm build
```
