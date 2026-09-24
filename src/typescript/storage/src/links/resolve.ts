/**
 * What a link points at. Two rule sets, because the two syntaxes mean
 * different things:
 *
 * - A **Markdown link** (`[a](../plan.md)`) is a path, relative to the note
 *   it is in (or to the vault root when it starts with `/`), percent-encoded.
 *   A missing `.md` is tolerated when the note exists with it.
 * - A **wikilink** (`[[plan]]`) is a name, resolved the way Obsidian does so
 *   an existing vault keeps working: first as a path beside the note, then
 *   from the vault root, then as the tail of any path in the vault
 *   (`[[plan]]` finds `projects/2026/plan.md`). A name without an extension
 *   means a note (`.md`). When several files match, the closest to the
 *   linking note wins, then the shortest path.
 *
 * An unresolved wikilink still has a path: the note it would create, beside
 * the linking note.
 */
import { basename, dirname, extname, joinPath, normalizePath, relativePath } from '../path'
import { decodeDestination, encodeDestination } from './syntax'
import type { LinkResolution } from './types'

/** Extensions a wikilink may name as they are; anything else names a note
 *  and gets `.md`. (Obsidian's rule: `[[v1.2]]` is the note `v1.2.md`.) */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set([
    'md', 'markdown', 'mdx', 'txt', 'canvas', 'pdf',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico',
    'mp3', 'wav', 'ogg', 'm4a', 'flac', 'mp4', 'webm', 'mov', 'mkv',
])

/** The set of files in a vault, with the lookups resolution needs. */
export class Catalog {
    private paths = new Set<string>()
    /** Lower-cased basename → paths with that basename. */
    private names = new Map<string, Set<string>>()

    constructor(paths: Iterable<string> = []) {
        for (const p of paths) this.add(p)
    }

    get size(): number {
        return this.paths.size
    }

    has(path: string): boolean {
        return this.paths.has(path)
    }

    all(): IterableIterator<string> {
        return this.paths.values()
    }

    add(path: string): boolean {
        const clean = normalizePath(path)
        if (!clean || this.paths.has(clean)) return false
        this.paths.add(clean)
        const key = basename(clean).toLowerCase()
        let set = this.names.get(key)
        if (!set) this.names.set(key, (set = new Set()))
        set.add(clean)
        return true
    }

    remove(path: string): boolean {
        const clean = normalizePath(path)
        if (!this.paths.delete(clean)) return false
        const key = basename(clean).toLowerCase()
        const set = this.names.get(key)
        set?.delete(clean)
        if (set && set.size === 0) this.names.delete(key)
        return true
    }

    /** Paths whose last segments equal `tail`'s, ignoring case. */
    bySuffix(tail: string): string[] {
        const want = normalizePath(tail).toLowerCase().split('/')
        const candidates = this.names.get(want[want.length - 1])
        if (!candidates) return []
        return [...candidates].filter((p) => {
            const segs = p.toLowerCase().split('/')
            if (segs.length < want.length) return false
            return want.every((seg, i) => segs[segs.length - want.length + i] === seg)
        })
    }
}

/** The names a wikilink target may mean, most likely first. */
function nameVariants(target: string): string[] {
    const ext = extname(target)
    if (ext === 'md') return [target]
    return FILE_EXTENSIONS.has(ext) ? [target, `${target}.md`] : [`${target}.md`, target]
}

function commonDirDepth(a: string, b: string): number {
    const as = a ? a.split('/') : []
    const bs = b ? b.split('/') : []
    let i = 0
    while (i < as.length && i < bs.length && as[i] === bs[i]) i++
    return i
}

/** The best of several paths a name matched, for a link in directory `fromDir`. */
function closest(matches: string[], written: string, fromDir: string): string {
    const tail = normalizePath(written).split('/')
    const exactCase = (p: string) => p.split('/').slice(-tail.length).join('/') === tail.join('/')
    return [...matches].sort((a, b) =>
        Number(exactCase(b)) - Number(exactCase(a))
        || commonDirDepth(dirname(b), fromDir) - commonDirDepth(dirname(a), fromDir)
        || a.split('/').length - b.split('/').length
        || a.length - b.length
        || (a < b ? -1 : a > b ? 1 : 0),
    )[0]
}

/** The vault path a wikilink target names from the note `from`, or null when
 *  no file matches. An empty target (`[[#heading]]`) is the note itself. */
export function resolveWikilink(target: string, from: string | null, files: Catalog): string | null {
    const written = target.trim()
    if (!written) return from ? normalizePath(from) : null
    const fromDir = from ? dirname(from) : ''
    const variants = nameVariants(written)
    for (const name of variants) {
        const beside = joinPath(fromDir, name)
        if (files.has(beside)) return beside
        const rooted = normalizePath(name)
        if (files.has(rooted)) return rooted
    }
    for (const name of variants) {
        const matches = files.bySuffix(name)
        if (matches.length) return closest(matches, name, fromDir)
    }
    return null
}

/** Where an unresolved wikilink's note would be created: beside the note
 *  that links to it. */
export function newNotePath(target: string, from: string | null): string {
    return joinPath(from ? dirname(from) : '', nameVariants(target.trim())[0])
}

/** A Markdown destination's vault path from the note `from`. */
export function resolveMarkdownLink(target: string, from: string | null, files: Catalog): LinkResolution | null {
    const decoded = decodeDestination(target)
    if (!decoded.trim()) return null
    const path = joinPath(decoded.startsWith('/') || !from ? '' : dirname(from), decoded)
    if (!path) return null
    if (files.has(path)) return { path, exists: true }
    if (!extname(path) && files.has(`${path}.md`)) return { path: `${path}.md`, exists: true }
    return { path, exists: false }
}

/** Either rule set, with unresolved wikilinks given their creation path. */
export function resolveLink(
    target: string,
    from: string | null,
    syntax: 'wikilink' | 'markdown',
    files: Catalog,
): LinkResolution | null {
    if (syntax === 'markdown') return resolveMarkdownLink(target, from, files)
    const found = resolveWikilink(target, from, files)
    if (found) return { path: found, exists: true }
    if (!target.trim()) return null
    return { path: newNotePath(target, from), exists: false }
}

/**
 * The shortest wikilink text that resolves to `path` from the note `from`:
 * the bare name when it is unambiguous (`plan`), else as many trailing
 * directories as it takes (`2026/plan`). Notes drop their `.md`. With
 * `minSegments`, no shorter than that (a rewrite keeps a link as qualified
 * as its author wrote it).
 */
export function wikilinkTextFor(path: string, from: string | null, files: Catalog, minSegments = 1): string {
    const clean = normalizePath(path)
    const base = extname(clean) === 'md' ? clean.slice(0, -3) : clean
    const segs = base.split('/')
    for (let k = Math.min(Math.max(minSegments, 1), segs.length); k <= segs.length; k++) {
        const candidate = segs.slice(-k).join('/')
        if (resolveWikilink(candidate, from, files) === clean) return candidate
    }
    return base
}

/**
 * The Markdown destination for `path` from the note `from`, written the way
 * `like` was: without `.md` if it had none, raw inside angle brackets,
 * percent-encoded otherwise.
 */
export function markdownDestinationFor(path: string, from: string | null, like?: { target: string; angled?: boolean }): string {
    let rel = relativePath(from ? dirname(from) : '', path)
    if (like && !extname(decodeDestination(like.target)) && extname(rel) === 'md') rel = rel.slice(0, -3)
    return like?.angled ? rel : encodeDestination(rel)
}
