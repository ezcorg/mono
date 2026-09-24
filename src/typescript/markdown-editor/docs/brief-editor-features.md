# Brief: the editor milestones

For an agent working on `@joinezco/markdown-editor` (this package) and the
vault around it. Read this, then the RFC beside it
(`gap-analysis-and-platform-rfc.md`), which is the design of record: §2 is
the gap list, §3 to §7 the decisions that shape the editor, §16 the
milestones. The icanhaz side (the capability daemon the editor MAY talk to) is
built through M6. E1, the editor's foundations and the vault package, is
built (branch `editor-e1`, 2026-09-23), and so is E2's editor half
(versions and the `edit()` path); the rest of E2 and E3 to E7 are not
started. This brief
says where to continue and what not to touch.

HUMAN'S NOTE: Most of these documents were written by an LLM that may not have had full context into the overall ambitions of the project. The general idea is that from `@joinezco/markdown-editor`, to `@joinezco/codebock`, to `@joinezco/vault` (I suppose? I think it would sound better as `@joinezco/storage` and not be clearly trying to emulate Obsidian), that functionality is composed of interfaces which allow each library to avoid making assumptions about the environment its operating in (i.e in a browser vs. a native app), and then we provide different implementations of those interfaces depending on what is possible in a given environment. The browser, for instance, could not run any processes on the host (unless of course they're running `icanhaz` and they grant the capability to the editor -- though then in the case of running processes the editor would likely also require the host filesystem vs. something browser-native like indexeddb, otherwise it would not make much sense). Local-first, peer-to-peer, and open is the prevailing philosophy.

## The ground

- `src/typescript/storage` (`@joinezco/storage`): the vault package, named
  per the note above. The `VfsInterface` contract (text, bytes, rename,
  watch) and its implementations (`memoryVfs`; `nodeVfs` under `/node`;
  `browserVfs`, the OPFS behind a shared worker, under `/browser`; Tauri's
  in eznote, icanhaz's in icanhaz-web), a filesystem over a message port
  (`remoteVfs`, `serveVfs`), snapshots, the link grammar every parser
  shares, `LinkResolver`/`LinkIndex`, `FileSearch`, `FileOperations`, and
  `Vault`, which keeps links and text indexed over any VFS and renames
  without breaking links. No DOM outside `/browser`. Node tests against a
  fixture vault; the browser implementation's in Chromium.
- `src/typescript/markdown-editor`: a Tiptap editor with a byte-faithful
  Markdown round-trip. Wikilinks and embeds, images from VFS bytes, front
  matter with ids, footnotes, math, callouts, a links panel, a file tree,
  the toolbar as a command palette, CodeMirror codeblocks with real LSP.
  `src/lib/editor/index.ts` builds the extension list and wires the vault
  services (with only `fs`, the editor keeps a `Vault` of its own);
  extensions live in `src/lib/editor/extensions/`, each with a `.test.ts`
  beside it. `source-view.ts` is the "rendered until focused" machinery.
- `src/typescript/codeblock`: the embedded code editor, the LSP client with
  a `RemoteLspProvider` hook, and `ToolbarCore`, whose search and file
  operations come from its host.
- `src/apps/eznote`: the Tauri app; it opens the notes folder as a `Vault`
  and hands the editor its services.
- `src/apps/icanhaz/web`: the browser client of the capability daemon.
  `vfs.ts` is a `VfsInterface` over the `filesystem` capability;
  `lsp-provider.ts` runs a native language server through `process`;
  `links.ts` makes the novel backlinks capability into the editor's
  `LinkIndex` and `LinkResolver` (`editorLinks`); `mac-demo.ts` mounts the
  editor's own links panel with it.

Run and test from the package directory:

```sh
pnpm dev                 # the demo page
pnpm test:run            # vitest, browser mode for the editor suites
pnpm typecheck
pnpm build               # dist/ — dependents (icanhaz-web, eznote) consume it
```

Storage and codeblock are consumed through their `dist/`: rebuild them
(`pnpm build` in each, or `pnpm dev` in storage for a watch) before the
editor's suites see a change. On a fresh machine, `pnpm exec playwright
install chromium` first; icanhaz-web's browser suite also builds and runs
the daemon, which needs the capability guests built
(`cargo build --release --target wasm32-wasip2` in each
`src/apps/icanhaz/capabilities/*`). The browser suites can fail cold and pass
warm because of dependency optimisation; run once more before believing a
failure. `pnpm test` in codeblock runs its jsdom unit tests, its Chromium
project (`*.browser.test.ts`) and the puppeteer e2e suite, which needs
Chrome at `/usr/bin/google-chrome` or `CHROME_PATH`.

## Where to continue

1. **What E2's editor half left** (RFC §16): editable region embeds
   (`![[src/lib.rs#L40-L80]]` as an editor over those lines, writing the
   range back with `vault.versions.put` on the version it showed); a review
   entry in the editor when a save becomes a conflict copy (today a
   `conflict` event and the copy); signing keys for the version log (a
   `Signer` is injected; the keys belong with the identity work). The
   icanhaz half (overlay membrane, `clonefile` resolver, the workspace
   block) is not this brief's.
2. **What E1 left** (RFC §16): persist the vault's index as a per-device cache keyed by mtime (it rebuilds on
   open today); tags and a property index; block ids assigned by the
   editor (`^abc`); highlight `==x==`; diagrams behind a renderer interface
   as math is.

## Then

- **E4, capabilities in the editor**: prose AI actions over the daemon's
  `inference` capability (`src/apps/icanhaz/web/src/generated/inference.ts`
  is the client; frames are `[kind][len][payload]`, text deltas then a
  usage record), taken by the editor as an interface from the host, and a
  plugin manifest with `wants`. The iframe bridge and the `eznote:plugin`
  executor come after.
- **E3, comments**, on top of versions; `comments-discussions-rfc.md` and
  RFC §4 carry the model (URL anchors, footnote threads). The pieces are
  in place: footnote definitions keep their place and their indented
  continuation, text fragments (`#:~:text=`) resolve (`fragment.ts`), and
  notes carry ids.

## Rules that hold across the repo

- **No cheap solutions.** Prefer the principled shape over the quick one,
  and rewrite working code when the shape is wrong; there is one user and
  no compatibility to keep. This is a standing instruction from the owner.
- **Tests prove the change.** A feature lands with the test that would
  fail without it, at the level where the failure would be seen (a
  round-trip test for syntax, a browser test for something the daemon is
  involved in). Do not pad a timeout; find the cause.
- **The editor does not know icanhaz.** It consumes interfaces
  (`VfsInterface`, `LinkResolver`, `LinkIndex`, `FileSearch`,
  `FileOperations` from `@joinezco/storage`; `RemoteLspProvider`); the
  icanhaz web package implements them. Keep that direction.
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
