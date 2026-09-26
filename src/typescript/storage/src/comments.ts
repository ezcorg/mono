/**
 * Comments, as Markdown: a comment is a document that references a range of
 * another document. Any note may hold **references**, and everything is a
 * document; the vault's index gathers them (`CommentIndex`).
 *
 * A reference is a paragraph that is exactly one embed, `![[target#fragment]]`
 * (the wikilink grammar: the fragment may be a text fragment `:~:text=…`, a
 * pin `c-…`, a block id `^abc`, a heading, or absent for the whole
 * document), and its **body** is the Markdown after it, up to the next
 * reference paragraph, the next heading, or the end of the document:
 *
 *     ![[Plan#:~:text=ship%20it]]
 *     Which release?
 *
 *     ![[Plan#^abc]]
 *     Done, I think.
 *
 * A bare embed with no body is a transclusion, not a comment. Fenced code
 * never starts or ends a reference (a body may hold a code block); front
 * matter is skipped.
 */
import { formatWikilink, matchWikilinkAt, type Wikilink } from './links/syntax.js'

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

const ATX_HEADING = /^#{1,6}(?:\s|$)/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/

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
    const raw = markdown.split('\n')
    const lines = raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    const offsets: number[] = []
    let at = 0
    for (const l of raw) {
        offsets.push(at)
        at += l.length + 1
    }
    let first = 0
    if (lines.length > 1 && lines[0] === '---') {
        const close = lines.findIndex((l, k) => k > 0 && (l === '---' || l === '...'))
        if (close > 0) first = close + 1
    }
    // Each line outside fenced code that starts a reference (an embed) or
    // ends one (a heading), and the lines that are code.
    const code = new Set<number>()
    let fence: string | null = null
    for (let i = first; i < lines.length; i++) {
        if (fence) {
            code.add(i)
            const f = FENCE_CLOSE.exec(lines[i])
            if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
        } else {
            const f = FENCE_OPEN.exec(lines[i])
            if (f) {
                fence = f[1]
                code.add(i)
            }
        }
    }
    const out: Reference[] = []
    let open: { link: Wikilink; at: number } | null = null
    const close = (to: number) => {
        if (!open) return
        const body = lines.slice(open.at + 1, to)
        const { from, to: end } = trimBlankLines(body)
        if (end > from) {
            const start = offsets[open.at]
            const last = open.at + 1 + end - 1
            const stop = offsets[last] + lines[last].length
            out.push({ link: open.link, body: body.slice(from, end).join('\n'), start, end: stop, line: open.at + 1, text: markdown.slice(start, stop) })
        }
        open = null
    }
    for (let i = first; i < lines.length; i++) {
        if (code.has(i)) continue
        const link = embedLine(lines[i])
        if (link) {
            close(i)
            open = { link, at: i }
        } else if (ATX_HEADING.test(lines[i])) close(i)
    }
    close(lines.length)
    return out
}

/** A reference as Markdown: the embed, then the body (blank lines trimmed
 *  at both ends) on the lines under it. */
export function formatReference(link: Wikilink, body: string): string {
    const lines = body.split(/\r?\n/)
    const { from, to } = trimBlankLines(lines)
    const head = formatWikilink(link, { embed: true })
    return to > from ? `${head}\n${lines.slice(from, to).join('\n')}` : head
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
