/**
 * A note's block structure, read once. The link index, the full-text index
 * and the comment index all take a note from here, so they agree with each
 * other, and with the editor, on what is a heading, what is code and what
 * is a link: the block grammar is markdown-it's with raw HTML off, as the
 * editor configures it.
 *
 * Front matter (`---` alone on the first line, closed by `---` or `...`) is
 * read here, and scanned for wikilinks only (Obsidian treats a property
 * value of `"[[Note]]"` as a link). Unclosed, the `---` is a rule, as it is
 * to the editor.
 */
import MarkdownIt from 'markdown-it'
import { scanLine, type ScannedLink } from './links/syntax.js'

/** A range of lines: 0-based, `to` exclusive. */
export interface LineRange {
    from: number
    to: number
}

export interface Heading extends LineRange {
    /** 1 to 6. */
    level: number
    /** 0 at the top level; more inside a quote or a list. */
    depth: number
    /** The heading's text as written, inline Markdown kept. */
    text: string
}

export interface ParsedNote {
    text: string
    /** The lines, each without its CR. */
    lines: string[]
    /** Offset in `text` of each line's first character. */
    offsets: number[]
    /** The front matter block, fences included, with its YAML; null when
     *  the note has none. */
    frontMatter: (LineRange & { yaml: string }) | null
    /** Whether each line is code: fenced or indented, at any depth. */
    code: boolean[]
    /** Every heading, in order, at any depth. */
    headings: Heading[]
    /** The paragraphs at the top level (not in a quote or a list). */
    paragraphs: LineRange[]
    /** Every link, by position. */
    links: ScannedLink[]
}

let blocks: MarkdownIt | null = null

/** markdown-it with its block rules alone: structure is all this needs. */
function parser(): MarkdownIt {
    if (!blocks) {
        blocks = new MarkdownIt('default', { html: false })
        blocks.core.ruler.disable(['inline', 'linkify', 'replacements', 'smartquotes', 'text_join'], true)
    }
    return blocks
}

/** `text` as lines without their CR, and where each one starts. */
export function splitLines(text: string): { lines: string[]; offsets: number[] } {
    const raw = text.split('\n')
    const lines: string[] = new Array(raw.length)
    const offsets: number[] = new Array(raw.length)
    let at = 0
    for (let i = 0; i < raw.length; i++) {
        offsets[i] = at
        at += raw[i].length + 1
        lines[i] = raw[i].endsWith('\r') ? raw[i].slice(0, -1) : raw[i]
    }
    return { lines, offsets }
}

/** The line closing a front matter block opened on the first line (`---`
 *  alone; closed by `---` or `...`, trailing blanks allowed), or -1 when
 *  there is none. */
export function frontMatterClose(lines: string[]): number {
    if (lines.length < 2 || lines[0] !== '---') return -1
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].replace(/[ \t]+$/, '')
        if (line === '---' || line === '...') return i
    }
    return -1
}

/** A note's structure and links, in one pass. */
export function parseNote(text: string): ParsedNote {
    const { lines, offsets } = splitLines(text)
    const close = frontMatterClose(lines)
    const frontMatter = close > 0 ? { from: 0, to: close + 1, yaml: lines.slice(1, close).join('\n') } : null
    const body = frontMatter ? frontMatter.to : 0
    const code: boolean[] = new Array<boolean>(lines.length).fill(false)
    const headings: Heading[] = []
    const paragraphs: LineRange[] = []
    const links: ScannedLink[] = []
    for (let i = 1; i < close; i++) scanLine(lines[i], offsets[i], i + 1, links, { wikilinksOnly: true })
    const tokens = parser().parse(lines.slice(body).join('\n'), {})
    for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t]
        if (!token.map) continue
        const from = token.map[0] + body
        const to = token.map[1] + body
        if (token.type === 'fence' || token.type === 'code_block') {
            for (let l = from; l < to && l < lines.length; l++) code[l] = true
        } else if (token.type === 'heading_open') {
            headings.push({ from, to, level: Number(token.tag.slice(1)), depth: token.level, text: tokens[t + 1]?.content ?? '' })
        } else if (token.type === 'paragraph_open' && token.level === 0) {
            paragraphs.push({ from, to })
        }
    }
    for (let i = body; i < lines.length; i++) if (!code[i]) scanLine(lines[i], offsets[i], i + 1, links)
    links.sort((a, b) => a.start - b.start)
    return { text, lines, offsets, frontMatter, code, headings, paragraphs, links }
}

/** Every link in a note: `parseNote(text).links`. */
export function scanLinks(text: string): ScannedLink[] {
    return parseNote(text).links
}

/**
 * `text` with some links' targets replaced. `replace` returns the new target
 * as it should be written (already relative and, for Markdown links, already
 * encoded), or null to leave a link alone. Everything else is kept byte for
 * byte. Returns the new text and how many links changed.
 */
export function rewriteLinks(text: string, replace: (link: ScannedLink) => string | null): { text: string; count: number } {
    let out = ''
    let last = 0
    let count = 0
    // In target order, not link order: a link inside another's text
    // (`[![thumb](a.png)](b.png)`) starts later but its target comes first.
    // Targets never overlap, so splicing them in order is safe.
    for (const link of scanLinks(text).sort((a, b) => a.targetStart - b.targetStart)) {
        const next = replace(link)
        if (next === null || next === link.target) continue
        out += text.slice(last, link.targetStart) + next
        last = link.targetEnd
        count++
    }
    return { text: out + text.slice(last), count }
}
