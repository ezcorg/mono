# Gap analysis + platform RFC: from `@joinezco/markdown-editor` to a local-first, capability-sandboxed knowledge editor

**Status:** analysis / design proposal. v4, 2026-09-14. Nothing here is built.
**Changes in v4:** one shared `ezco:ezcap` WIT package with a two-string CEL scope replaces the `capability-kind` manifest (§7, §13); grants are minted instances with sturdy references and signed link chains, and Biscuit is demoted to an encoding note (§9.1); guest-authored attenuation code is rejected in favour of CEL, with the reasons recorded (§13.4); four authoring tiers for user-written capabilities in icanhaz (§14); import resolution: native providers, a content-addressed component store, remote providers over wRPC (§15); a milestone work plan (§16).
**Changes in v3:** certificate format decided after a survey of UCAN, Biscuit, macaroons, Keyhive and OCapN (§9.1); comments re-based on URL anchors with pinned attribute spans, and CriticMarkup dropped after a syntax survey (§4); plugin placement is capability-driven rather than a default (§7.3); the iroh transport already exists in `/Users/theo/dev/djt/crates/wrpc-transport-iroh` and djt runs an iroh endpoint in the browser (§2.3).
**Changes in v2:** files are the unit and the CRDT is opt-in (§3); sandboxes are resolved by icanhaz through overlays and clones (§5); the editor/vault package split (§6); iframe pages for plugins (§7); capabilities in shared documents, including share bundles with redeemable grants (§9); a comparison with Ink & Switch's Patchwork (§10).
**Companion:** `comments-discussions-rfc.md` (this doc revises its storage recommendation, see §4).
**Inputs:** a read of `markdown-editor`, `codeblock`, `icanhaz`, `witmproxy`, `eznote`, the design notes in `/docs/eznet`, `/djt.md`, `/scratch.md`, and the source of `inkandswitch/patchwork-system`, `patchwork-pkg-base`, `patchwork-experiments` (clones dated 2026-08-24 to 2026-09-11).

---

## 0. TL;DR

- The editor is a strong **single-document, single-user** WYSIWYG Markdown editor with an unusually good code story (real LSP, a VFS, filename fences that write through to files, a file toolbar). It is not yet a **knowledge base** (no images, wikilinks, backlinks, full-text search, tags, front matter, math, diagrams) and has **no collaboration layer** (no versioning, transport, or identity).
- **Files are the unit, not CRDTs.** Agents and other tools work on files; the editor is the review surface that embeds live regions of those files. Every write carries a base version and is refused when stale. A CRDT is a per-document opt-in "live" mode for prose two parties type into at once, never the foundation.
- **The sandbox is whatever icanhaz resolves a handle to.** A filesystem grant can be satisfied by a passthrough, an overlay (copy-on-write membrane), an APFS clone, a container, or a VM. The requester never knows; the user sees a workspace with staged changes and an Apply button.
- **Split the library.** `@joinezco/markdown-editor` keeps syntax and editing UX behind injected resolvers; a new vault package owns folders-of-documents features (index, search, sync, plugins, AI). Most apps will use both; nobody is forced to.
- **Plugins are capability-scoped in three sandboxes**: declarative packages (no code), iframe pages with full DOM inside an opaque origin, and WASM components. All three see the same `capability-provider`; only the bridge differs. Do not adopt WASIX.
- **One scope language, shared by icanhaz and witmproxy.** A capability request is `{kind, scope: {when, allow}}` from a shared `ezco:ezcap` WIT package; both strings are CEL over an environment generated from the target interface's WIT. Narrowing is the host conjoining clauses when it mints a child instance; a rendering profile turns the common clause shapes into sentences; guest code is not a scope language (§13).
- **A document references capabilities, never holds them.** Grants are per principal and issued by the broker that owns the resource. Sharing may attach a bundle of signed, attenuated, peer-bound grant certificates that the recipient redeems at the owner's broker. A certificate is a sturdy reference to a minted instance plus audience, expiry and a signed chain of extra clauses; no policy language is needed to verify it (§9.1).
- **Comments anchor by URL.** A thread lists the ranges it is about as links: a text-fragment link (`[[Note#:~:text=brown%20fox]]`, the same link "copy link to highlight" produces) or a pinned span id (`[[Note#c-01J9K]]`). Threads are footnotes; in-body markers are optional pins written as Pandoc attribute spans, not CriticMarkup (§4).
- **Patchwork is the closest prior art** and validates several of these choices (copy-on-write drafts, iframe isolation, a plugin registry with self-describing documents). It differs on the two axes that matter most to us: Automerge documents are canonical there (disk is a sync target) and there is no capability model below "who may read or edit this document". Take its patterns and a few small modules, not its stack.

---

## 1. Where the editor stands today

Read `markdown-editor/src/lib/editor/index.ts` for the composition and `codeblock/src/types.ts` for the `VfsInterface`.

| Area | Present | Absent |
|---|---|---|
| Block syntax | h1–h6, paragraphs (blank-run preserving), `-`/`*` lists with marker round-trip, ordered lists with `start`, task lists, blockquotes, hr, tables (resizable), fenced code with filename fences | images, footnotes, math blocks, diagrams, callouts, front matter, definition lists, details, raw HTML (`html: false`) |
| Inline syntax | bold, italic, strike, code, links (`[text](url)` rule, ⌘-click) | wikilinks, highlight `==x==`, sub/superscript, inline math, mentions, tags, embeds |
| Editing UX | slash commands, selection menu, link popover, emoji picker, gutter block actions (table ops), outline sidebar, markdown block paste, wrap-selection, inline-code exit, same-page multiview sync, autosave with flush-before-navigate, non-prose files swap to CodeMirror | find/replace, command palette, panes/tabs, file explorer tree, templates, snippets |
| Code | 17 CodeMirror languages + 20 legacy modes, Volar TS server in a SharedWorker, `RemoteLspProvider` (rust-analyzer over icanhaz proven), LSP context menu, nav history, SVG/image preview; **a fence with a filename autosaves to that file** (`codeblock/src/editor.ts`) | running code, notebooks/outputs |
| Persistence | `VfsInterface` (string-only), SharedWorker → OPFS worker, CBOR snapshots, MiniSearch **filename** index at `.codeblock/index.json`, host disk via Tauri (eznote) or wasi:filesystem over icanhaz | full-text index, anything queryable, document identity, binary attachments, versions |
| AI | one feature: edit code selection via a Node proxy shelling out to the `claude` CLI; toolbar intent-classification hook (CM adapter only) | configurable backends, prose features, chat, agents, key management |
| Collaboration | none | versioning, transport, identity, presence, comments, permissions |
| Extensibility | every feature is an individually exported Tiptap extension; `extensions[]`, custom slash commands, `registerFileAction`, CSS-variable theming, two event buses | plugin manifest/registry, runtime loading, sandboxing, event API, UI contribution points |
| Tests | 116 browser-mode tests + screenshots (markdown-editor), puppeteer e2e (codeblock), 37 browser + ~35 Rust tests (icanhaz) | — |

---

## 2. The gap list

"Obsidian-class" here means: a folder of `.md` files is the whole truth, anything else is a derived cache, and every feature keeps working offline and reconciles when peers reconnect. Priority is value ÷ effort. **LF** notes local-first compatibility. §6 says which package each belongs in.

