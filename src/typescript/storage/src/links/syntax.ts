/**
 * The link grammar of a note, in one place: the editor's Markdown parser and
 * the vault's link index both use it, so what the editor renders as a link is
 * exactly what the index counts.
 *
 * Wikilinks (Obsidian's syntax, which Foam, Logseq and Quartz share):
 *
 *     [[target]]  [[target|alias]]  [[target#heading]]  [[#heading]]
 *     [[target#^block]]  [[target#:~:text=quote]]  ![[target]] (an embed)
 *
 * `target` names a note or file; `fragment` is everything after the first
 * `#`; `alias` everything after the first `|` (written `\|` inside a table,
 * where a bare pipe would end the cell). All three are kept exactly as
 * written, so formatting a parsed link gives the source back.
 */

export interface Wikilink {
    /** The note or file named, as written (`plan`, `notes/plan`, `img.png`).
     *  Empty for a link into the current note (`[[#heading]]`). */
    target: string
    /** Everything after the first `#`, or null when there is no `#`. */
    fragment: string | null
    /** Everything after the first `|`, or null when there is no alias. */
    alias: string | null
}

/**
 * Parse the text between `[[` and `]]`. Returns null when it is not a link:
 * empty, spanning lines, containing a bracket, or naming neither a target
 * nor a fragment.
 */
export function parseWikilink(inner: string): Wikilink | null {
    if (!inner || /[[\]\n\r]/.test(inner)) return null
    // The alias separator: the first pipe, escaped or not (a table cell
    // escapes it; the escape is presentation, not part of the link).
    const pipe = inner.search(/\\?\|/)
    let head = inner
    let alias: string | null = null
    if (pipe >= 0) {
        const sepLen = inner[pipe] === '\\' ? 2 : 1
        head = inner.slice(0, pipe)
        alias = inner.slice(pipe + sepLen)
    }
    const hash = head.indexOf('#')
    const target = hash < 0 ? head : head.slice(0, hash)
    const fragment = hash < 0 ? null : head.slice(hash + 1)
    if (!target.trim() && fragment === null) return null
    return { target, fragment, alias }
}

/** A wikilink's source text. Inside a table cell the alias pipe is escaped. */
export function formatWikilink(link: Wikilink, options: { embed?: boolean; inTable?: boolean } = {}): string {
    let inner = link.target
    if (link.fragment !== null) inner += `#${link.fragment}`
    if (link.alias !== null) inner += `${options.inTable ? '\\|' : '|'}${link.alias}`
    return `${options.embed ? '!' : ''}[[${inner}]]`
}

/**
 * The longest `[[…]]` (or `![[…]]`) at `pos` in `src`, as markdown-it's inline
 * rules see it. Returns the parsed link and the offset just past `]]`, or null.
 */
export function matchWikilinkAt(src: string, pos: number): { link: Wikilink; embed: boolean; end: number } | null {
    let start = pos
    let embed = false
    if (src.charCodeAt(start) === 0x21 /* ! */) {
        embed = true
        start++
    }
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return null
    const close = src.indexOf(']]', start + 2)
    if (close < 0) return null
    const link = parseWikilink(src.slice(start + 2, close))
    if (!link) return null
    return { link, embed, end: close + 2 }
}

// ─── Scanning a note ─────────────────────────────────────────────────────────

export type LinkKind = 'wikilink' | 'embed' | 'markdown' | 'image' | 'definition'

/** One link found in a note's source. Offsets are into the whole text. */
export interface ScannedLink {
    kind: LinkKind
    /** The path part as written: a wikilink's target, or a Markdown link's
     *  destination before any `#` (still percent-encoded). */
    target: string
    fragment: string | null
    /** A wikilink's alias, or a Markdown link's text. */
    text: string | null
    /** 1-based line of the link. */
    line: number
    /** Offsets of `target` in the source, for rewriting it in place. */
    targetStart: number
    targetEnd: number
    /** Offsets of the whole link. */
    start: number
    end: number
    /** The destination was written in angle brackets (`[a](<my note.md>)`). */
    angled?: boolean
}

/** True for a Markdown destination that leaves the vault (a URL, a mail or
 *  phone link, a bare `#fragment` into the same note). */
export function isExternalTarget(target: string): boolean {
    return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#')
}

const FENCE = /^( {0,3})(`{3,}|~{3,})/

/**
 * Every link in a note: wikilinks and embeds, inline Markdown links and
 * images, and reference definitions (`[id]: path`). Fenced code, inline code
 * and backslash-escaped brackets are skipped; external destinations are
 * left out. Front matter is scanned for wikilinks only (Obsidian treats a
 * property value of `"[[Note]]"` as a link).
 */
export function scanLinks(text: string): ScannedLink[] {
    const out: ScannedLink[] = []
    const lines = text.split('\n')
    let offset = 0
    let fence: { char: string; len: number } | null = null
    let inFrontMatter = lines[0]?.replace(/\r$/, '') === '---'
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        const line = raw.replace(/\r$/, '')
        const lineStart = offset
        offset += raw.length + 1
        if (inFrontMatter) {
            if (i > 0 && (line === '---' || line === '...')) {
                inFrontMatter = false
                continue
            }
            if (i > 0) scanWikilinks(line, lineStart, i + 1, out)
            continue
        }
        const fenceMatch = FENCE.exec(line)
        if (fence) {
            if (fenceMatch && fenceMatch[2][0] === fence.char && fenceMatch[2].length >= fence.len && !line.slice(fenceMatch[0].length).trim()) {
                fence = null
            }
            continue
        }
        if (fenceMatch) {
            fence = { char: fenceMatch[2][0], len: fenceMatch[2].length }
            continue
        }
        const masked = maskCode(line)
        scanWikilinks(masked, lineStart, i + 1, out)
        scanMarkdownLinks(masked, line, lineStart, i + 1, out)
    }
    return out.sort((a, b) => a.start - b.start)
}

/** `line` with inline code spans and backslash escapes blanked out (same
 *  length, so offsets still line up with the source). */
function maskCode(line: string): string {
    let out = ''
    let i = 0
    while (i < line.length) {
        const c = line[i]
        if (c === '\\' && i + 1 < line.length) {
            out += '  '
            i += 2
            continue
        }
        if (c === '`') {
            let run = 1
            while (line[i + run] === '`') run++
            const closer = line.indexOf('`'.repeat(run), i + run)
            // A run with no matching closer is literal backticks.
            if (closer < 0 || line[closer + run] === '`') {
                out += line.slice(i, i + run)
                i += run
                continue
            }
            out += ' '.repeat(closer + run - i)
            i = closer + run
            continue
        }
        out += c
        i++
    }
    return out
}

