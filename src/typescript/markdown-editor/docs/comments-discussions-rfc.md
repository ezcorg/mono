# RFC: Comments / discussions for `@joinezco/markdown-editor`

**Status:** Draft for review — not yet implemented.
**Author:** Claude (design hand-off).
**Audience:** the implementing agent, and the maintainer (to refine before build).

> This is a *design proposal*. Sections marked **OPEN** are decisions for the maintainer
> to make before/while implementing. Nothing here has been built; treat the data shapes
> and APIs as a starting point, not a frozen spec.

---

## 1. Goal & requirements

Add threaded **discussions** (not code comments) to documents. A discussion:

- references **0..N ranges** of text in a document (0 = a document-level note; 1 = a single
  span; N = several discontinuous spans pointing at one thread);
- is **threaded** (a thread = an ordered list of messages, each authored markdown);
- has lifecycle state (open / resolved), and ideally reactions + per-user read state;
- can be **created offline** and later **synchronized peer-to-peer** ("gossip"), merging
  without a central server.

The planned storage substrate is **P2P + CRDT** (see [icanhaz-real-impl] context): documents
and the filesystem are CRDTs that resolve conflicts on sync. Comments must fit that model.

The two hard questions: **(a) where do comments live** (in the doc vs. beside it), and
**(b) how does an anchor survive concurrent edits** to the text it points at.

---

## 2. Anchoring (the crux)

A comment points at a text range; under concurrent offline edits the character offsets
shift. Three strategies, in increasing robustness:

1. **Character offsets** — `{from, to}` integers. Brittle: any earlier insert/delete
   invalidates them. ❌ Rejected as a primary.
2. **CRDT relative positions** — a stable position *identity* in the document CRDT that the
   CRDT migrates across inserts/deletes and merges deterministically. ✅ **Primary.**
   - Yjs: `Y.RelativePosition` (`Y.createRelativePositionFromTypeIndex` /
     `Y.createAbsolutePositionFromRelativePosition`); `y-prosemirror` already maps between
     PM positions and relative positions and ships a remote-cursor plugin.
   - Automerge: `Cursor` (`getCursor` / `getCursorPosition`); `@automerge/prosemirror` binds.
3. **Quote + context** (W3C-annotation / Hypothesis style) — store the quoted text plus a
   prefix/suffix window; re-anchor by fuzzy search. Survives format changes and *orphaning*
   (the CRDT position deleted), at the cost of occasional misses. ✅ **Fallback.**

**Recommendation: store both per range.** Resolve via the CRDT relative position; if it can't
be resolved (the anchored content was deleted), keep the thread but mark it **orphaned** and
use the quote to *offer* re-anchoring rather than silently dropping it.

> **Consequence:** robust anchoring requires the **document itself to be a CRDT** (so anchors
> are positions *in* it). This editor is Tiptap/ProseMirror; a CRDT binding
> (`y-prosemirror` or `@automerge/prosemirror`) is therefore a prerequisite for comments —
> see §6.

**OPEN — CRDT library:** Yjs vs Automerge. Recommendation: **Yjs**, because `y-prosemirror`
is the most mature ProseMirror CRDT binding and relative positions are first-class and cheap
to encode. Automerge is viable if the broader storage layer is already Automerge-based —
align with whatever [icanhaz-real-impl]/the filesystem layer chooses. This choice should be
made *once* for the whole P2P stack, not just comments.

---

## 3. Where comments live: embedded vs. sidecar

### Embedded in the `.md` (footnotes / asides / HTML comments)
- ➕ Self-contained; travels with the file; degrades to readable footnotes in any viewer.
- ➖ Pollutes the content; forces discussion (mutable, multi-author, threaded, resolvable,
  read-state) to merge *interleaved with prose*; a non-editor reader sees raw syntax;
  anchoring-inside-the-same-doc is awkward.

### Sidecar in the filesystem (separate document, recommended)
- ➕ Clean separation of concerns; the `.md` stays pristine.
- ➕ Comments become their **own CRDT**, synced/gossiped **independently** of the document
  (and independently permissionable later).
- ➕ Naturally supports threads, resolved status, reactions, read-state, multiple
  comment-sets per doc (e.g. per branch/reviewer) — none of which belong in the prose.
