/**
 * Text fragments (`#:~:text=[prefix-,]start[,end][,-suffix]`, the form a
 * browser's "copy link to highlight" produces): what a comment's anchor and
 * a link to a passage are (comments RFC §1.2, §2).
 *
 * Everything here works on a note's text as a reader sees it, flattened to
 * one string (the editor joins its blocks with newlines); positions are
 * offsets into that string. Finding is exact first, then without regard to
 * case, then approximate, so a quote survives a small edit made elsewhere.
 */

export interface TextFragment {
    /** Text just before the passage (whitespace between), or ''. */
    prefix: string
    /** The passage, or its beginning when `end` is given. */
    start: string
    /** The passage's last words, for a long passage; null for a quote. */
    end: string | null
    /** Text just after the passage, or ''. */
    suffix: string
}

export interface TextMatch {
    from: number
    to: number
    /** Found as written (or differing only in case); false when approximate. */
    exact: boolean
}

const decode = (s: string) => {
    try {
        return decodeURIComponent(s)
    } catch {
        return s
    }
}

/** A part as the directive writes it: percent-encoded, with the characters
 *  that separate parts (`-`, `,`, `&`) encoded too. */
const encode = (s: string) => encodeURIComponent(s).replace(/-/g, '%2D')

/** `:~:text=…` (or the directive after `text=`) as its parts; the first
 *  directive when several are joined by `&`. Null when there is no text. */
export function parseTextFragment(fragment: string): TextFragment | null {
    const directive = fragment.startsWith(':~:text=') ? fragment.slice(':~:text='.length) : fragment
    const parts = directive.split('&')[0].split(',')
    let prefix = ''
    let suffix = ''
    if (parts.length > 1 && parts[0].endsWith('-')) prefix = decode(parts.shift()!.slice(0, -1))
    if (parts.length > 1 && parts[parts.length - 1].startsWith('-')) suffix = decode(parts.pop()!.slice(1))
    const start = decode(parts[0] ?? '')
    if (!start) return null
    return { prefix, start, end: parts[1] !== undefined ? decode(parts[1]) : null, suffix }
}

/** The fragment as a link writes it, `:~:text=…`. */
export function formatTextFragment(f: TextFragment): string {
    const parts = [encode(f.start)]
    if (f.end !== null) parts.push(encode(f.end))
    if (f.prefix) parts.unshift(`${encode(f.prefix)}-`)
    if (f.suffix) parts.push(`-${encode(f.suffix)}`)
    return `:~:text=${parts.join(',')}`
}

/** `text` lower-cased character by character, so offsets stay the same. */
function fold(text: string): string {
    let out = ''
    for (const c of text) {
        const lower = c.toLowerCase()
        out += lower.length === c.length ? lower : c
    }
    return out
}

function contextFits(text: string, from: number, to: number, f: TextFragment, fuzzy: boolean): boolean {
    const before = text.slice(Math.max(0, from - f.prefix.length - 40), from).trimEnd()
    const after = text.slice(to, to + f.suffix.length + 40).trimStart()
    if (!fuzzy) return (!f.prefix || before.endsWith(f.prefix)) && (!f.suffix || after.startsWith(f.suffix))
    const near = (a: string, b: string) => !b || distance(a, b) <= Math.floor(b.length / 4)
    return near(before.slice(-f.prefix.length), f.prefix) && near(after.slice(0, f.suffix.length), f.suffix)
}

/** Every place the fragment matches exactly in `text` (in `folded` form
 *  when case is ignored). */
function exactMatches(text: string, f: TextFragment, ignoreCase: boolean): TextMatch[] {
    const hay = ignoreCase ? fold(text) : text
    const g = ignoreCase ? { ...f, prefix: fold(f.prefix), start: fold(f.start), end: f.end === null ? null : fold(f.end), suffix: fold(f.suffix) } : f
    const out: TextMatch[] = []
    for (let at = hay.indexOf(g.start); at >= 0; at = hay.indexOf(g.start, at + 1)) {
        let to = at + g.start.length
        if (g.end !== null) {
            const e = hay.indexOf(g.end, to)
            if (e < 0) break
            to = e + g.end.length
        }
        if (contextFits(hay, at, to, g, false)) out.push({ from: at, to, exact: true })
    }
    return out
}

/** Levenshtein distance. */
function distance(a: string, b: string): number {
    if (a === b) return 0
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
        const row = [i]
        for (let j = 1; j <= b.length; j++) {
            row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
        }
        prev = row
    }
    return prev[b.length]
}

/**
 * The places in `text` nearest `pattern` (Sellers' algorithm: edit distance
 * with the match free to start anywhere), at most `limit` edits away, each
 * reported once at its best end. From `offset` on.
 */