### 2.1 Markdown coverage (all P1, all trivially local-first: they are syntax)

| Feature | Notes |
|---|---|
| **Images** `![alt](path)` | The most surprising gap. Needs a binary path in `VfsInterface`, paste/drop-to-attach into `attachments/`, and a resolver so relative paths render from the VFS as blob URLs. **LF:** attachments are immutable blobs, synced content-addressed (blake3). |
| **Wikilinks** `[[Note]]`, `[[Note#Heading]]`, `[[Note\|alias]]` | Autocomplete from the index, create-on-click, rename propagation. Serialize as-is; export option to `[Note](Note.md)`. |
| **Embeds / transclusion** `![[Note]]`, `![[Note#^block]]`, and **file regions** `![[src/lib.rs#L40-L80]]` | The region form is the collaboration surface in §3: a live, editable slice of a real file rendered as a codeblock node. Block ids `^abc` for prose embeds are P2. |
| **Backlinks + unlinked mentions** | Derived from the link index (2.2). |
| **Front matter** (YAML) | `properties` node rendered as a key/value table; raw text round-trips. Home of the stable `id:`. |
| **Footnotes** `[^1]` | Also the degradation path for comments (§4). |
| **Math** `$…$` / `$$…$$` | KaTeX in a node view; source on focus. |
| **Diagrams** | Render fences of known languages (`mermaid`, `dot`, `plantuml`, `vega-lite`, `d2`) with a source toggle, in a WASM component (§8) so renderers are not core-bundle dependencies. |
| **Callouts** `> [!note]` | Blockquote node with a `kind` attribute. |
| **Highlight** `==x==`, sub/superscript | Highlight is also the comment-anchor mark. |
| **Tags** `#tag`, `#a/b` | Inline mark + index. |
| Sanitized raw HTML, definition lists, details, abbreviations | P3. |

### 2.2 Knowledge-base features (vault package)

| Feature | Pri | Notes / LF |
|---|---|---|
| **Full-text search** | P1 | Index bodies (MiniSearch to ~10k notes; then SQLite FTS5 via `sqlite-wasm` in the fs worker, or tantivy in the daemon). Per-device cache, never synced. |
| **Link / tag / property index** | P1 | One derived store at `.eznote/index.db`: `(from, to, kind, pos)`. Rebuilt from `.md`; `fs.watch` keeps it fresh. |
| **File explorer sidebar** | P1 | The toolbar's browse mode is a command line; users expect a tree. |
| **Command palette + find/replace** | P1 | The toolbar's intent engine is half a palette. |
| **Multiple panes / tabs** | P2 | Many views on one VFS already work; missing a workspace layout model. |
| **Templates + daily notes** | P2 | Markdown files in `templates/` with `{{date}}`. |
| **Per-file history** | P1 | From the version log in §3, not from a CRDT: every saved version addressable, with author. |
| **Export** (HTML, PDF, strip comments) | P2 | Static HTML is also the publish path. |
| **Graph view · Canvas** | P3 | Graph derives from the index; canvas is a plugin page (§7). |

### 2.3 Collaboration (§3, §9)

| Feature | Notes |
|---|---|
| **Versioned files** | Every file has a hash chain of versions signed by the author's key. Writes carry a base version. This is `/djt.md`'s signed assertion sets applied to files. |
| **Identity** | Ed25519 keypair per device derived from the iroh secret key (`/djt.md` §6). A user is a set of device keys vouching for each other. No accounts. |
| **Transport** | iroh, and the wRPC adapter **already exists**: `/Users/theo/dev/djt/crates/wrpc-transport-iroh` (a port of `wrpc-quic` to iroh bi-streams, 199 lines, one invocation per stream, a per-connection context for the QUIC-proven remote identity, used by `dij-rpc`). djt's `dij-net` makes the iroh `EndpointId` *be* the identity key. Its M83 commit (2026-09-13) also has an iroh endpoint running **in the browser** (wasm, ring provider, via relay, ~5 MB), so a browser peer can speak to other peers directly rather than only through its local daemon. Both paths stay: the daemon for host resources, direct for sync. WebRTC and Reticulum are further adapters behind one `sync` interface. |
| **Sharing** | A share is a capability (§9). |
| **Live co-editing** | Opt-in per document (§3). Presence and cursors come with it. |
| **Comments** | §4. |
| **Attachments** | Content-addressed blobs (iroh-blobs). |

### 2.4 AI / LLM integration

Today: one code-only action, one backend, keys nowhere. Needed:

1. **An `inference` capability, not an API key in the browser.** `icanhaz:nocap/inference`: `request(want: inference { models, max-tokens-per-day, tools-allowed }, reason)` → grant. The host holds credentials (`~/.icanhaz/providers.toml`: Anthropic, OpenAI-compatible, Ollama, the `claude`/`codex` CLIs, any process). Budget and model are caveats on the grant. witmproxy fronts outbound calls for logging and redaction.
2. **Prose-level features**: rewrite / continue / summarize selection, "ask this note", `/ai`, opt-in ghost text, title and tag suggestion; wire `classifyIntent` in the Tiptap adapter.
3. **Vault-aware chat** (RAG): embeddings via the same capability, stored in the per-device index.
4. **Agent mode**: an agent is a peer with a grant bundle (§9) working in a workspace (§5). Its edits are signed file versions by a distinct identity.

---

## 3. Files are the unit; the CRDT is opt-in

v1 of this document made a document CRDT the foundation. That was wrong for the actual workload. Agents edit many files; most of those files are code; nobody wants automatic character-level merges of code, and nobody wants the editor to own files that `cargo`, `git` and `vim` also touch. So:

**The filesystem is the shared object and a file is the unit of change.** Every file has a version log: `version = blake3(content) + parents`, signed by the author's device key, stored in `.eznote/versions/<path-hash>/`. A write is `put(path, base_version, bytes)`. If `base_version` is not the current head the write is refused and the caller gets both versions back. Conflicts are ordinary and visible: a conflict copy (`Note (alice, 2026-09-13).md`, the Syncthing and Obsidian Sync convention) plus a review entry in the editor. Attribution, history and time travel come from the log, at file granularity, which is what git already gives developers.

**The editor is the writer of record for open files.** An agent that wants to edit a file the user has open does not touch disk. It sends an `edit(path, base_version, [{range, text}])` (the shape of an LSP `WorkspaceEdit` with document versions) to the editor, which applies it as a ProseMirror or CodeMirror transaction, preserving the user's cursor, and then saves a new version. Stale base version means the agent re-reads. This is the "collaboration happens in the editor" model: the note references files, with any number of line ranges, through the region embed in 2.1, and those regions are live views of the file's current version.

**Live mode is opt-in per document.** For prose that two people, or a person and an agent, type into at the same time, a document can be switched to a CRDT-backed live session. The CRDT is a sidecar log at `.eznote/live/<docid>`; the `.md` stays canonical and is re-serialized on every change. Nothing else in the system knows or cares. Concretely:

- Binding: `@automerge/prosemirror` or `loro-prosemirror`. Recommendation changed from v1: **prototype with Automerge**, because that keeps the door open to Subduction (sync with an iroh transport, Rust core) and Keyhive (§9, §10), and because Patchwork demonstrates the ecosystem at "low thousands of documents" scale. Loro remains the lighter alternative if we never want that ecosystem.
- Exit: turning live mode off serializes the CRDT to the `.md`, records a version in the log, and discards the sidecar.
- Comments (§4) are inline text, so they need nothing extra in either mode.