- ➖ Two things to sync; the sidecar↔doc link and anchors must stay valid (§2).

**Recommendation: sidecar.** It is the natural fit for P2P/CRDT/gossip: comments are a
distinct, independently-syncable CRDT. Keep an *optional* "export to embedded footnotes" for
interop/printing (§7), but the sidecar is canonical.

### Linking sidecar ↔ document
Key the sidecar by a **stable document ID**, not the file path (paths change; comments must
survive renames/moves).

**OPEN — document identity:** options, pick one:
- a `uuid` in the doc's YAML frontmatter (visible, simple, but edits the content);
- the document CRDT's own id (e.g. a Yjs `Y.Doc.guid`) recorded in fs metadata;
- an fs-level id / xattr maintained by the filesystem layer.

Recommendation: reuse the **CRDT doc id** the storage layer already assigns each document, so
there's a single identity scheme across the stack.

### Sidecar path layout (illustrative)
```
/.ezco/comments/<docId>            # the comments CRDT for document <docId>
                                   # (stored as the CRDT's native update log / snapshot)
```
`.ezco/` is a hidden, app-owned namespace in the same virtual filesystem the editor already
uses (`Fs`/`VfsInterface` in `@joinezco/codeblock`: `readFile`/`writeFile`/`readdir`/…).

---

## 4. Data model (sidecar CRDT)

