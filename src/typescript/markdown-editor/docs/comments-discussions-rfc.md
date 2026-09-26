# RFC: Comments and discussions

**Status:** v2, 2026-09-24, built (branch `editor-e1`) but for §6. Replaces the v1 draft (a sidecar CRDT with
relative-position anchors), which the platform RFC's §3 and §4 overruled:
files are the unit, the CRDT is opt-in, and a comment is Markdown in a note.
This document is the detailed design behind the platform RFC's §4 and its
E3 milestone; where they differ, this one is newer.

## 1. What a comment is

A **thread** is a footnote whose first line is a header: who started it,
when, whether it is open, and what it is about. Its targets are links, the
same strings "copy link to highlight" produces, so a comment's anchor and a
shareable link are one thing.

```markdown
The quick brown fox jumps over the [lazy dog]{#c-01JAB3C4D5EFGHJK}.

[^c-01JAB3C4D5EFGHJK]: @theo 2026-09-13T12:04Z · open · [[#:~:text=brown%20fox]] [[#c-01JAB3C4D5EFGHJK]]
    Are both of these the same animal? See [[Zoology]].
    - @alice 2026-09-13T12:10Z: No, and the second one should be a cat.
      - @theo 2026-09-13T12:12Z: 👍
```

Everything a thread needs is in the file: it survives any tool that keeps
text, diffs and merges as text, reads as a footnote in a viewer that knows
footnotes (and not at all in one that drops unreferenced definitions, which
is the usual choice), and has history through the version log (E2). There is
no sidecar and no store of its own.

### 1.1 Grammar

- **Thread header** (a footnote definition's first line, or a list item's):
  `@handle TIME · STATUS · TARGETS`. `handle` is `[A-Za-z0-9_.-]+`; `TIME`
  is UTC ISO 8601 to the minute or second (`2026-09-13T12:04Z`); `STATUS` is
  `open` or `resolved` (absent: open); `TARGETS` is zero or more wikilinks
  separated by spaces (absent: the thread is about the whole note). A
  definition is a thread when its first line has this shape, whatever its
  label; the editor labels new threads `c-` and a ULID prefix (16
  characters: time, then randomness).
- **Body**: the lines under the header, indented as the footnote's (four
  spaces) or the list item's (two). Any Markdown.
- **Replies**: a bullet list at the body's indentation whose items start
  `- @handle TIME: `, the reply's first line after the colon. A reply's own
  replies are a list under it. Replies are ordered as written.
- **Reactions**: a reply whose whole body is emoji is a reaction to what it
  replies to (`- @theo 2026-09-13T12:12Z: 👍`). Plain Markdown shows it as
  a reply, which is what it is; the editor shows it as a chip.

The grammar lives in `@joinezco/storage` (`comments.ts`), with the link
grammar, so the editor and the index read threads the same way. A thread the
editor has not changed is written back byte for byte; one it changed is
written in the canonical form above.

### 1.2 Targets

A target is a wikilink whose fragment is one of:

- a **text fragment**, `#:~:text=[prefix-,]start[,end][,-suffix]`: a quote
  (and context), found by search. No markup in the body.
- a **pin**, `#c-…`: the id of a **bracketed span** (Pandoc's and Djot's
  `[text]{#id .class key=value}`) put around the text. A pin moves with its
  text under any edit and orphans only when its text is deleted.
- a **block id**, `#^abc`, or a **heading**, `#Goals`, as links already have.

With a note name in front (`[[Zoology#:~:text=…]]`) a target is in another
note. N targets make a multi-range thread; none, a note-level one.

## 2. Anchoring

**Creating.** "Comment" on a selection makes a text fragment for it: the
quote itself when short (up to 60 characters), else its first and last few
words as `start,end`, with a few words of prefix and suffix added only as far
as needed to make it match once in the note. When no context makes it match
once (the quoted text repeats word for word, with the same surroundings), the
editor pins the selection instead.

**Finding.** A text fragment is looked for as written, then without regard to
case, then approximately: the place in the note whose text is nearest the
quote (edit distance at most a quarter of its length), preferring a place
whose prefix and suffix also match. A pin is its span; a block id, its block.
A target found nowhere is **orphaned**: the thread stays, shows the quote it
had, and offers to anchor it again on a new selection.

**Re-anchoring.** An edit in the editor is exact: the editor keeps where each
target is and maps it through every change, so when text inside a quoted
range is changed, the target is rewritten (in the same undo step) to quote
what the range holds now; while the note is edited here, no approximate
search runs, so a quote whose text was deleted is orphaned rather than
re-attached to text that merely resembles it. A change made elsewhere
(another program, a merge) is met by the search above when the note is read,
and the target is rewritten to the text it was found at, so the next search
is exact again. A pin needs neither.

## 3. Where threads live, and the index

