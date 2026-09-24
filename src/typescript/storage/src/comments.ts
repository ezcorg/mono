/**
 * Comment threads, as Markdown (comments RFC §1): the grammar the editor and
 * the vault's index both read.
 *
 * A thread is a footnote definition, or a list item, whose first line is a
 * header, `@handle TIME · STATUS · TARGETS`; the lines under it are its body,
 * and a bullet list of `- @handle TIME: …` items at the body's indentation
 * are its replies (a reply's replies nest under it). A reply that is only
 * emoji is a reaction.
 *
 *     [^c-01JAB3C4D5EFGHJK]: @theo 2026-09-13T12:04Z · open · [[#:~:text=brown%20fox]]
 *         Are both of these the same animal?
 *         - @alice 2026-09-13T12:10Z: No.
 *           - @theo 2026-09-13T12:12Z: 👍
 *
 *     - @alice 2026-09-13T12:10Z · open · [[Plan#:~:text=ship%20it]]
 *       Which release?
 */
import { newNoteId } from './id.js'
import { formatWikilink, matchWikilinkAt, type Wikilink } from './links/syntax.js'

export type ThreadStatus = 'open' | 'resolved'

export interface Message {
    /** The handle, without `@`. */
    author: string
    /** UTC, ISO 8601 to the minute or second: `2026-09-13T12:04Z`. */
    time: string
    /** Markdown. */
    body: string
    replies: Message[]
}

export interface Thread extends Message {
    status: ThreadStatus
    /** What the thread is about; none for the whole note. */
    targets: Wikilink[]
}

/** A thread as it sits in a note. */
export interface ThreadSource {
    /** A footnote definition (`[^label]: …`) or a list item (`- …`). */
    form: 'footnote' | 'item'
    /** The footnote's label; null for a list item. */
    label: string | null
    thread: Thread
    /** Offsets of the thread's text in the note (from its first character
     *  to the end of its last line, without the newline). */
    start: number
    end: number
    /** 1-based line of the header. */
    line: number
    /** The thread's text as written. */
    text: string
}

