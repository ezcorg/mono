/**
 * Comments, as Markdown: a comment is a document that references a range of
 * another document. Any note may hold **references**, and everything is a
 * document; the vault's index gathers them (`CommentIndex`).
 *
 * A reference is a line of a top-level paragraph that is exactly one embed,
 * `![[target#fragment]]` (the wikilink grammar: the fragment may be a text
 * fragment `:~:text=…`, a pin `c-…`, a block id `^abc`, a heading, or
 * absent for the whole document), and its **body** is the Markdown after
 * it, up to the next reference, the next top-level heading, or the end of
 * the document. Written, a blank line separates the embed from its body;
 * read, it is optional, so the embed may share a paragraph with its body:
 *
 *     ![[Plan#:~:text=ship%20it]]
 *     Which release?
 *
 *     ![[Plan#^abc]]
 *     Done, I think.
 *
 * A bare embed with no body is a transclusion, not a comment. Code never
 * starts or ends a reference (a body may hold a code block), nor does an
 * embed or a heading inside a quote or a list; front matter is skipped.
 * What is a paragraph, a heading or code is the one parse every index
 * reads (`parseNote`), so the editor and the index agree.
 */
import { formatWikilink, matchWikilinkAt, type Wikilink } from './links/syntax.js'
import { parseNote, type ParsedNote } from './parse.js'

/** A reference as it sits in a document. */
export interface Reference {
    /** What it is about: the embed's link. */
    link: Wikilink
    /** The Markdown under the embed, blank lines trimmed at both ends. */
    body: string
    /** Offsets of the reference's text in the document: from the first
     *  character of the embed line to the end of the body's last line
     *  (without the newline). */
    start: number
    end: number
    /** 1-based line of the embed. */
    line: number
    /** The reference's text as written, `markdown.slice(start, end)`. */
    text: string
}

/** The link of a line that is exactly one embed (trailing whitespace
 *  allowed), or null. */
function embedLine(line: string): Wikilink | null {
    if (!line.startsWith('![[')) return null
    const m = matchWikilinkAt(line, 0)
    return m && m.embed && !line.slice(m.end).trim() ? m.link : null
}

function trimBlankLines(lines: string[]): { from: number; to: number } {
    let from = 0
    let to = lines.length
    while (from < to && !lines[from].trim()) from++
    while (to > from && !lines[to - 1].trim()) to--
    return { from, to }
}

/**
 * Every reference in `markdown`, in order: each embed-only paragraph with
 * the Markdown under it. CRLF line ends are tolerated (`text` keeps them;
 * `body` does not).
 */
export function referencesIn(markdown: string): Reference[] {
    return referencesOf(parseNote(markdown))
}

/** The references of a note already parsed (what `referencesIn` does with
 *  the parse). */
export function referencesOf(note: ParsedNote): Reference[] {
    const { lines, offsets, text: markdown } = note
    // Where a body stops short of the next reference: a top-level heading.
    const stops = note.headings.filter((h) => h.depth === 0).map((h) => h.from)
    const opens: { link: Wikilink; at: number }[] = []
    for (const paragraph of note.paragraphs) {
        for (let at = paragraph.from; at < paragraph.to; at++) {
            const link = embedLine(lines[at])
            if (link) opens.push({ link, at })
        }
    }
    const out: Reference[] = []
    let stop = 0
    for (let k = 0; k < opens.length; k++) {
        const { link, at } = opens[k]
        while (stop < stops.length && stops[stop] <= at) stop++
        let end = opens[k + 1]?.at ?? lines.length
        if (stop < stops.length && stops[stop] < end) end = stops[stop]
        const body = lines.slice(at + 1, end)
        const { from, to } = trimBlankLines(body)
        if (to <= from) continue
        const start = offsets[at]
        const last = at + to
        const finish = offsets[last] + lines[last].length
        out.push({ link, body: body.slice(from, to).join('\n'), start, end: finish, line: at + 1, text: markdown.slice(start, finish) })
    }
    return out
}

/** A reference as Markdown: the embed, then the body (blank lines trimmed
 *  at both ends) on the lines under it. */
export function formatReference(link: Wikilink, body: string): string {
    const lines = body.split(/\r?\n/)
    const { from, to } = trimBlankLines(lines)
    const head = formatWikilink(link, { embed: true })
    // A blank line between them: the embed is a paragraph of its own in
    // any Markdown editor, and the text a paragraph after it (without one,
    // an editor that keeps line breaks would read the two as one).
    return to > from ? `${head}\n\n${lines.slice(from, to).join('\n')}` : head
}

/** `markdown` with the reference replaced by `replacement` (null: removed,
 *  with its line break, and the blank line before it when only a blank line
 *  or the end follows). */
export function spliceReference(markdown: string, ref: Pick<Reference, 'start' | 'end'>, replacement: string | null): string {
    if (replacement !== null) return markdown.slice(0, ref.start) + replacement + markdown.slice(ref.end)
    let before = markdown.slice(0, ref.start)
    let at = ref.end
    if (markdown.startsWith('\r\n', at)) at += 2
    else if (markdown[at] === '\n') at++
    const blankBefore = before.endsWith('\n\n') || before.endsWith('\r\n\r\n')
    if (blankBefore && (at >= markdown.length || markdown[at] === '\n' || markdown.startsWith('\r\n', at))) {
        before = before.slice(0, before.endsWith('\r\n') ? -2 : -1)
    }
    return before + markdown.slice(at)
}

/** A reference and the document that holds it (the index's answer). */
export interface CommentRef extends Reference {
    /** The document holding it, a vault path. */
    source: string
}

/**
 * The references of a vault by what they are about: what the editor asks to
 * show the comments on a note beside it, and how it changes them where they
 * live. `Vault.comments` implements it.
 */
export interface CommentIndex {
    /** References in other documents whose link resolves to `note` (any
     *  fragment, or none), by source then line. */
    about(note: string): Promise<CommentRef[]>
    /** References in `doc` itself (what it comments on), in order. */
    in(doc: string): Promise<CommentRef[]>
    /**
     * Write `next` in place of the reference `ref` read (its link and body);
     * null removes it, and removes the document when nothing but blank lines
     * is left of it. Refused (throws) when the reference's text is no longer
     * what `ref` read: read it again. Returns the reference as now written.
     */
    update(ref: CommentRef, next: { link: Wikilink; body: string } | null): Promise<CommentRef | null>
    /** Be told when the answers above may have changed. */
    subscribe?(listener: () => void): () => void
}