A thread's default place is the footnote at the end of the note it discusses.
It can equally be a list item in any other note (a review note, a day's
comments, an agent's report) with the same header and targets that name the
note:

```markdown
- @alice 2026-09-13T12:10Z · open · [[Plan#:~:text=ship%20it]]
  Which release?
  - @theo 2026-09-13T12:12Z: The next one.
```

The vault's index reads every note's threads (both forms) and answers which
threads are about a note (`CommentIndex.threadsAbout(path)`), and changes a
thread where it lives (`update(ref, thread)`, refused if the thread's text
changed since it was read). The editor shows a note's own threads and those
the index finds elsewhere in one margin; replying to, resolving or reacting to
a thread from elsewhere writes the note that holds it.

## 4. The editor

- **Nodes.** The pin is a generic `span` mark (id, classes, attributes), so
  bracketed spans round-trip whatever they are for. A thread parses to a
  `commentThread` block node holding its source; it is hidden in the body and
  shown in the margin.
- **Showing threads.** Anchored text is highlighted, and that is all that
  shows by default: clicking a highlight (or `focusComment`) opens that one
  thread as a card over the note's edge, just under its text, and Escape or
  a click elsewhere closes it (`margin: { layout: 'float' }`, the default:
  the editor's chrome stays out of the way until asked for). A host may ask
  for a column instead (`layout: 'column'`): every open thread a card beside
  the note, level with its first target, cards pushed apart so none overlap,
  the one being looked at at its text and the others moved out of its way,
  resolved threads folded away until asked for; where the column would leave
  the note too narrow, the threads float after all. A card is the thread's
  messages, each with author and time and its body rendered as Markdown,
  reactions as chips under the message they answer, replies nested and
  folding on a click. Orphaned targets show their quote and offer to be
  anchored again on a selection; a thread from another note says where it
  lives.
- **Acting on a message.** Under each message, one row: its reactions (the
  four most given; the rest behind "+n"), React (one control: the common
  reactions and the recently picked ones in a row, "…" for the whole grid,
  which opens on the recent row, or the common reactions standing in for it,
  and the first category, never blank), Reply, Resolve or Reopen on the
  thread's first message, and a menu with Edit and Delete. A reply is
  written right under the message it answers, in the editor itself in small
  (the note's `markdownSetup` without its chrome: the same code blocks over
  the same files, `[[links]]`, `:emoji:`, `/`); an edit takes the message's
  place. What is typed is a draft kept in the browser (never in the note,
  never seen by anyone else) until posted, so Cancel, which closes the
  thread, loses nothing; "Open in editor" writes the same draft in a
  full-size view over the note, with the thread and the passage it is about
  beside the editor. Delete asks once in the row; a message others have
  answered stays as a tombstone (`[deleted]`) so their replies keep their
  place, one nobody answered goes, and the thread with it when it was the
  first. Every message can be edited or deleted by whoever can edit the
  note: a thread is text in the reader's file, and its author is a name
  written down, not a lock (§6). Pinning (writing a bracketed span around
  the text) is not a card action: the editor pins on its own when no quote
  can be unique, and `pinComment` remains for a host that wants it. A
  floating card never extends the page (under its text when the scroll area
  has room, else above it), and the reader can drag it by a message's head
  and resize it by its corner; it then stays where it was put.

### 4.1 Where this is going: a comment as a document

The threaded view is a visualization, not the model. The shape to grow
toward: each comment may be a document of its own (a note in the vault),
in which different passages can point at different ranges of the note it
is about, each shown in the note as its own comment; a reply is then a
comment whose subject is another comment document; the thread is what the
index gathers from those references. Threads as footnotes (§1) are the
in-note form of the same thing, and stay the default for a short comment.
The full-size view above is the first step: a comment written as a
document, with the document it is about in view. Not built.
- **Commands.** `addComment({ ranges?, body })` (the selection when no ranges
  are given; several ranges make one multi-range thread), `replyToComment`,
  `editComment`, `resolveComment` / `reopenComment`, `reactToComment` (a
  toggle), `pinComment` (turn a thread's text-fragment targets into pins),
  `deleteComment` (a reply, or the whole thread and its pins),
  `focusComment`. `editor.storage.comments` has `threads()` (each with its
  targets resolved), `focus(id)`, `exportAnnotations()` and
  `markdownWithoutComments()`.
- **Who.** The host gives the author's handle (`comments: { author }`);
  without one, threads are shown and not written.

## 5. Export

- **Strip**: the note without threads and with pins unwrapped to their text
  (`stripComments(markdown)` in storage; `markdownWithoutComments()` in the
  editor).
- **W3C Web Annotations**: one annotation per thread (`motivation:
  commenting`, the body as `text/markdown`, one target per resolved range with
  a `TextQuoteSelector` and a `TextPositionSelector` over the note's text) and
  one per reply (`motivation: replying`, targeting the annotation it answers).
  Hypothesis and other annotation tools read this.
- **Flatten** is a no-op: a thread is already a footnote.

## 6. Not yet

- Read and unread, per device, in `.eznote/state/<device>/` (the RFC's §4):
  needs the device identity of §9.
- Notifications of replies across a vault.
- Signed authorship: a handle is a name the author chose (or, in eznote
  today, the login name the device derived), and nothing in the text
  guarantees it: anyone who can edit the note can write, change or delete
  any message under any name, and the editor does not pretend otherwise (no
  message is locked to its author in the UI). The version log's signatures
  (E2's remaining work) will say who wrote a version, and so who wrote what
  a version added; peer-to-peer sync of notes carrying comments (E5) needs
  that attestation before a handle means anything across devices.
- Live co-editing of a comment (E6): a thread is text in the note, so a live
  session carries it with nothing more.

## 7. Decisions (v1's open questions)

| v1 asked | Answer |
|---|---|
| CRDT library | None for comments. A thread is text; E6's live mode, when a note uses it, carries it. |
| Where comments live | In the note (or another note), as Markdown. No sidecar. |
| Document identity | Not needed for anchoring: targets are links, resolved like any link, and renames rewrite them (the vault keeps links). |
| Comment body: LWW or its own CRDT | A message is text in a file; concurrent edits are the version log's conflicts. |
| Reactions | Emoji-only replies; toggled per author. |
| Deletes | Removed from the text; the version log keeps what was there. |
