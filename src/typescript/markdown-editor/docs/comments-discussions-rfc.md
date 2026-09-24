# RFC: Comments and discussions

**Status:** v2, 2026-09-24. Replaces the v1 draft (a sidecar CRDT with
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
what the range holds now. A change made elsewhere (another program, a merge)
is met by the search above when the note is read, and the target is rewritten
to the text it was found at, so the next search is exact again. A pin needs
neither.

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
- **Margin.** Beside the note, each thread is a card level with its first
  target, cards pushed down so none overlap: the header, the body and
  replies rendered as Markdown, reactions as chips, and Reply, Resolve (or
  Reopen), React, Pin, Delete. Anchored text is highlighted; hovering or
  clicking a highlight brings its card forward, and the card's targets are
  highlighted more strongly. Resolved threads fold to one line. Orphaned
  targets show their quote. Where there is no room for a margin (a narrow
  column), a card opens as a popover from its highlight.
- **Commands.** `addComment({ ranges?, body })` (the selection when no ranges
  are given; several ranges make one multi-range thread), `replyToComment`,
  `resolveComment` / `reopenComment`, `reactToComment` (a toggle),
  `pinComment` (turn a thread's text-fragment targets into pins),
  `deleteComment`. `editor.storage.comments` has `threads()` (each with its
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
- Signed authorship: a handle is a name the author chose; the version log's
  signatures (E2's remaining work) will say who wrote a version, and so who
  wrote what a version added.
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