function scanWikilinks(masked: string, lineStart: number, lineNo: number, out: ScannedLink[]) {
    let from = 0
    for (;;) {
        const open = masked.indexOf('[[', from)
        if (open < 0) return
        const embed = open > 0 && masked[open - 1] === '!'
        const at = embed ? open - 1 : open
        const m = matchWikilinkAt(masked, at)
        if (!m) {
            from = open + 2
            continue
        }
        out.push({
            kind: embed ? 'embed' : 'wikilink',
            target: m.link.target,
            fragment: m.link.fragment,
            text: m.link.alias,
            line: lineNo,
            targetStart: lineStart + open + 2,
            targetEnd: lineStart + open + 2 + m.link.target.length,
            start: lineStart + at,
            end: lineStart + m.end,
        })
        from = m.end
    }
}

function scanMarkdownLinks(masked: string, line: string, lineStart: number, lineNo: number, out: ScannedLink[]) {
    // A reference definition: `[id]: destination "title"` at the start of a line.
    const def = /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>\n]*>|\S+)/.exec(masked)
    if (def && !def[1].startsWith('^')) {
        const dest = def[2]
        const destStart = def.index + def[0].length - dest.length
        pushDestination('definition', def[1], dest, destStart, def.index, def[0].length, line, lineStart, lineNo, out)
        return
    }
    let from = 0
    for (;;) {
        const close = masked.indexOf('](', from)
        if (close < 0) return
        // Walk back to the `[` that opens this link's text, balancing brackets.
        let depth = 0
        let open = -1
        for (let j = close - 1; j >= 0; j--) {
            if (masked[j] === ']') depth++
            else if (masked[j] === '[') {
                if (depth === 0) {
                    open = j
                    break
                }
                depth--
            }
        }
        if (open < 0 || masked[open + 1] === '[') {
            from = close + 2
            continue
        }
        const destFrom = close + 2
        const rest = masked.slice(destFrom)
        const destMatch = /^[ \t]*(<[^>\n]*>|[^\s)]+)?/.exec(rest)!
        const dest = destMatch[1]
        const endParen = masked.indexOf(')', destFrom + destMatch[0].length)
        if (!dest || endParen < 0) {
            from = destFrom
            continue
        }
        const image = open > 0 && masked[open - 1] === '!'
        const destStart = destFrom + destMatch[0].length - dest.length
        pushDestination(
            image ? 'image' : 'markdown',
            line.slice(open + 1, close),
            dest,
            destStart,
            image ? open - 1 : open,
            endParen + 1 - (image ? open - 1 : open),
            line,
            lineStart,
            lineNo,
            out,
        )
        from = endParen + 1
    }
}

function pushDestination(
    kind: LinkKind,
    text: string,
    dest: string,
    destStart: number,
    start: number,
    length: number,
    line: string,
    lineStart: number,
    lineNo: number,
    out: ScannedLink[],
) {
    const angled = dest.startsWith('<')
    const inner = angled ? dest.slice(1, -1) : dest
    const innerStart = destStart + (angled ? 1 : 0)
    // Read the destination from the source line (the masked copy blanks escapes).
    const written = line.slice(innerStart, innerStart + inner.length)
    const hash = written.indexOf('#')
    const target = hash < 0 ? written : written.slice(0, hash)
    if (!target || isExternalTarget(written)) return
    out.push({
        kind,
        target,
        fragment: hash < 0 ? null : written.slice(hash + 1),
        text,
        line: lineNo,
        targetStart: lineStart + innerStart,
        targetEnd: lineStart + innerStart + target.length,
        start: lineStart + start,
        end: lineStart + start + length,
        angled,
    })
}

/**
 * `text` with some links' targets replaced. `replace` returns the new target
 * as it should be written (already relative and, for Markdown links, already
 * encoded), or null to leave a link alone. Everything else is kept byte for
 * byte. Returns the new text and how many links changed.
 */
export function rewriteLinks(
    text: string,
    replace: (link: ScannedLink) => string | null,
): { text: string; count: number } {
    let out = ''
    let last = 0
    let count = 0
    for (const link of scanLinks(text)) {
        const next = replace(link)
        if (next === null || next === link.target) continue
        out += text.slice(last, link.targetStart) + next
        last = link.targetEnd
        count++
    }
    return { text: out + text.slice(last), count }
}

/** Percent-decode a Markdown destination; malformed escapes are kept as is. */
export function decodeDestination(target: string): string {
    try {
        return decodeURI(target)
    } catch {
        return target
    }
}

/** Encode a vault path as a Markdown destination: spaces and parentheses
 *  escaped so the link survives without angle brackets. */
export function encodeDestination(path: string): string {
    return path.replace(/[ ()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}
