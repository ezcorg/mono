# RFC: Comments and discussions

**Status:** v3, 2026-09-26, built (branch `editor-e1`). Replaces v2 (threads
as footnotes with a header grammar), which the owner overruled: a comment
is a document, and there is no thread grammar at all.

## 1. Everything is a document

A **comment** is a document that references a range of another document
and says something about it. The reference is the embed the editor already
has, `![[Plan#:~:text=ship%20it]]`, which quotes the passage it names; the
comment's text is what follows it:

```markdown
![[Plan#:~:text=ship%20it]]

Which release? The next one, I'd say.

![[Plan#:~:text=on%20Friday]]

Fridays are bad for releases.
```

One document, two comments on Plan. In any other tool this reads as two
quoted passages with notes under them, each a link to its place in Plan.

- **The reference** is a paragraph that is exactly one embed. Its fragment
  is a text fragment (`:~:text=`), a pin (`c-…`, a bracketed span
  `[text]{#c-…}` in the note), a block id (`^abc`), a heading, or absent
  for the whole document.
- **The text** is everything after the reference up to the next reference,
  the next heading, or the end of the document. A bare embed with nothing
  under it is a transclusion, not a comment.
- **A reply** is a document referencing a range of a comment's text: the
  same thing one level up. A thread is what the index gathers by following
  references, recursively. The threaded view is a visualization of that.
- **Who and when** are the document's, not a block's: a comment made in
  the editor is named `<handle> <date> <time>.md` under `comments/<note>/`,
  and that name is read back as author and time. A document named
  otherwise is shown by its name. Signed authorship comes with device
  identity (platform RFC §9); a name is a name.

The grammar lives in `@joinezco/storage` (`comments.ts`: `referencesIn`,
`formatReference`, `spliceReference`) and the index in `Vault.comments`
(`about(note)`, `in(doc)`, `update(ref, next)`).

## 2. Reactions and resolution

A reaction is a statement by an identity about a document or one of its
references. It is not a document (one file per 👍 would litter the vault)
and not text in anyone's document (it is the identity's, not the author's).
It is per-identity state in the vault's own directory:

```
.vault/state/<identity>/reactions.jsonl
{"at":"2026-09-26T14:02Z","doc":"comments/Plan/theo 2026-09-26 14.02.md","ref":"Plan#:~:text=ship%20it","emoji":"👍"}
```

One file per identity, appended to and rewritten by that identity alone;
the index reads every identity's file (`Vault.reactions`: `on(doc)`,
`toggle(to, emoji)`). Sync carries the state directory as a unit, and the
device's key will sign the file. **Resolution is a ✅ reaction** on the
comment: it is resolved while any identity's ✅ is on it, and reopening
takes one's own ✅ away. Nothing new to parse, and reacting works the same
on a document, a comment or a reply.

## 3. Anchoring

The editor finds a reference's target in the open note: a text fragment as
written, then regardless of case, then, when the note was just read,
approximately (edit distance at most a quarter of the quote, prefix and
suffix preferred); a pin by its span; a block id or heading by its block.
While the note is edited here a target is mapped through each edit, so a
quote whose words are being changed stays with them and, when the note is
saved, the reference is rewritten where it lives to quote what is there
now. A target found nowhere is **orphaned**: the comment stays, shows what
it quoted, and offers to be anchored to a new selection. Text no quote can
tell apart is pinned instead (the editor writes the span into the note).

## 4. The editor

- **Showing.** Commented text is highlighted, resolved text with a quiet
  dotted mark, and that is all that shows by default. Where two comments'
  text overlaps, the overlap is marked deeper, and a click on it looks at
  the narrowest comment first, then the next, round again. A comment on the
  whole of a document (a reply quotes the whole of the comment it answers,
  so its document, opened, has the replies as comments on all of it)
  highlights nothing: its card sits at the top. Clicking a highlight (or
  `focusComment`) opens that one comment as a card over the note's edge, by
  its text (`margin: { layout: 'float' }`); Escape or a click elsewhere
  closes it. A host may ask for a column (`layout: 'column'`): every open
  comment beside the note, level with its text, cards pushed apart, resolved
  ones folded away until asked for; where the column would leave the note
  too narrow, it floats. A floating card never extends the page.
- **A card** shows the comment as a message: who and when over it, its
  text in a bubble (rendered with the note's own content styles at the size
  it is edited at; the reader's own messages on the right, in the accent,
  others' on the left), and under the bubble one quiet row: its reactions
  (the four most given, the rest behind "+n"), React (the common reactions
  and the recently picked ones in a row, "…" for the whole grid), how many
  replies it has, and "…" for the rest: Reply, Resolve or Reopen, Edit,
  Delete, Open document (the comment as a note in the editor, where its
  own replies are the comments). The replies stay out of the way until the
  count is clicked; then the thread unfolds under the message, each reply
  a message of its own, indented, a reply with answers of its own folding
  them with [−]/[+] as a news site folds threads, and a field at the end
  for the next reply. Cards move apart as threads unfold, so none covers
  another.
- **Writing.** A new comment is written in a small composer by the end of
  the text it is about; a reply, under what it answers, in the editor
  itself in small: the note's `markdownSetup` without its chrome, so code
  blocks open the same files and `[[links]]`, `:emoji:` and `/` work. What
  is typed is kept in the browser until posted; Cancel closes the card and
  loses nothing. Posting makes the document. **Open in editor** makes the
  document with what was written and loads it: the editor is then the
  editor of the comment, whose first block quotes what it answers and opens
  it at that place. From the note, a card's menu opens the comment's
  document; from the document, its reference opens the note at the
  passage. The same at every level.
- **Drafts.** **Draft** keeps a comment in this browser instead of writing
  its document (`ezco-mde-comment-queue:<note>` in `localStorage`): it is
  marked as a draft in the note (a dashed underline in the accent) and on
  its card, only its author sees it, and a reply to a draft is a draft too.
  A bar over the note counts the note's drafts and publishes or discards
  them all at once; a draft's "…" publishes or discards it alone (with the
  drafts answering it). Publishing writes the documents in the order the
  drafts were made, a reply's reference made from its parent's text as
  just written, so a whole conversation can be authored first and put in
  the vault together, or not at all.
- **Deleting** a comment nobody answered removes its reference from its
  document (and the document, when nothing else is in it); one others have
  answered keeps its place as `[deleted]`, so their replies keep theirs.
  Every comment can be edited or deleted by whoever can edit the vault:
  authorship is a name, not a lock, until identities sign.
- **Commands.** `startComment`, `addComment({ body, ranges?, open?, draft? })`,
  `replyToComment(id, body, { open?, draft? })`, `editComment`,
  `deleteComment`, `publishComments(ids?)`, `discardComments(ids?)`,
  `resolveComment`, `reopenComment`, `reactToComment(id, emoji)`,
  `openComment`, `anchorComment`, `focusComment`. `editor.storage.comments`
  has `comments()` (threaded, targets found; drafts among them, marked
  `draft`), `drafts()`, `exportAnnotations()` (W3C Web Annotations: one
  per comment, `replying` ones targeting the comment they answer).
- **Who.** The host gives `comments: { author, index, reactions }`; without
  an author, comments are shown and not written; without `reactions`, none
  are shown or made. With only `fs`, the editor's own vault provides both,
  as `author`.

## 5. Not yet

- Read and unread, per device: the same state directory, when devices have
  identities.
- Notifications of replies across a vault.
- Signed authorship and signed reactions: the device key (platform RFC §9).
- Reopening a comment someone else resolved (their ✅ is theirs to remove).