function approximate(text: string, pattern: string, limit: number, offset = 0): { from: number; to: number; cost: number }[] {
    const m = pattern.length
    // Column j: cost[i] = edits to match pattern[0..i) ending at text[j-1];
    // begin[i] = where that match begins.
    let cost = Array.from({ length: m + 1 }, (_, i) => i)
    let begin = new Array<number>(m + 1).fill(offset)
    const found: { from: number; to: number; cost: number }[] = []
    for (let j = offset; j < text.length; j++) {
        const nextCost = [0]
        const nextBegin = [j + 1]
        for (let i = 1; i <= m; i++) {
            const sub = cost[i - 1] + (pattern[i - 1] === text[j] ? 0 : 1)
            const del = cost[i] + 1
            const ins = nextCost[i - 1] + 1
            if (sub <= del && sub <= ins) {
                nextCost[i] = sub
                nextBegin[i] = i === 1 ? j : begin[i - 1]
            } else if (del <= ins) {
                nextCost[i] = del
                nextBegin[i] = begin[i]
            } else {
                nextCost[i] = ins
                nextBegin[i] = nextBegin[i - 1]
            }
        }
        cost = nextCost
        begin = nextBegin
        if (cost[m] <= limit) {
            const last = found[found.length - 1]
            const match = { from: begin[m], to: j + 1, cost: cost[m] }
            // Overlapping ends of one match: keep the cheapest.
            if (last && match.from < last.to) {
                if (match.cost < last.cost) found[found.length - 1] = match
            } else found.push(match)
        }
    }
    return found
}

/**
 * Where the fragment is in `text`: as written, else without regard to case,
 * else approximately (the passage at most a quarter of its length in edits
 * away, its context agreeing as nearly). Several places: the one nearest
 * offset `near` when given, else the first.
 */
export function findTextFragment(text: string, f: TextFragment, near?: number): TextMatch | null {
    const pick = (matches: TextMatch[]) =>
        matches.length === 0 ? null : near === undefined ? matches[0] : matches.reduce((a, b) => (Math.abs(b.from - near) < Math.abs(a.from - near) ? b : a))
    const exact = pick(exactMatches(text, f, false)) ?? pick(exactMatches(text, f, true))
    if (exact) return exact
    const hay = fold(text)
    const start = fold(f.start)
    const end = f.end === null ? null : fold(f.end)
    // Every place the end nearly matches, found once for all the starts.
    const ends = end === null ? null : approximate(hay, end, Math.floor(end.length / 4))
    const candidates: (TextMatch & { cost: number })[] = []
    // (A start found in many places is a poor anchor anyway: the first few
    // dozen are enough to choose from.)
    for (const s of approximate(hay, start, Math.floor(start.length / 4)).slice(0, 50)) {
        let to = s.to
        let cost = s.cost
        if (ends) {
            // After the start, the nearest of the ends that match best.
            let e: (typeof ends)[number] | undefined
            for (const m of ends) if (m.from >= s.to && (!e || m.cost < e.cost)) e = m
            if (!e) continue
            to = e.to
            cost += e.cost
        }
        if (contextFits(hay, s.from, to, { ...f, prefix: fold(f.prefix), suffix: fold(f.suffix) }, true)) {
            candidates.push({ from: s.from, to, exact: false, cost })
        }
    }
    if (!candidates.length) return null
    const best = Math.min(...candidates.map((c) => c.cost))
    const { from, to } = pick(candidates.filter((c) => c.cost === best))!
    return { from, to, exact: false }
}

/** How many places the fragment matches exactly. */
function count(text: string, f: TextFragment): number {
    return exactMatches(text, f, false).length
}

const QUOTE_MAX = 60
const EDGE_WORDS = 4
const CONTEXT_WORDS = 6

/**
 * A text fragment for the passage `text[from, to)` that matches there and
 * nowhere else: the passage itself when short, else its first and last few
 * words, with as much context before and after as it takes to be unique.
 * Null when no context makes it unique (the passage and its surroundings
 * repeat word for word): pin it instead. Whitespace at the passage's ends is
 * left out.
 */
export function textFragmentFor(text: string, from: number, to: number): TextFragment | null {
    while (from < to && /\s/.test(text[from])) from++
    while (to > from && /\s/.test(text[to - 1])) to--
    if (from >= to) return null
    const passage = text.slice(from, to)
    let start = passage
    let end: string | null = null
    if (passage.length > QUOTE_MAX) {
        const words = passage.split(/(\s+)/)
        // Whole words from each end, up to EDGE_WORDS of them.
        start = words.slice(0, EDGE_WORDS * 2 - 1).join('')
        end = words.slice(-(EDGE_WORDS * 2 - 1)).join('')
        if (start.length + end.length >= passage.length) {
            start = passage
            end = null
        }
    }
    // Trimmed first, so the words nearest the passage come first (a split
    // of text ending in whitespace ends with an empty string).
    const before = text.slice(0, from).trimEnd().split(/(\s+)/)
    const after = text.slice(to).trimStart().split(/(\s+)/)
    for (let n = 0; n <= CONTEXT_WORDS; n++) {
        for (const [p, s] of n === 0 ? [[0, 0]] : [[n, n - 1], [n, n]]) {
            const f: TextFragment = {
                prefix: p ? before.slice(-(p * 2)).join('').trim() : '',
                start,
                end,
                suffix: s ? after.slice(0, s * 2).join('').trim() : '',
            }
            if (count(text, f) === 1) {
                const at = exactMatches(text, f, false)[0]
                if (at.from === from && at.to === to) return f
            }
        }
    }
    return null
}
