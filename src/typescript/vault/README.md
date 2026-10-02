# `@joinezco/vault`

A folder of Markdown notes as a knowledge base, over any
[`@joinezco/storage`](../storage) filesystem: what links to what, full-text
search, comments as references between documents, text fragments,
reactions, note ids, and the `Vault` that keeps every index current. No
DOM, no ProseMirror: the editor takes these as interfaces from its host.

The files are the truth. Everything here is rebuilt from them and kept
current as they change; nothing is synced.

## One parse

A note is parsed once per change (`parseNote`): its front matter, which
lines are code, its headings, its top-level paragraphs and every link, by
markdown-it's block grammar with raw HTML off, as the editor configures it.
The link graph, the search index and the comment index all read that one
parse, so they agree with each other and with the editor on what a heading,
a fence and a link are. `scanLinks(text)` and `rewriteLinks(text, replace)`
are the parse's links and a byte-faithful rewrite of their targets.

## `Vault`

```ts
const vault = await Vault.open(fs, { identity: 'theo' }) // walks once; `new Vault(fs)` indexes in the background
vault.fs // the same filesystem, observed: writes through it update the indexes
vault.links // LinkIndex & LinkResolver
vault.search // FileSearch (storage's contract)
vault.files // FileOperations; rename keeps every link meaning what it meant
vault.versions // VersionLog
vault.comments // CommentIndex: references by what they are about
vault.reactions // Reactions: an identity's emoji on documents and references
```

Every index is asked through its contract. A vault keeps its own state in
one dot-directory, `.vault/` by default (`Vault.open(fs, { dir })`): the
version log and each identity's state under `.vault/state/<identity>/`.
Dot-directories are out of every index.

## Links

One grammar, used by the editor's parser and the index alike
(`links/syntax.ts`): wikilinks and embeds (Obsidian's syntax), Markdown links
and images, reference definitions, wikilinks in front matter; code is
skipped. A Markdown link is a path from its note. A wikilink is a name,
resolved as Obsidian does so existing vaults keep working: beside the note,
from the root, then by path tail anywhere, closest first. A rename moves the
file and rewrites links to it as qualified as they were written, fixes links
inside the moved note, and lengthens a wikilink the new name would capture.

Resolutions are kept, not recomputed: a note's links are resolved when it
is read, and resolved again only when a file appears or goes whose name
could change them (a wikilink is a name, so a new `plan.md` anywhere can
capture `[[plan]]`; a Markdown link is a path). Backlinks are a lookup, and
the dangling links a set kept as resolutions change.

## Comments

A comment is a document that references a range of another document. Any
note may hold **references**: a line of a top-level paragraph that is
exactly one embed, `![[Plan#:~:text=ship%20it]]`, whose fragment is a text
fragment (the anchor `textFragmentFor` makes and `findTextFragment` finds),
a pin (`c-…`), a block id (`^abc`), a heading, or absent for the whole
document. The Markdown under the embed, up to the next reference, the next
top-level heading or the end, is the comment's **body**; an embed with no
body is a transclusion, not a comment. Written back, a blank line separates
the two (the embed is a paragraph of its own in any Markdown editor); read,
the blank line is optional. Code never starts or ends a reference, nor
does an embed or a heading inside a quote or a list: the parse is the
editor's.

```markdown
![[Plan#:~:text=ship%20it]]

Which release?

![[Plan#^abc]]

Done, I think.
```

`referencesIn(markdown)` reads them (`referencesOf(parsed)` given the
parse), `formatReference` and `spliceReference` write them back: one that
did not change goes back byte for byte. `vault.comments` (a `CommentIndex`)
answers `about(note)`, the references in other documents whose link
resolves to it, and `in(doc)`, what a document comments on, and
`update(ref, { link, body } | null)` changes or removes one where it lives,
refusing when the text is no longer what was read; removing the last thing
in a document removes the document. A rename rewrites the links in
references like any other.

A **reaction** is an identity's emoji on a document or one of its
references, kept as per-identity state rather than as a document:
`.vault/state/<identity>/reactions.jsonl`, one JSON line each
(`{"at","doc","ref","emoji"}`; `ref` is the reference's link as
`referenceKey` writes it, without brackets or alias, null for the
document). `vault.reactions.on(doc)` reads every identity's; `toggle(to,
emoji)` adds or takes away the vault's own, given as `Vault.open(fs, {
identity })`; without one it is read-only.

## Search

`vault.search` is MiniSearch over every file's path and name and every
note's title, headings and text, from the parse; the snippet shown with a
hit is read from the file when the hit is asked for. `titleOf(path, note)`
is a note's title: `title:` in its front matter, else its first heading,
else its name.

## Notes

`isNote(path)` says what is parsed as prose (`md`, `markdown`, `mdx`).
`newNoteId()` makes ULIDs for a note's `id:`; `noteIdOf(text)` reads it;
`frontMatterOf(text)` is the YAML between the fences.

## Test

```sh
pnpm test:run   # Node, against in-memory vaults and the fixture vault in src/__fixtures__
pnpm typecheck
pnpm build
```
