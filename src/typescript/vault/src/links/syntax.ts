/**
 * The link grammar of a note, in one place: the editor's Markdown parser and
 * the vault's link index both use it, so what the editor renders as a link is
 * exactly what the index counts. Block structure (which lines are code,
 * where front matter ends) is `parse.ts`'s; this file reads one line.
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

/**
 * The links on one line of a note, appended to `out`: wikilinks and embeds,
 * inline Markdown links and images, and a reference definition
 * (`[id]: path`). Links are found in a masked copy of the line (inline code
 * and escaped brackets blanked, so they are not mistaken for links) and
 * read from the source line (so an escape inside one, `[[plan\|alias]]` in
 * a table or `\(` in a destination, means what it does to the editor's
 * parser); the two have the same length. In front matter
 * (`wikilinksOnly`) nothing is masked and only wikilinks are read.
 */
export function scanLine(line: string, lineStart: number, lineNo: number, out: ScannedLink[], options: { wikilinksOnly?: boolean } = {}): void {
    if (options.wikilinksOnly) return scanWikilinks(line, line, lineStart, lineNo, out)
    const masked = maskCode(line)
    scanWikilinks(masked, line, lineStart, lineNo, out)
    scanMarkdownLinks(masked, line, lineStart, lineNo, out)
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

function scanWikilinks(masked: string, line: string, lineStart: number, lineNo: number, out: ScannedLink[]) {
    let from = 0
    for (;;) {
        const open = masked.indexOf('[[', from)
        if (open < 0) return
        const embed = open > 0 && masked[open - 1] === '!'
        const at = embed ? open - 1 : open
        const m = matchWikilinkAt(line, at)
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

const PUNCTUATION = /[!-/:-@[-`{-~]/

/**
 * A link destination and what follows it up to the closing `)`, read from
 * `line` at `from` as CommonMark does: `<…>`, or a run without spaces in
 * which parentheses balance and `\(`, `\)` are escapes; then an optional
 * title in quotes or parentheses. Null when there is no such destination.
 */
function readDestination(line: string, from: number): { start: number; end: number; close: number } | null {
    let i = from
    while (line[i] === ' ' || line[i] === '\t') i++
    const start = i
    if (line[i] === '<') {
        i++
        while (i < line.length && line[i] !== '>') {
            if (line[i] === '<') return null
            i += line[i] === '\\' && i + 1 < line.length ? 2 : 1
        }
        if (i >= line.length) return null
        i++
    } else {
        let depth = 0
        while (i < line.length) {
            const c = line[i]
            if (c === '\\' && PUNCTUATION.test(line[i + 1] ?? '')) {
                i += 2
                continue
            }
            if (c <= ' ') break
            if (c === '(') depth++
            else if (c === ')') {
                if (depth === 0) break
                depth--
            }
            i++
        }
        if (i === start || depth > 0) return null
    }
    const end = i
    while (line[i] === ' ' || line[i] === '\t') i++
    const quote = line[i]
    if (i > end && (quote === '"' || quote === "'" || quote === '(')) {
        const closer = quote === '(' ? ')' : quote
        i++
        while (i < line.length && line[i] !== closer) i += line[i] === '\\' ? 2 : 1
        if (i >= line.length) return null
        i++
        while (line[i] === ' ' || line[i] === '\t') i++
    }
    return line[i] === ')' ? { start, end, close: i } : null
}

function scanMarkdownLinks(masked: string, line: string, lineStart: number, lineNo: number, out: ScannedLink[]) {
    // A reference definition: `[id]: destination "title"` at the start of a line.
    const def = /^ {0,3}\[([^\]]+)\]:[ \t]*/.exec(masked)
    if (def && !def[1].startsWith('^')) {
        const destStart = def[0].length
        const angled = line[destStart] === '<'
        let destEnd = destStart
        if (angled) destEnd = line.indexOf('>', destStart) + 1
        else while (destEnd < line.length && line[destEnd] > ' ') destEnd++
        if (destEnd > destStart) {
            pushDestination('definition', def[1], destStart, destEnd, def.index, line.length, line, lineStart, lineNo, out)
        }
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
        const dest = readDestination(line, close + 2)
        if (!dest) {
            from = close + 2
            continue
        }
        const image = open > 0 && masked[open - 1] === '!'
        const start = image ? open - 1 : open
        pushDestination(image ? 'image' : 'markdown', line.slice(open + 1, close), dest.start, dest.end, start, dest.close + 1, line, lineStart, lineNo, out)
        from = dest.close + 1
    }
}

/** Record the link whose destination is `line[destStart, destEnd)` (angle
 *  brackets included), unless it leaves the vault. */
function pushDestination(
    kind: LinkKind,
    text: string,
    destStart: number,
    destEnd: number,
    start: number,
    end: number,
    line: string,
    lineStart: number,
    lineNo: number,
    out: ScannedLink[],
) {
    const angled = line[destStart] === '<'
    const innerStart = destStart + (angled ? 1 : 0)
    const written = line.slice(innerStart, destEnd - (angled ? 1 : 0))
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
        end: lineStart + end,
        angled,
    })
}

/** A Markdown destination as the path it names: backslash escapes of
 *  punctuation undone, then percent-decoded (a malformed `%` is kept). */
export function decodeDestination(target: string): string {
    const unescaped = target.replace(/\\([!-/:-@[-`{-~])/g, '$1')
    try {
        return decodeURI(unescaped)
    } catch {
        return unescaped
    }
}

/** Encode a vault path as a Markdown destination: spaces and parentheses
 *  escaped so the link survives without angle brackets. */
export function encodeDestination(path: string): string {
    return path.replace(/[ ()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}