A comments document is a CRDT keyed to one target document. Logical shape (concrete encoding
is the CRDT's — e.g. a Yjs `Y.Map` of threads, each a `Y.Map`, messages a `Y.Array`):

```jsonc
{
  "version": 1,
  "targetDocId": "<docId>",
  "threads": {
    "<threadId>": {
      "id": "<threadId>",
      "status": "open",                 // "open" | "resolved"   (LWW register)
      "createdBy": "<peerId>",
      "createdAt": 1719500000000,       // epoch ms (informational; ordering is causal)
      "anchors": [                      // 0..N ranges this thread points at
        {
          "id": "<anchorId>",
          "relStart": "<encoded CRDT relative position>",
          "relEnd":   "<encoded CRDT relative position>",
          "quote":  "the exact text that was selected",
          "prefix": "…N chars before…",   // fuzzy re-anchor fallback
          "suffix": "…N chars after…"
        }
      ],
      "messages": [                     // append-mostly; ordering causal
        {
          "id": "<msgId>",
          "author": "<peerId>",
          "bodyMarkdown": "looks good, but…",
          "createdAt": 1719500000000,
          "editedAt": null,
          "reactions": { "👍": ["<peerId>", …] }   // emoji -> peers (set semantics)
        }
      ]
    }
  }
}
```

CRDT semantics:
- **threads / messages**: add-wins maps/arrays — concurrent additions all survive.
- **status**: last-writer-wins register (or a tiny 2-state CRDT) — concurrent resolve/reopen
  settles deterministically.
- **message body edits**: LWW on `bodyMarkdown` per message (or a nested text CRDT if
  collaborative editing of a single comment is wanted — probably overkill; **OPEN**).
- **reactions**: per-emoji set of peer ids (add/remove-wins — pick one; add-wins is simplest).
- **deletes**: tombstone (mark `deleted: true`) rather than hard-remove, so a concurrent
  reply doesn't resurrect a thread inconsistently.

---

## 5. Sync / gossip / offline

- The comments CRDT syncs on its **own** update stream, independent of the document. Offline
  edits accumulate locally; on peer contact, exchange updates (state vectors / update diffs)
  and merge. No central server.
- Because it's a CRDT, **offline-made comments merge cleanly** with others' — no manual
  conflict resolution.
- **Anchor resolution needs the target doc loaded.** A relative position references the target
  document's CRDT structure, so to turn it into a screen range the editor must have the
  document CRDT in memory (it does, while editing). When browsing comments *without* the doc
  (e.g. a notifications view), show `quote` text instead of a live highlight.
- **Orphans:** if `relStart`/`relEnd` no longer resolve (anchored text deleted), the thread is
  retained, flagged `orphaned`, and surfaced in a "resolve/re-anchor" affordance using
  `quote`/`prefix`/`suffix`.

---

## 6. Editor integration

Fits the Part 1 architecture: comments ship as a **standalone, opt-in Tiptap extension**
(individually exported; added by `markdownSetup({ comments })` or imported directly).

```ts
import { Comments } from '@joinezco/markdown-editor/extensions/comments'
// or: markdownSetup({ comments: { provider, currentUser } })
```

Responsibilities:
1. **Provider boundary.** The extension does *not* own storage/CRDT/transport. It takes a
   `CommentsProvider` the host supplies, e.g.:
   ```ts
   interface CommentsProvider {
     // resolve the comments CRDT for the currently-open document
     load(docId: string): Promise<CommentStore>
     // reactive: notify on remote/merged changes so the editor re-renders
     subscribe(cb: () => void): () => void
   }
   ```
   The default app wires this to the Yjs/Automerge + fs sidecar; a different consumer can back
   it however they like. (Mirrors how `FileSystem`/`Toolbar` take an injected `Fs`.)
2. **Rendering — decorations, never serialized.** Anchored ranges render as ProseMirror
   `Decoration.inline` highlights computed from the store; the *document content is never
   touched*, so `getMarkdown()` stays clean. (Same proven pattern as `HeadingAnchors` /
   `lists.ts`, which already use DOM-only decorations.)
3. **Affordances.** A margin/gutter indicator (count of threads on a line) + a thread popover
   (read/reply/resolve/react). Reuse the existing menu surfaces + `--ezco-mde-context-menu-*`
   theme vars for visual consistency. The "add comment" entry can hang off the existing
   selection menu.
4. **Commands & API.** Tiptap commands (`addComment`, `replyToThread`, `resolveThread`,
   `reactToMessage`) and an imperative handle on `editor.storage.comments`
   (`getThreads()`, `focusThread(id)`, `setProvider(...)`) — consistent with Part 1's
   "return objects the user can manipulate" goal.

```ts
export interface CommentsOptions {
  provider: CommentsProvider
  currentUser: { id: string; displayName?: string }
  /** Where the thread popover / list mounts (default: body-appended, like other menus). */
  mount?: (root: HTMLElement) => HTMLElement | null
  /** Render orphaned threads? default true (surfaced for re-anchor/resolve). */
  showOrphaned?: boolean
}
```

---

## 7. Interop / degradation (optional)

Keep the sidecar canonical, but offer a one-way **export to embedded footnotes** for sharing
with non-editor tools or printing:
- each resolved-or-open thread → a numbered footnote/aside appended to the exported `.md`,
  with the quoted span marked. This is an *export artifact*, not the source of truth, and is
  not re-imported (avoids the embedded-merge problems of §3).

---

## 8. Phased implementation

1. **P1 — local, single store.** Comments extension + `CommentsProvider` interface; sidecar
   read/write through the existing `Fs`; decorations + popover UI + commands. Anchor with
   relative positions against a **local** document CRDT (introduce the `y-prosemirror` /
   `@automerge/prosemirror` binding here) + quote fallback. No networking yet.
2. **P2 — sync/gossip.** Wire the comments CRDT to the P2P transport; offline queue + merge;
   orphan detection + re-anchor UI.
3. **P3 — polish.** Reactions, per-user read/unread, notifications view (quote-only, no live
   highlight), embedded-footnote export.

---

## 9. Decisions to confirm before building (checklist)

- [ ] **CRDT library** (Yjs recommended) — must match the broader P2P/fs layer.
- [ ] **Document identity** scheme (CRDT doc id recommended) and sidecar path layout.
- [ ] Comments as a **separate** CRDT doc (recommended) vs. a sub-tree of the document's CRDT.
- [ ] Whether a single comment body is **LWW** or its own collaborative text CRDT.
- [ ] Reaction semantics (add-wins set recommended) and delete = **tombstone** policy.
- [ ] Scope of P1 (recommend: local sidecar + decorations + UI, *before* any networking).

---

### Cross-references
- Builds on the Part 1 API refactor (this same change set): comments will be an
  individually-exported, opt-in extension consumed via `markdownSetup`.
- The decoration approach mirrors `extensions/heading-anchors.ts` and `extensions/lists.ts`.
- The provider/injection pattern mirrors `extensions/filesystem.ts` and `extensions/toolbar.ts`
  (host supplies the `Fs`/index; the extension stays storage-agnostic).