**Document identity:** `id:` in front matter, generated on first open. Visible, survives rename and move, works with git.

---

## 4. Comments: URL anchors, footnote threads, optional pins

The existing RFC recommends a sidecar with relative-position anchors; v2 of this document proposed CriticMarkup anchors. The stated preference is that the anchor used by "copy link to highlight" should be the same thing a comment points at, and that threads may reference document ranges by URL, the way Patchwork's comments reference document URLs. That is a better model than in-body-only markers, and it makes multi-range and cross-document comments free.

### 4.1 Syntax survey

| Option | Shape | Renders elsewhere | Ids / multi-range | Verdict |
|---|---|---|---|---|
| CriticMarkup | `{==text==}{>>note<<}` | MultiMarkdown, iA Writer, Marked; Pandoc only via filter; GitHub shows raw braces | no ids; one note per highlight | drop: no ids, weak tool support |
| **Pandoc bracketed span** | `[text]{#c-01J9K .c}` | Pandoc, Quarto, Djot (`[text]{#id}`); GitHub shows `[text]` cleanly | generic attributes: id, class, key=value; the id doubles as a link target (`#c-01J9K` works in exported HTML) | **use for pinned anchors** |
| Obsidian `%% %%` comment | `%% hidden %%` | Obsidian only; raw elsewhere | none | no |
| Obsidian block id | `paragraph ^abc` | Obsidian, Logseq-ish | block-level only | use for block anchors (`[[Note#^abc]]`) |
| HTML comment | `<!-- c: -->` | invisible everywhere | none | no |
| Footnote | `[^c-01J9K]` / `[^c-01J9K]: …` | everywhere | one definition, many references | **use for thread bodies** |
| Fenced div | `::: {.thread}` | Pandoc/Quarto; raw elsewhere | attributes | no (worse degradation than footnotes) |
| **Text fragment URL** | `#:~:text=prefix-,start,end,-suffix` | Chrome 80, Edge 83, Safari 16.1, Firefox 131: all browsers now | quote + context; fuzzy re-anchoring | **use for unpinned anchors and "copy link"** |
| W3C Web Annotation selectors | JSON: `TextQuoteSelector`, `TextPositionSelector`, `RangeSelector` | interchange only (Hypothesis) | any | use as the import/export format |

### 4.2 The model

- **A range is a URL.** Inside a note it is one of: a text-fragment link `[[#:~:text=brown%20fox]]` (unpinned: quote plus optional prefix and suffix, resolved by fuzzy search like Hypothesis and the browsers), a pinned span `[[#c-01J9K]]` (an id the author put in the body with `[brown fox]{#c-01J9K}`), or a block id `[[#^abc]]`. With a note name in front the same forms reach other documents. "Copy link to highlight" produces exactly these strings, so a comment target and a shareable link are one thing.
- **A thread is a footnote whose header lists its targets.** Zero targets is a document-level note; N targets is a multi-range thread.

```markdown
The quick brown fox jumps over the [lazy dog]{#c-01J9K}.

[^c-01J9K]: @theo 2026-09-13T12:04Z · open · [[#:~:text=brown%20fox]] [[#c-01J9K]]
    Are both of these the same animal? See [[Zoology]].
    - @alice 2026-09-13T12:10Z: No, and the second one should be a cat.
      - @theo 2026-09-13T12:12Z: 👍
```

