# Brief: starting the editor milestones

For an agent beginning work on `@joinezco/markdown-editor` (this package)
and the vault around it. Read this, then the RFC beside it
(`gap-analysis-and-platform-rfc.md`), which is the design of record: §2 is
the gap list, §3 to §7 the decisions that shape the editor, §16 the
milestones. The icanhaz side (the capability daemon the editor MAY talk to) is
built through M6; the editor milestones E1 to E7 are not started. This
brief says where to begin and what not to touch.

HUMAN'S NOTE: Most of these documents were written by an LLM that may not have had full context into the overall ambitions of the project. The general idea is that from `@joinezco/markdown-editor`, to `@joinezco/codebock`, to `@joinezco/vault` (I suppose? I think it would sound better as `@joinezco/storage` and not be clearly trying to emulate Obsidian), that functionality is composed of interfaces which allow each library to avoid making assumptions about the environment its operating in (i.e in a browser vs. a native app), and then we provide different implementations of those interfaces depending on what is possible in a given environment. The browser, for instance, could not run any processes on the host (unless of course they're running `icanhaz` and they grant the capability to the editor -- though then in the case of running processes the editor would likely also require the host filesystem vs. something browser-native like indexeddb, otherwise it would not make much sense). Local-first, peer-to-peer, and open is the prevailing philosophy.

## The ground

- `src/typescript/markdown-editor`: a TipTap editor with a Markdown
  round-trip, a CodeMirror codeblock with real LSP (`@joinezco/codeblock`),
  a VFS abstraction, an outline sidebar, a toolbar with file search, slash
  commands, an emoji picker. Solid, single-document, single-user.
  `src/lib/editor/index.ts` builds the extension list; extensions live in
  `src/lib/editor/extensions/`, each with a `.test.ts` beside it.
- `src/typescript/codeblock`: the embedded code editor, its VFS type
  (`VfsInterface`), and the LSP client with a `RemoteLspProvider` hook.
- `src/apps/eznote`: the Tauri app that hosts the editor over a real vault.
- `src/apps/icanhaz/web`: the browser client of the capability daemon.
  `vfs.ts` is a `VfsInterface` over the `filesystem` capability;
  `lsp-provider.ts` runs a native language server through `process`;
  `links.ts` drives a novel capability (backlinks); `mac-demo.ts` shows
  all of it mounted around the editor, including a backlinks panel that
  belongs in the editor and is there only because the editor has no home
  for it yet.

Run and test from the package directory:

```sh
pnpm dev                 # the demo page
pnpm test:run            # vitest, browser mode for the editor suites
pnpm typecheck 2>/dev/null || pnpm exec tsc --noEmit
```

The browser suites can fail cold and pass warm because of dependency
optimisation; run once more before believing a failure, and see the repo's
memory notes on `optimizeDeps` if it persists.

## Where to begin: E1, editor foundations

E1 is the milestone with no dependency on anything unbuilt, and every
later one stands on it. In order of value:

1. **Wikilinks** (`[[note]]`, `[[note|text]]`, `[[note#heading]]`): a node
   with a Markdown round-trip, resolution against the vault, click to open
   through the filesystem extension's `loadFile`, and an unresolved style.
   The icanhaz backlinks example already parses them on the daemon side and
   treats them as primary once the editor does.
2. **A links index in the editor**: a panel or sidebar section (mount
   pattern of `extensions/sidebar.ts`) with backlinks and unresolved links
   for the open note. Build it against an interface, not against icanhaz:
   `interface LinkIndex { backlinks(note), unresolved(), rename(old, new) }`
   supplied by the host, so eznote can supply a local index and the icanhaz
   demo can supply the capability. Then delete the panel in `mac-demo.ts`.
3. **Front matter** with `id:`, footnotes, callouts, math, images with a
   binary `VfsInterface` (readFile as bytes; the icanhaz VFS already reads
   bytes underneath).
4. **Full-text and link index, command palette, file tree** as the vault
   package (`@joinezco/vault`) that §6 describes; file management and the
   search index move out of `codeblock` into it.

Each new node gets a round-trip test (Markdown in, Markdown out, byte for
byte where the syntax allows) beside its extension, and the index gets a
rebuild-from-fixture-vault test.

## Then

- **E2, versions and workspaces**, is the first milestone that makes an
  agent editing a note safe: a per-file version log with base-version
  writes and an `edit()` path into open documents. Its icanhaz half (the
  overlay membrane and the `clonefile` resolver) is not built; start with
  the editor half, which needs only the VFS.
- **E4, capabilities in the editor**: prose AI actions over the daemon's
  `inference` capability (`src/apps/icanhaz/web/src/generated/inference.ts`
  is the client; frames are `[kind][len][payload]`, text deltas then a
  usage record), and a plugin manifest with `wants`. The iframe bridge and
  the `eznote:plugin` executor come after.
- **E3, comments**, on top of versions; `comments-discussions-rfc.md` and
  RFC §4 carry the model (URL anchors, footnote threads).

## Rules that hold across the repo

- **No cheap solutions.** Prefer the principled shape over the quick one,
  and rewrite working code when the shape is wrong; there is one user and
  no compatibility to keep. This is a standing instruction from the owner.
- **Tests prove the change.** A feature lands with the test that would
  fail without it, at the level where the failure would be seen (a
  round-trip test for syntax, a browser test for something the daemon is
  involved in). Do not pad a timeout; find the cause.
- **The editor does not know icanhaz.** It consumes interfaces
  (`VfsInterface`, `RemoteLspProvider`, and whatever `LinkIndex` becomes);
  the icanhaz web package implements them. Keep that direction.
- **Commits**: one concern each, a message that says what changed and why,
  ending with the attribution line the repo's guidance gives.
- **Docs**: when a milestone's status changes, say so in the RFC's §16
  entry, and keep this brief's "where to begin" honest.

## What not to do

- Do not add a CRDT or live mode (E6) before E2; files are the unit and
  the CRDT is opt-in (RFC §3).
- Do not put capability-specific code in the editor (a backlinks panel
  that imports from icanhaz, an inference call that knows wRPC). Ask for an
  interface from the host.
- Do not touch `src/apps/icanhaz` beyond `web/` for the editor's needs; its
  remaining work is listed in `src/apps/icanhaz/docs/next.md` and is not
  this brief's.