const HANDLE = '[A-Za-z0-9_.-]+'
const TIME = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?Z'
const THREAD_HEADER = new RegExp(`^@(${HANDLE}) (${TIME})((?: · .*)?)$`)
const REPLY_HEADER = new RegExp(`^- @(${HANDLE}) (${TIME}):(?: (.*))?$`)
const FOOTNOTE = /^\[\^([^\]\s]+)\]: (.*)$/
/** A line that starts a block of its own (so is no lazy continuation). */
const BLOCK_START = /^(?:\[\^|#{1,6}(?:\s|$)|[-*+](?:\s|$)|\d+[.)](?:\s|$)|>|```|~~~|\||(?:-{3,}|\*{3,}|_{3,})\s*$)/

/** A new thread's label: `c-` and the first 16 characters of a ULID (the
 *  time it was made, then randomness). */
export function newCommentId(now: number = Date.now()): string {
    return `c-${newNoteId(now).slice(0, 16)}`
}

/** A message's time, as threads write it: UTC to the minute. */
export function commentTime(now: number = Date.now()): string {
    return `${new Date(now).toISOString().slice(0, 16)}Z`
}

/** True for a body that is only emoji (a reaction). */
export function isReaction(body: string): boolean {
    const text = body.trim()
    return !!text && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|‍|️|\s)+$/u.test(text) && /\p{Extended_Pictographic}/u.test(text)
}

/** The wikilinks a field is made of, or null when it holds anything else. */
function targetsOf(field: string): Wikilink[] | null {
    const out: Wikilink[] = []
    let pos = 0
    while (pos < field.length) {
        if (field[pos] === ' ') {
            pos++
            continue
        }
        const m = matchWikilinkAt(field, pos)
        if (!m || m.embed) return null
        out.push(m.link)
        pos = m.end
    }
    return out.length ? out : null
}

/** A thread header's parts, and any text after them (the body's first
 *  line, when someone wrote it on the header's line). */
export function parseThreadHeader(line: string): { author: string; time: string; status: ThreadStatus; targets: Wikilink[]; rest: string } | null {
    const m = THREAD_HEADER.exec(line)
    if (!m) return null
    let status: ThreadStatus | null = null
    let targets: Wikilink[] | null = null
    const fields = m[3] ? m[3].slice(' · '.length).split(' · ') : []
    let i = 0
    for (; i < fields.length; i++) {
        const field = fields[i].trim()
        if ((field === 'open' || field === 'resolved') && status === null && targets === null) status = field
        else if (targets === null && targetsOf(field)) targets = targetsOf(field)
        else break
    }
    return { author: m[1], time: m[2], status: status ?? 'open', targets: targets ?? [], rest: fields.slice(i).join(' · ') }
}

/** Lines under a header, dedented: the body, then the replies. */
function parseBody(lines: string[]): { body: string; replies: Message[] } {
    const first = lines.findIndex((l) => REPLY_HEADER.test(l))
    const bodyLines = first < 0 ? lines : lines.slice(0, first)
    return { body: trimBlankLines(bodyLines).join('\n'), replies: first < 0 ? [] : parseReplies(lines.slice(first)) }
}

function parseReplies(lines: string[]): Message[] {
    const out: Message[] = []
    let i = 0
    while (i < lines.length) {
        const m = REPLY_HEADER.exec(lines[i])
        if (!m) {
            i++
            continue
        }
        const j = extent(lines, i, 2)
        const inner = lines.slice(i + 1, j).map((l) => dedent(l, 2))
        const { body, replies } = parseBody(inner)
        const firstLine = m[3] ?? ''
        out.push({ author: m[1], time: m[2], body: firstLine && body ? `${firstLine}\n${body}` : firstLine || body, replies })
        i = j
    }
    return out
}

/** Where the block starting at line `i` ends (exclusive): the lines after it
 *  that are blank, indented by `indent`, or a lazy continuation of the line
 *  before; not the blank lines at its end. */
function extent(lines: string[], i: number, indent: number): number {
    const pad = ' '.repeat(indent)
    let j = i + 1
    while (j < lines.length) {
        const l = lines[j]
        if (l.trim() === '' || l.startsWith(pad) || l.startsWith('\t')) j++
        else if (lines[j - 1].trim() !== '' && !BLOCK_START.test(l)) j++
        else break
    }
    while (j > i + 1 && lines[j - 1].trim() === '') j--
    return j
}

const dedent = (line: string, indent: number) =>
    line.startsWith('\t') ? line.slice(1) : line.startsWith(' '.repeat(indent)) ? line.slice(indent) : line.trimStart()

function trimBlankLines(lines: string[]): string[] {
    let a = 0
    let b = lines.length
    while (a < b && !lines[a].trim()) a++
    while (b > a && !lines[b - 1].trim()) b--
    return lines.slice(a, b)
}

/** A thread from its header line and the lines under it (dedented). */
export function parseThread(header: string, lines: string[]): Thread | null {
    const h = parseThreadHeader(header)
    if (!h) return null
    const { body, replies } = parseBody(h.rest ? [h.rest, ...lines] : lines)
    return { author: h.author, time: h.time, status: h.status, targets: h.targets, body, replies }
}

/** A footnote definition's text (`[^label]: header` and its indented
 *  lines) as a thread, or null when its first line is no thread header. */
export function parseThreadDefinition(text: string): { label: string; thread: Thread } | null {
    const lines = text.split('\n')
    const m = FOOTNOTE.exec(lines[0])
    if (!m) return null
    const thread = parseThread(m[2], lines.slice(1).map((l) => dedent(l, 4)))
    return thread ? { label: m[1], thread } : null
}

/** A reply's first line would read as a block of its own after `: `. */
const startsBlock = (line: string) => BLOCK_START.test(line) || /^ {4}/.test(line)

function replyLines(m: Message): string[] {
    const body = m.body ? m.body.split('\n') : []
    const inline = body.length > 0 && !startsBlock(body[0]) ? body.shift()! : ''
    const head = `- @${m.author} ${m.time}:${inline ? ` ${inline}` : ''}`
    const inner = [...body, ...m.replies.flatMap(replyLines)]
    return [head, ...inner.map((l) => (l ? `  ${l}` : ''))]
}

/** The thread's header line. */
export function formatThreadHeader(t: Thread): string {
    const targets = t.targets.length ? ` · ${t.targets.map((link) => formatWikilink(link)).join(' ')}` : ''
    return `@${t.author} ${t.time} · ${t.status}${targets}`
}

/** A thread as Markdown: a footnote definition with `label`, or (label
 *  null) a list item. */
export function formatThread(t: Thread, label: string | null): string {
    const inner = [...(t.body ? t.body.split('\n') : []), ...t.replies.flatMap(replyLines)]
    const pad = label === null ? '  ' : '    '
    const head = label === null ? `- ${formatThreadHeader(t)}` : `[^${label}]: ${formatThreadHeader(t)}`
    return [head, ...inner.map((l) => (l ? pad + l : ''))].join('\n')
}

/**
 * Every thread in a note: footnote definitions whose first line is a thread
 * header, and top-level list items that are (a header with a status or
 * targets, so a reply is not taken for one). Code blocks and front matter
 * are skipped.
 */
export function threadsIn(markdown: string): ThreadSource[] {
    const lines = markdown.split('\n')
    const offsets: number[] = []
    let at = 0
    for (const l of lines) {
        offsets.push(at)
        at += l.length + 1
    }
    const out: ThreadSource[] = []
    let i = 0
    // Front matter.
    if (lines[0] === '---') {
        const close = lines.findIndex((l, k) => k > 0 && (l === '---' || l === '...'))
        if (close > 0) i = close + 1
    }
    let fence: string | null = null
    for (; i < lines.length; i++) {
        const line = lines[i]
        const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
        if (fence) {
            if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
            continue
        }
        if (f) {
            fence = f[1]
            continue
        }
        const footnote = FOOTNOTE.exec(line)
        const item = !footnote && line.startsWith('- ') ? parseThreadHeader(line.slice(2)) : null
        if (footnote && parseThreadHeader(footnote[2])) {
            const j = extent(lines, i, 4)
            const thread = parseThread(footnote[2], lines.slice(i + 1, j).map((l) => dedent(l, 4)))!
            out.push(source('footnote', footnote[1], thread, i, j))
            i = j - 1
        } else if (item && (item.targets.length || /^- @\S+ \S+ · (?:open|resolved)\b/.test(line))) {
            const j = extent(lines, i, 2)
            const thread = parseThread(line.slice(2), lines.slice(i + 1, j).map((l) => dedent(l, 2)))!
            out.push(source('item', null, thread, i, j))
            i = j - 1
        }
    }
    return out

    function source(form: ThreadSource['form'], label: string | null, thread: Thread, from: number, to: number): ThreadSource {
        const start = offsets[from]
        const end = offsets[to - 1] + lines[to - 1].length
        return { form, label, thread, start, end, line: from + 1, text: markdown.slice(start, end) }
    }
}

/** A thread about a note, where it lives (the index's answer). */
export interface CommentRef extends ThreadSource {
    /** The note that holds the thread. */
    source: string
    /** For each of the thread's targets, whether it is in the note asked
     *  about (the others are in other notes). */
    about: boolean[]
}

/**
 * The threads of a vault by what they are about: what the editor asks to
 * show threads written elsewhere beside a note (comments RFC §3), and how it
 * changes them where they live. `Vault.comments` implements it.
 */
export interface CommentIndex {
    /** Threads in other notes with a target in `note` (a vault path). */
    threadsAbout(note: string): Promise<CommentRef[]>
    /**
     * Put `next` in place of the thread (`null` removes it), and return it as
     * now written. Refused when the thread's text is no longer what `ref`
     * read (someone changed it meanwhile): read it again.
     */
    update(ref: CommentRef, next: Thread | null): Promise<CommentRef | null>
    /** Be told when the answers above may have changed. */
    subscribe?(listener: () => void): () => void
}

/** `markdown` with `thread` replaced by `replacement` (null: removed, with
 *  its line break, and the blank line before it when only a blank line or
 *  the end follows). */
export function spliceThread(markdown: string, thread: Pick<ThreadSource, 'start' | 'end'>, replacement: string | null): string {
    if (replacement !== null) return markdown.slice(0, thread.start) + replacement + markdown.slice(thread.end)
    let before = markdown.slice(0, thread.start)
    let at = thread.end
    if (markdown[at] === '\n') at++
    if (before.endsWith('\n\n') && (at >= markdown.length || markdown[at] === '\n')) before = before.slice(0, -1)
    return before + markdown.slice(at)
}

/** The pins a note's own threads point at: the ids in their `[[#id]]`
 *  targets (a text fragment, a block id or a heading is no pin). */
function pinnedIds(threads: ThreadSource[]): Set<string> {
    const ids = new Set<string>()
    for (const { thread } of threads) {
        for (const t of thread.targets) {
            if (!t.target && t.fragment && !t.fragment.startsWith(':~:') && !t.fragment.startsWith('^') && /^[\w-]+$/.test(t.fragment)) ids.add(t.fragment)
        }
    }
    return ids
}

/**
 * The note without its comments: its footnote threads removed (with the
 * blank line each leaves) and the bracketed spans they pin unwrapped to
 * their text. List-item threads are a note's content and stay.
 */
export function stripComments(markdown: string): string {
    const threads = threadsIn(markdown).filter((t) => t.form === 'footnote')
    if (!threads.length) return markdown
    const pins = pinnedIds(threads)
    let out = markdown
    // From the last, so the earlier offsets hold.
    for (const t of [...threads].reverse()) out = spliceThread(out, t, null)
    return unwrapPins(out, pins)
}

/** `[text]{#id …}` for each of `ids`, as `text`. */
function unwrapPins(markdown: string, ids: Set<string>): string {
    if (!ids.size) return markdown
    return markdown.replace(/\[((?:\\.|[^\\\[\]])*)\]\{([^{}\n]*)\}/g, (whole, text: string, attrs: string) => {
        const id = /(?:^|\s)#([\w-]+)(?=\s|$)/.exec(attrs)?.[1]
        return id && ids.has(id) ? text : whole
    })
}