- **Pins are optional.** A text-fragment target needs no in-body markup and survives most edits by re-anchoring; a pinned span is text that moves with edits under both file mode and live mode (§3) and never orphans until its span is deleted. The editor pins automatically when the quoted text is not unique in the document, and offers "pin" on any thread.
- **Threads can live anywhere.** The default is the footnote at the bottom of the note it discusses. A thread can equally be a list item in another note (`comments/2026-09-13.md`, a review note, an agent's report) with the same header shape and fully qualified targets (`[[Zoology#:~:text=…]]`). The vault index collects threads by target document, so the margin UI shows both.
- **Editor integration.** The pin parses to a `span` mark with attributes (generic, also usable for classes and future annotations); the footnote parses to a `commentThread` node rendered in the margin or popover and hidden in the body; targets resolve through the vault's `LinkResolver`. Commands: `addComment(ranges)`, `reply`, `resolve`, `react`. Export: "strip comments" removes threads and pins; "flatten" is a no-op; "export annotations" emits W3C Web Annotation JSON.
- **Per-device state** (read/unread) stays in `.eznote/state/<device>/`.

## 5. Sandboxes: handles, overlays, clones, and what the user sees

The question was whether the editor should copy files into a sandboxed documents filesystem attached to the agent, ideally copy-on-write, or whether agents operate on handles to host resources directly. The answer is that these are the same design once icanhaz is the layer that decides what a handle resolves to.

**A grant is satisfied by a resolver chosen by policy, invisible to the requester.** A `fs(scope)` grant today is satisfied by the `fs-passthrough` component. The same grant can be satisfied by:

| Resolver | Mechanism | Use |
|---|---|---|
| passthrough | raw `wasi:filesystem` descriptor, jailed to scope | trusted local tools |
| **overlay** | a policy component wrapping the raw descriptor: reads fall through, writes land in a per-session upper layer under `.eznote/workspaces/<id>/` | WASM plugins and agents running in the daemon; copy-on-write with no copy step |
| **clone** | `clonefile(2)` on APFS (`cp -c`), reflinks on btrfs/XFS, plain copy elsewhere; the grant's scope is rewritten to the clone | real processes (the `claude` CLI, `cargo`) that cannot be interposed cheaply |
| container / VM | the clone mounted into a container or microVM; `process` runs inside | untrusted toolchains, network-isolated runs |

The overlay is one more membrane in icanhaz's existing composition model, so it comes with audit, escalation and attenuation for free. The clone is what makes the "copy the files you need into the agent's filesystem" idea instant on macOS.

**What the user sees.** A note gains a **workspace block**: the paths the agent asked for (the grant's scope), the resolver the policy chose ("staged; nothing reaches your files until you apply"), the agent's terminal if it has one, and per-file staged diffs rendered with the region embed from §2.1. Two buttons: **Apply** commits the upper layer or clone back to the host under the base-version check of §3, file by file, creating versions signed by the user (with the agent recorded as proposer); **Discard** drops it. Consent language in the icanhaz window is the same sentence: "Agent X wants to edit ~/dev/foo (staged until you apply)". Nobody thinks about copies.

**Import stays available** as the manual form: drag a host file into the note and it becomes a clone in the vault's `attachments/` or a workspace, with the same Apply path back out.

---

## 6. The package split: editor vs vault

The criticism that most of this does not belong in `@joinezco/markdown-editor` is right, and the current library already violates it (file management and the search index live in `codeblock`). Proposed layering:

| Package | Owns | Never owns |
|---|---|---|
| `@joinezco/markdown-editor` | syntax and editing UX for one document: nodes, marks, input rules, menus, comments marks/nodes, wikilink and embed *syntax*, math and diagram node views behind a renderer interface, the `PluginHost` extension point | an index, sync, identity, AI, a plugin registry, file management |
| `@joinezco/codeblock` | one code editor: languages, LSP client, `RemoteLspProvider`, the shared toolbar core | the search index, the VFS worker (move to vault or a small `@joinezco/vfs`) |
| **`@joinezco/vault`** (new) | folders of documents: VFS implementations, version log, link/tag/full-text index, wikilink and embed resolvers, workspace blocks, plugin registry and loaders, AI actions, sync client, comments identity | any ProseMirror schema |
| apps (`eznote`, `ezco-web`) | composition, chrome, consent surface | — |

The rule: the editor takes every cross-document behavior as an injected interface (`LinkResolver`, `EmbedResolver`, `Renderer`, `CommentsIdentity`, `PluginBridge`), exactly the way it takes `VfsInterface` today. `markdownSetup()` stays document-only; the vault ships the extensions most apps will add. Migration is incremental: the toolbar's file operations and the index move first.

---

## 7. Plugin framework: one capability model, three sandboxes

A plugin declares `wants: list<capability-kind>` in a manifest and receives a `capability-provider` whose getters return `option<T>`: present only if granted. That contract is shared by every plugin kind; only the bridge differs. It is lifted from witmproxy's `witmproxy:plugin` (capability-kind, provider with optional getters, a CEL scope the user may tighten) and icanhaz's `request(want, reason, via)`.

```wit
package ezco:ezcap@0.1.0;

interface types {
    /// Both fields are CEL over an environment generated from the target
    /// interface's WIT and documented beside it (§13). Narrowing is done by
    /// the host when it mints a child instance: the child's clauses are
    /// `parent && extra`. A plugin never sees or edits a chain.
    record scope {
        /// Evaluated once per event, with the event bound: should the holder run at all.
        when: string,
        /// Evaluated per call on the minted resource, with `call`, `event`, `caller`,
        /// `state` and `time` bound: may this call proceed. `call.method` distinguishes
        /// methods, so there is no per-method list.
        allow: string,
    }
    /// `kind` is an interface or method path: `icanhaz:nocap/fs.open-at`,
    /// `witmproxy:plugin/local-storage`, `eznote:editor/write`.
    record capability { kind: string, scope: scope }
    variant capability-error {
        /// Never granted.
        unavailable,
        /// Granted, but this call fell outside `allow`; carries the rendered clause.
        denied(string),
    }
}
```

The plugin world imports `ezco:ezcap/types` and the editor's own interfaces, and exports `manifest() -> manifest` (`wants: list<capability>` plus UI contributions), `on-event`, and `render`. The host's `capability-provider` has one getter per interface returning `option<resource>`; every method on those resources returns `result<T, capability-error>`. A `when` and `allow` of `true` is a plain grant, so the simple case costs nothing. There is no `capability-kind` variant: the kind string names the WIT path, which is what lets a witmproxy plugin's request and an eznote agent's request be the same object.

### 7.1 Declarative packages (no code)

`manifest.toml` contributing themes (CSS scoped to the `--ezco-mde-*` / `--cm-*` variable contract), snippets, templates, text-inserting slash commands, icon packs, fence grammars. The loader validates and injects. Half of Obsidian's catalog is this tier.

### 7.2 Iframe pages and panels (JS with full DOM)

A plugin that registers its own page gets a real document: an `<iframe sandbox>` with an opaque origin, `srcdoc` or a blob URL, and a CSP whose `connect-src` is derived from its `net` grant. Inside, the plugin owns the DOM entirely. The `capability-provider` is spoken over `postMessage` with a `MessagePort` per capability, so `editor.edit` and `inference.complete` are the same calls as in WIT, marshalled differently. Browsers make this real isolation: separate storage, no host DOM, no cookies. Costs: theme tokens must be passed in, keyboard shortcuts and focus cross a frame boundary, and per-frame overhead means node views stay out of frames.

Patchwork's `@patchwork/isolation` (§10) is this design with an allowlisted document repo instead of a capability provider; its own threat model lists exfiltration and fine-grained capabilities as out of scope, which is precisely what the `net` grant and the provider add.

### 7.3 WASM components (logic, renderers, anything that must run outside the browser)

Components implementing the world above. No ambient authority: a component can only call what it imports, and the provider returns `None` for anything not granted. UI contributions from components are data (sanitized HTML/SVG or a small vdom for node views; a page spec that the host mounts as an iframe if the component wants a page). **Placement is a function of the capabilities a plugin wants, not a default.** A component is location-agnostic: wRPC already makes every import a call that can cross a process or a network, so the host places each instance next to the capability it will call most and proxies the rest. A plugin wanting only `editor-*` and `storage` runs in the browser beside the editor; one wanting `fs` or `process` runs in the icanhaz daemon and reaches the editor over the existing WebSocket mux; one wanting a capability advertised by a peer runs on that peer. A plugin wanting several is placed by a small policy (heaviest data flow wins, user override available). The WIT is identical in every case, which is why the question needs no default.

### 7.4 Trusted modules

The scratch note's `.markdown-editor/index.mjs`: full Tiptap and CodeMirror API, JSX node views, for power users and first-party development. Loaded only from the local vault, only after an explicit "this module gets everything" consent through the icanhaz window, hash-pinned so a synced vault cannot swap it silently.

### 7.5 Distribution and the plugin host

Plugins are content-addressed (`sha256:…`), vouched once per hash per vault; a registry is a signed list of hashes, the shape `witm plugin add` already has. The installed set is a document in the vault (`.eznote/plugins.toml`), so it syncs. The `PluginHost` lives in the vault package: it loads manifests, requests grants, instantiates the right sandbox, routes events, applies actions under the grant, and mounts contributions into the app's rails, node-view registries, palette and slash list.

---

## 8. The compute backend: component model, not WASIX

**WASIX** (wasmer) is WASI p1 plus POSIX extensions: threads, fork, sockets, TTY, runnable in the browser via `@wasmer/sdk`. It gives you a shell with coreutils in a tab, which is what the removed jswasi integration did, and it was removed because a remote PTY over icanhaz was more capable and less work. WASIX has no component model or WIT, is a single-vendor spec, and would put a second runtime beside wasmtime. Its sandbox is a process with a virtual fs: a container-shaped boundary you then poke holes in.

The **component model + WASI p2/p3**, which the repo already uses, has the opposite default: a component starts with nothing and gets exactly the imports the host wires. Isolation is structural; composition (policy membranes, overlays) is a linker operation; `wrpc-wasmtime` already turns any component's imports and exports into RPC, so "run it here" and "run it over there" are the same code.

Executors, from light to heavy: **browser** (jco + WASI shim: renderers, formatters, linters, plugin logic; no threads or sockets, and that is a feature); **host** (the daemon's wasmtime with the overlay membrane; or `process` with a pinned toolchain image in a clone; or WASI-compiled interpreters such as `componentize-py`, RustPython, sqlite when the user granted nothing but CPU); **peer** (the same requests over `wrpc-transport-iroh`; eznet's "a capability is a transferable handle to a unit of network computation"). Executable notes follow: a fence with `{run}` gets a run action, output cells are nodes owned by the producing plugin, and component state can be checkpointed into the workspace.

---

## 9. Capabilities in shared documents

**Principle: a document may reference a capability but never holds one.** What sits in the Markdown is a descriptor: kind, scope, and which principal hosts the resource. Never a token, because everything in the document reaches every peer.

```markdown
```rust {run cap="process(cargo test) @ theo-laptop"}
```

**Grants are per principal, issued by the broker that owns the resource.** When Alice opens the note, the block is inert for her until a broker grants her something. Three cases: the resource is on her machine, so her own consent window handles it; the resource is on the owner's machine, so her request travels over the sync transport to the owner's broker; the resource is on a third peer, same as the second. Each viewer sees the block in their own state ("needs cargo test on theo-laptop, request"). Retention is icanhaz's existing pairing store, keyed by peer identity and vault, so "always let Alice run tests here" survives restarts.

**Share bundles: deciding at share time.** The owner can decide the grants question consciously when sharing. A share is `{document version, optional grant bundle}`. The bundle contains **signed grant certificates**: `{capability descriptor, caveats (scope narrowing, TTL, budget), audience = recipient public key, issuer = owner key, signature}`. The recipient redeems a certificate at the owner's broker over the sync transport; the broker verifies the signature and audience, applies the caveats as a policy membrane, and opens a session. Properties:

- A leaked bundle is useless to anyone but the audience key.
- The owner attenuates at share time, and the broker attenuates again at redemption; attenuation is monotonic through both.
- Certificates can chain: Alice may delegate a narrower certificate to her agent if the owner's certificate carries `delegable: true`. That is the object-capability "certificate" model, and it is also how Keyhive works: documents identified by public keys delegating to other public keys.
- Revocation is by issuer key at the broker (revocation list checked at redemption and at the session's revocation token); expiry is in the caveats.
- Sharing with an agent is the same flow: the agent is a peer with a key; the share bundle is its whole authority; nothing else about it is special.

**What this requires in icanhaz.** Today's grant tokens are bearer secrets validated by an in-memory `GrantStore`. Certificates need Ed25519 signing (already present: the iroh secret key), a certificate format, and a `redeem(cert) -> grant` function on the broker next to `request`. Pairings become the persisted form of a redeemed certificate. This is a bounded change, and it is the one piece of new cryptography in this whole document.

### 9.1 Minted instances, sturdy references, and certificates

Every grant is a **minted instance** in the broker's instance table: `{id, interface, provider chain, scope (already conjoined), parent, holder, counters, expiry}`. Attenuation mints a child whose scope is `parent.allow && extra` and whose `parent` points back; the chain is host bookkeeping, never data a plugin sees. This is the object-capability answer to "how do I express a narrowed interface": the narrowed thing is an object, and the scope is the program that mediates calls to it (§13).

A **sturdy reference** is an unguessable instance id plus the broker's locator, Cap'n Proto level 2 with icanhaz as the vat. `restore(sturdyref)` by the right audience yields a live handle. A **certificate** is `{sturdy id, audience key, expiry, links, issuer signature}` where each link is `{extra clause | membrane component hash, by, signature}`. The owner's broker composes the links at restore time. Intermediaries attenuate offline by appending a link; anyone can verify the chain narrows because conjunction is syntactic, so no policy evaluation is needed to check containment. OCapN's layering is the mental model: a pairing secret is a CertBear, a share bundle entry is a Certificate, both attenuate to the owner's locator.

Formats surveyed before settling on this: macaroons (verifier needs the issuer's secret), UCAN 1.0 (native audience, but DIDs, IPLD envelopes that grow with depth, weak for budgets), Biscuit (Ed25519, offline attenuation by appending blocks, Datalog caveats, mature Rust and wasm), Keyhive (the right long-term model for concurrent revocation, pre-alpha and Automerge-coupled), SPKI (historic). **Biscuit's block structure is an acceptable encoding for the signed link chain if we want a standard container, but its Datalog authorizer would go unused, since our clauses are CEL rendered by the host, so a plain Ed25519 chain is preferred.** Keyhive is the thing to re-evaluate when live mode makes Automerge documents first-class principals.

Two mechanics: audience binding is checked at redemption against the QUIC-proven remote identity that `wrpc-transport-iroh` hands every invocation as its connection context, and a redeemed certificate persists as a pairing, which is what icanhaz already stores.

---

## 10. Patchwork (Ink & Switch): overlap, differences, what to take

Patchwork is "a collaborative, version-controlled, local-first, malleable software system" that has become the home for most of the lab's documents since 2024. Source read: `patchwork-system` (core runtime), `patchwork-pkg-base` (stock tools and datatypes), `patchwork-experiments`. The core packages declare MIT or ISC in `package.json`, the pkg-base tools we would lift (`drafts`, `comments-view`) declare nothing, and **none of the four repos carries a LICENSE file**; confirm with the lab before copying any code.

### 10.1 What it is, structurally

- **Everything is an Automerge document**, including tool source code. A SharedWorker owns one `Repo` for all tabs; a Service Worker serves `automerge:` URLs as HTTP so ES modules stored in documents can be `import()`ed. Sync is Subduction (Rust, wasm in the browser, iroh transport for native peers, a WebSocket sync server for browsers); access control and E2EE are Keyhive (`Relay | Read | Edit | Admin` per document, shared by exchanging signed contact cards). Both are explicitly pre-production.
- **A plugin registry with open types.** A package is an ES module exporting `plugins = [...]`; types in the wild are `patchwork:tool`, `patchwork:datatype`, `patchwork:component`, `codemirror:extension`, `patchwork:theme`. A tool's render contract is `(handle, element) => teardown`. Documents self-describe with `@patchwork: { type, suggestedImportUrl }`, so an unknown document says which tool renders it. The installed set is itself a synced document (`module-settings`).
- **Markdown is a plain string** (`{ content: string }` mutated with `Automerge.updateText`), edited with CodeMirror and `@automerge/automerge-codemirror`. There is no ProseMirror or WYSIWYG anywhere; the closest is an experimental Typora-style live preview.
- **"Drafts" are copy-on-write clones**, not Automerge branches: a draft doc records `parent`, `clones: { url -> { cloneUrl, clonedAt: heads, mergedAt?: heads } }`, and a `DraftOverlayProvider` swaps document handles to their clones live without remounting; merge is `target.merge(clone)` per document. History uses precomputed `ChangeGroupDoc` activity bursts and an actor-to-contact attribution document.
- **Comments** are stored inline on the document under `@comments.threads`, anchored by **document URLs** (`refs`), not text positions; Automerge cursors are used only for presence. The published "pointers" idea (one pointer type per datatype, used for comments, diff highlighting, search hits and AI targeting) is the design; the shipped anchoring is coarser.
- **Isolation** is an opt-in `@patchwork/isolation` package: a sandboxed opaque-origin iframe with an ephemeral intermediary repo, allow/deny lists (account doc, module settings, tool source denied), all imports and fetches proxied over RPC. Its threat model explicitly excludes exfiltration and fine-grained capabilities.
- **AI**: `@chee/patchwork-llm` (model picker; transformers.js, OpenRouter, Ollama in a SharedWorker; config in the account doc) and chat's `@computer`, an in-chat agent that reads and writes the selected document and previews on a draft in a pinned iframe. There is no capability gating on any of it.
- **Capability injection** inside the app is the `providers` protocol: a bubbling DOM event carrying a `MessagePort` that the nearest ancestor accepts. Unauthenticated, in-realm, but structurally the same shape as a broker.

### 10.2 Where we overlap and where we differ

| Concern | Patchwork | This RFC |
|---|---|---|
| Canonical data | Automerge documents; disk is a sync target (`pushwork`) | plain files on disk; versions and optional CRDT are sidecars |
| Editing | CodeMirror, Markdown as a string | Tiptap WYSIWYG for prose, CodeMirror for code |
| Branching | drafts = CoW clones with overlay redirection | workspaces = overlay membrane or APFS clone, same idea one layer down |
| Comments | inline on the doc, URL-anchored | inline in the Markdown text, range-anchored |
| Plugins | ES modules from documents or HTTP, dynamic `import()`, no sandbox by default | manifest + capability provider; iframe / WASM / trusted tiers |
| Isolation | opaque-origin iframe + allowlisted repo | same iframe, plus `net`, `fs`, `process`, `inference` grants |
| Access control | Keyhive: per-document Relay/Read/Edit/Admin | icanhaz: per-resource capabilities with caveats; certificates for sharing (§9) |
| Sync | Subduction servers (WebSocket) with iroh for native peers | wRPC over iroh in the daemon; relay and WebRTC adapters |
| Compute | in-browser JS only | browser, host and peer executors over WIT |
| AI | ungated | budgeted `inference` grants |

The essential difference: Patchwork answers "who may see or edit this document"; we also have to answer "what may this plugin or agent do to the user's machine". That second question is icanhaz's whole reason to exist, and Patchwork has no equivalent.

### 10.3 What to take

Patterns (no code needed):

1. **Drafts as CoW clones with `clonedAt` / `mergedAt` heads and live handle redirection.** This is our workspace model, validated at document granularity. Copy the state shape and the merge bookkeeping.
2. **Self-describing documents** (`suggestedImportUrl`, honored only for safe URL schemes). Our equivalent: front matter `renderer: sha256:…` naming a content-addressed plugin, vouched before use.
3. **An open-typed registry** where editor extensions are themselves plugins (`codemirror:extension`). Our `PluginHost` should register `tiptap:extension` and `codemirror:extension` the same way.
4. **The installed-plugin list as a synced document.** Already in §7.5.
5. **Pointers** as the one abstraction behind comments, diffs, search hits and AI targeting (§4.2).
6. **Precomputed history bursts** for the timeline UI, so history never re-diffs on scroll.
7. **`@computer` on a draft with a preview iframe** is the agent-as-peer proposing on a workspace (§5), minus the capability gating we add.

Code that is liftable in isolation, subject to license confirmation:

- `packages/providers/core` (~600 lines, depends only on `@automerge/automerge-repo` and the DOM): the subscribe/accept protocol and `OverlayRepo`. Useful as the in-page bridge for iframe plugins even without Automerge, if the repo dependency is stubbed.
- `core/plugins` (~500 lines, plain TypeScript): the registry with load and shadow semantics.
- `patchwork-pkg-base/drafts/src/{draft-types,draft-docs,clone-policy}.ts`: the CoW bookkeeping.
- `patchwork-pkg-base/comments-view/src/comments.ts`: the thread schema, trivially portable.

What not to take: the bootloader (browser-only, hard-wired SharedWorker + Service Worker + fixed wasm paths), the `<patchwork-view>` frame and anything that assumes `window.repo`, and the exact-pinned forked `automerge-repo` builds ("two of our packages published against different pins means two copies of automerge-repo, which breaks document handle identity"). If we adopt Automerge for live mode (§3) we should track upstream releases, not Patchwork's pins.

The strategic read: Patchwork proves the plugin-registry-plus-drafts UX works for a lab of writers, and the Automerge ecosystem around it (Subduction with iroh, Keyhive with signed delegations, author provenance landing in Automerge itself) is converging on the same primitives §9 needs. Riding it for the opt-in live layer is cheap; adopting it as the canonical store would cost us the "just files" promise and every tool that is not ours.

---

## 11. Use cases

1. **An agent is a peer with a share bundle.** Its authority is exactly the certificates it was given; every file version it writes is signed by its key; reverting it is "revert author X since T". It asks the broker for `process(cargo test)` and the consent window shows that sentence.
2. **Propose, don't apply.** The agent works in a workspace (overlay or clone); the note shows staged diffs as live region embeds; comments are the review channel and live in the same Markdown, so they are visible in vim; Apply commits under base-version checks.
3. **Agent code runs sandboxed by default.** "Try this snippet" gets the browser or host component executor with no fs; escalation is an explicit `process` grant with a pinned image. A prompt injection in a synced note has nothing to reach.
4. **Multi-human, multi-agent review** with differing authority per participant: a reviewer agent holds `editor-read` + `inference` and nothing else.
5. **Plugins that cannot exfiltrate.** The manifest is the privacy policy and it is enforced by the provider, the iframe CSP, or the component's imports.
6. **Inference as a shared, budgeted resource** behind one broker, logged and redacted by witmproxy.
7. **Reproducible executable notes** with checkpointed component state a peer re-runs in the same sandbox.
8. **Offline field work** over Reticulum as a transport adapter; nothing above the transport changes.
9. **Capability as code** for editor permissions: a policy component ("only edit under `## Draft`"), vouched by hash, attached to any grant or certificate.

---

## 12. Suggested sequencing

The direction of travel; §16 turns it into milestones with tasks.

1. **Foundations, no networking (editor + vault split):** images and a binary VFS, wikilinks and region embeds, front matter with `id:`, footnotes, math, callouts, full-text and link index, command palette, file tree; move file management and the index out of `codeblock` into the vault package.
2. **Versions and workspaces:** the per-file version log with base-version writes; the `edit()` path into open documents; the overlay membrane and `clonefile` resolver in icanhaz; the workspace block with Apply/Discard. This is where agents become useful and safe, and it needs no CRDT.
3. **Comments** (inline; §4) on top of versions.
4. **Capabilities in the editor:** `inference` in icanhaz; providers config; prose AI actions; the plugin manifest, provider and the iframe bridge; the `eznote:plugin` WIT and host executor.
5. **Sharing and sync:** Biscuit certificates and `redeem` in icanhaz; adopt `wrpc-transport-iroh` from djt (publish it or vendor it beside `src/rust/wrpc`); the `sync` capability; share bundles; attachment blobs; evaluate djt's browser iroh endpoint for direct peer sync from the webview.
6. **Live mode:** the opt-in CRDT session with `@automerge/prosemirror`, presence, and a Subduction or wRPC carrier; evaluate Keyhive for certificate delegation at that point.
7. **Compute:** executable fences, checkpoints, peer executors.

Decided: certificate format is Biscuit (§9.1); live mode uses `@automerge/prosemirror` (§3); plugin placement follows the wanted capabilities, with no default (§7.3). Still open: whether threads default to the footnote in the same note or to a review note when created by an agent.

---

## 13. Scoping: the CEL profile

The scope language is CEL, kept, and given three things it lacks on its own: a typed environment generated from WIT, containment by construction, and rendering.

### 13.1 Two evaluation sites

- **Event admission** (`when`): evaluated once per event with the event bound. In witmproxy this is today's `expression`, deciding whether the plugin runs for a request. In the editor it decides whether a plugin sees a document event.
- **Call admission** (`allow`): evaluated by the membrane on every method call of a minted resource, with `call.method` and `call.args` bound and typed from the WIT signature, the current event as context, `caller`, `state` and `time`. This is where "how" lives: `call.args.key.startsWith("seen/")`, `call.args.path.startsWith("src/")`, `state.tokens + call.args.max_tokens <= 50000`.

### 13.2 The environment is generated from WIT

Each interface gets a CEL environment derived from its WIT: primitives map to CEL scalars, `list` and `option` to lists and optionals, records to opaque types with accessors, resources to opaque handles exposing only an id. The generator runs at build time from `wit-parser` and replaces hand-written mirrors like witmproxy's `CelRequest`. A clause referencing an argument a method does not have fails to compile at load time, which is the first half of verification.

Variables, all optional in the environment, absent fields evaluating false so scopes fail closed: `call.{method,args}`, `event`, `caller.{plugin,key,peer,origin}`, `state.{calls,bytes,…}` plus interface-specific counters such as `tokens`, `time`. `caller` assumes attribution, not identity: in witmproxy it is the plugin's manifest namespace and signing key, which the host already verifies at load; over the network it gains the transport-proven peer key and the WebSocket origin.

### 13.3 Containment, rendering, state, rewrite

- **Containment** is append-only conjunction. Nobody edits an expression; narrowing appends a clause when the host mints a child instance. Widening is impossible by construction and checking a chain is reading it. Cedar's SMT analyzer is the only tool that could check freely rewritten scopes; with the conjunction discipline it is redundant.
- **Rendering** is a recognizer over the checked AST plus a sentence template per shape: `startsWith`, `==`, `in`, ranges, and the member functions witmproxy already has (`time.is_between_hours`, `time.matches_cron`, `request.host()`). Out-of-profile clauses are still enforced and shown as raw CEL with a badge.
- **State** lives with the minted instance in the registry, never in the clause and never in the per-event provider (witmproxy builds a `CapabilityProvider` per event, which is why logger budgets are per-event today). The membrane increments counters after each admitted call and binds a snapshot before the next. Budget clauses are pre-checks on an estimate: reserve and settle, or allow one call of overshoot. Durable budgets persist beside the grant like pairings.
- **Rewrite** (`rewrite: option<string>`, later): a CEL expression returning a transformed `args` record, as Kubernetes uses CEL for mutating admission; the rewritten call must itself satisfy `allow`. Covers "prefix every storage key with the namespace" without refusing.
- **Deep membranes** are the compiler's job: every resource a call returns is wrapped by type so a granted subtree cannot leak a wider descriptor.

### 13.4 Guest-authored attenuation code: rejected

The alternative of letting a plugin ship a Turing-complete `attenuate(ctx, cap)` was considered and rejected as a guest-facing mechanism. A wrapper can only forward, refuse or transform what it closes over, so it cannot widen, but: it is a guarantee only to the guest, never to the user, and must never be rendered as one; it only works if the wide handle becomes unreachable, which needs a bootstrap phase and an irreversible swap; it sees every call, so it must be capability-less by construction (an empty import list) or it is an exfiltration point; review does not survive conditional behaviour, obfuscation or prompt injection aimed at an AI reviewer; hand-written membranes forget to wrap returned resources and drift when interfaces gain methods; it cannot be rendered or compared. Its one legitimate niche, stateful protocol-shaped constraints, is served by the user-side membrane, which is written as a component with an empty import list (§14), not by the guest.

### 13.5 Shared implementation

A Rust crate `ezcap` beside the WIT package, used by both hosts: the WIT-to-CEL environment generator, the rendering profile, and the membrane runtime (instance table, conjunction on mint, evaluation via `cel-cxx`, counters, denial). witmproxy's `register_cel_env` and `compile_scope_expression` become calls into it; icanhaz's `GrantStore` becomes its instance table. Migration in witmproxy: `capability-scope.expression` maps to `when`; `allow` is new and makes the local-storage promise in its WIT comments true; resource methods gain `result<T, capability-error>`; the `capability-kind` variant survives internally as the names of its five provider methods.

---

## 14. Authoring capabilities in icanhaz

A capability is a component whose imports the host satisfies and whose exports satisfy a plugin's imports; `fs-lite-pathjail` is one. Four authoring tiers, because toolchain cost jumps sharply between them:

| Tier | What the user does | Runtime | Bundled cost |
|---|---|---|---|
| 1 Narrow | edits `when` / `allow` in the consent window or scope editor | generic CEL membrane | none (already planned) |
| 2 Script | picks an interface, gets every export stubbed as "call the same import", edits TypeScript in the app | one **QuickJS** interpreter component exporting a generic `dispatch(func, args)`; the host adapts real WIT calls through wasmtime's dynamic linker; script and interpreter are content-addressed as a pair | ~1 MB interpreter wasm, `wit-component` and `wac` as Rust libraries, a pure-JS type stripper (`ts-blank-space`) in the web UI |
| 3 Component | brings a `.wasm` built with `cargo component`, MoonBit, componentize-js, componentize-py | validated (imports ⊆ capability interfaces, exports match the WIT), content-addressed, scaffolded from the `witm plugin new` template; `nix run` or a container as the toolchain fallback | none |
| 4 Replace a native provider | builds icanhaz from source | — | none |

Details that make Tier 2 good: `.d.ts` generated from the WIT (`jco types`) feeds the codeblock's Volar TypeScript server, so the user gets completion against the real interface; the script sees only the wrapped capability and a frozen context, enforced by the interpreter component's empty import list; saving re-links the daemon and replays the recorded trace of a real session through the new capability, showing calls admitted, denied and rewritten; committing mints a hash and offers "apply to grants using this capability", re-instantiating them with the old hash revoked.

Decisions: wrapping is the default and replacement is Tier 3, but both come from one template that asks "what should this be built on", with the wrapped capability as the default answer. The daemon and wasmtime are the trusted computing base and are **not** editable in-app; what the app exposes is every capability component's source when a reproducible build (source hash to wasm hash) is registered, the WIT of every interface, and its CEL environment, with "fork this capability" copying source into a Tier 2 or 3 scaffold. User-authored capabilities compile to **wasm, not native**, even when the user is the author: composition, portability across executors, sharing and content-addressing, and bounding the user's own bugs all depend on it; native code belongs only to the providers at the bottom.

---

## 15. Import resolution

A WIT import is an interface, not an implementation; binding it happens at link time in the daemon and that binding is the grant. Implementations come from three places:

1. **Native providers, bundled by definition**: `wasi:filesystem`, `wasi:clocks`, `wasi:io`, `icanhaz:nocap/{process,terminal,watch}`, later `inference`. The roots of authority; a fixed set per daemon version, linked semver-compatibly.
2. **Capability components, content-addressed and fetched on demand**: a local store keyed by hash, seeded with the shipped components (passthrough, pathjail, the generic membrane, the QuickJS host). Others arrive by hash from the share bundle, the vault, a registry in the `witm plugin add` style, or a peer over iroh. Fetching code by hash is safe to do dynamically; linking it to a native provider is a grant and needs consent. Code is fetched, authority is granted, separately.
3. **Remote providers over wRPC**: `wrpc-wasmtime` polyfills imports over the wire, which is how the browser executor gets `fs` from the daemon and how a peer executor gets a capability another machine advertises. The only sense in which an import is "fetched dynamically" is authority from a consenting peer.

Rule for Tier 3 components: libraries are not imports. Regex engines, parsers and the like are composed in at build time with `wac`; the validator rejects any remaining import that is not a known capability interface with "compose your libraries", or offers automatic composition when the library component is in the store.

Resolution at grant time, per import: match a native provider (bind directly or through a membrane chain the user chooses); else a store component whose exports satisfy it, resolving its imports recursively; else fetch by hash from the source of the reference, verify, vouch, and retry; else a remote provider with its own consent; else fail with "no provider for `ezco:ezcap/inference@0.1.0`" and list what could provide it. The binary bundles the native providers and the shipped components, nothing more; an unsatisfiable import is a grant-time event, not an install-time one, and that is the right moment to offer a provider.

---

## 16. Work plan

Priorities (2026-09-14): icanhaz and `ezco:ezcap` first, witmproxy second, editor work after. icanhaz is the capability registry and provider everything else builds on; witmproxy may keep its own in-process registry where per-request latency rules out a broker round trip, but it uses the same types and the same `ezcap` crate. `inference` is an icanhaz capability (M2b), not an editor feature. Milestones are ordered by dependency; each names what it touches and the test that proves it. M4 (authoring tiers) is icanhaz work.

**M0. `ezco:ezcap` package and `ezcap` crate.** Publish `ezco:ezcap@0.1.0` (types from §7) to the wkg registry witmproxy already resolves from, vendored under `src/apps/icanhaz/wit/deps` and `src/apps/witmproxy/wit/deps`. New crate `src/rust/ezcap`: WIT-to-CEL environment generator over `wit-parser`; rendering profile (AST recognizer, sentence templates); membrane runtime (instance table, conjunction on mint, `cel-cxx` evaluation, counters, `denied`). Tests: golden environments for `wasi:filesystem` and witmproxy's `request-context`; a property test that a child instance never admits a call its parent denies; sentence rendering for every profile shape. Event variables stay host-owned: witmproxy's scopes call member functions (`request.host()`) on opaque event values, and that style must keep compiling, so `ezcap` generates only `call.*`, `caller.*` and `state.*` and the host registers its event environment through `Membrane::with_builder`. **Status: landed on branch `ezcap` (2026-09-14)** as `src/rust/ezcap` with the package vendored into both hosts' `wit/deps`; 19 tests, clippy-clean under the workspace lints.

**M1. witmproxy adopts it.** `capability-scope` becomes `ezco:ezcap/types.scope` (`expression` maps to `when`); `allow` evaluated per call on logger, annotator, local-storage and clock; resource methods return `result<T, capability-error>`; counters move from the per-event `CapabilityProvider` to registry-owned grants; the web UI scope editor becomes "add a condition" rendered as sentences. Tests: the noshorts plugin narrowed to `key.startsWith("seen/")` with the denial path exercised end to end; an existing manifest with only `expression` loads unchanged. First PR: `capability-scope` gains `allow` (default `"true"`), the four provider resources become membranes over `ezcap::Membrane`, and `CapabilityProvider::build` mints instances from registry-owned grants instead of cloning per event.

**E1. Editor foundations and the vault split.** Images and a binary `VfsInterface`; wikilinks and region embeds; front matter with `id:`; footnotes; math; callouts; full-text and link index; command palette; file tree in eznote; file management and the search index move out of `codeblock` into `@joinezco/vault`. Tests: round-trip for every new node; index rebuild from a fixture vault.

**M2. icanhaz instances, generic membrane, sturdy references.** (icanhaz) Instance table replaces `GrantStore`; `broker.request` takes `ezco:ezcap/types.capability`; a generic CEL membrane component per shipped interface, generated at build, replaces ad-hoc attenuation, with deep wrapping of returned resources; `narrow(instance, clause)` for pledge-style self-narrowing; `restore(sturdyref)`; the consent window renders sentences. Tests: `fs-passthrough` under the generic membrane with `allow: call.args.path.startsWith("src/")`; a browser test that a denied call surfaces `denied(sentence)`; restore by the wrong audience fails.

**M2b. `inference` capability in icanhaz.** `icanhaz:nocap/inference` with a providers config (`~/.icanhaz/providers.toml`: Anthropic, OpenAI-compatible, Ollama, the `claude`/`codex` CLIs, any process), streamed completions over wRPC, `state.tokens` counters, model and budget as `allow` clauses. Tests: a grant scoped to one model refuses another; a budget clause denies past its limit; witmproxy can request the same capability from the daemon for a plugin that wants it.

**E2. Versions and workspaces.** Per-file signed version log with base-version writes; the `edit()` path into open documents; the overlay membrane and `clonefile` resolver in icanhaz (depends on M2); the workspace block with Apply and Discard. Tests: stale base refused; overlay writes never touch the host until Apply; clone is O(1) on APFS.

**E3. Comments.** URL anchors (text fragments, pinned spans, block ids), footnote threads with target lists, margin UI, W3C annotation export. Tests: re-anchoring after edits; multi-range; cross-note threads via the index.

**M3. Certificates and share bundles.** Ed25519-signed link chain; `redeem(cert)` with audience checked against the `wrpc-transport-iroh` connection context; pairing as the persisted form of a redeemed certificate; adopt `wrpc-transport-iroh` from djt (publish or vendor beside `src/rust/wrpc`). Tests: a bundle redeemed by its audience; the same bundle refused for another key; an appended link that widens is rejected at verification.

**E4. Capabilities in the editor.** `inference` capability in icanhaz with a providers config; prose AI actions; plugin manifest with `wants: list<capability>`; the `PluginHost` in the vault package; the iframe bridge speaking the provider over `postMessage`; the `eznote:plugin` WIT and host executor. Tests: a plugin denied `net` cannot fetch; the same plugin under the host executor reaches `fs` through the membrane.

**M4. Authoring tiers.** Tier 2: QuickJS host component with generic `dispatch`, dynamic-linker adapter, `.d.ts` from WIT into the codeblock TypeScript server inside icanhaz's web UI, replay diff against a recorded trace. Tier 3: validator, component store, scaffold from the witmproxy template, reproducible-build registration and view-source. Tests: a scripted wrapper that refuses writes outside a prefix; a Tier 3 component with a stray library import rejected with the composition hint.

**M5. Import resolution and remote providers.** The resolver from §15; fetch by hash from bundle, vault, registry and peer; remote provider over wRPC with consent; "no provider" UX listing sources. Tests: a component whose import resolves through a store component two levels deep; a browser-executor plugin whose `fs` import is polyfilled from the daemon.

**E5. Sync.** The `sync` capability, share bundles in the editor, attachment blobs, presence; evaluate djt's browser iroh endpoint for direct peer sync from the webview.

**E6. Live mode.** Opt-in `@automerge/prosemirror` sessions, history sidecar, exit-to-file; re-evaluate Keyhive.

**E7. Compute.** Executable fences, checkpoints, peer executors.

Suggested first two weeks: M0 in full, then M2 (icanhaz instance table and generic membrane) and M1 (witmproxy on `ezco:ezcap`) in parallel, since they touch different codebases. Editor milestones start after M2.
