/**
 * The links between a vault's files, held in memory: which files exist,
 * every link in every note as written, and what each resolves to.
 *
 * Resolution is kept, not recomputed: a note's links are resolved when the
 * note is read, and resolved again only when a file appears or goes whose
 * name could change what they point at (a wikilink is a name, so a new
 * `plan.md` anywhere can capture `[[plan]]`; a Markdown link is a path, so
 * only that path matters). Backlinks are then a lookup, not a walk of the
 * vault, and the dangling links are a set kept as resolutions change.
 */
import { basename, extname, normalizePath } from '@joinezco/storage'
import { decodeDestination, type ScannedLink } from './syntax.js'
import { Catalog, resolveLink, wikilinkTextFor } from './resolve.js'
import type { LinkRef, LinkResolution, LinkSuggestion } from './types.js'
import { isNote } from '../note.js'

/** The syntax whose rules a scanned link resolves by. */
export function syntaxOf(link: ScannedLink): 'wikilink' | 'markdown' {
    return link.kind === 'wikilink' || link.kind === 'embed' ? 'wikilink' : 'markdown'
}

/** The name a file is matched by: its last segment, lower-cased, without
 *  `.md`. A link is keyed by the same rule on its target, so a file and the
 *  links its arrival or departure could re-resolve share a key. */
export function linkName(pathOrTarget: string): string {
    const name = basename(pathOrTarget).toLowerCase()
    return extname(name) === 'md' ? name.slice(0, -3) : name
}

function keyOf(link: ScannedLink): string {
    return linkName(syntaxOf(link) === 'wikilink' ? link.target : decodeDestination(link.target))
}

export class LinkGraph {
    readonly files = new Catalog()
    private notes = new Map<string, ScannedLink[]>()
    /** What each note's links resolve to, one entry per link (null for a
     *  link within the note itself, which no file can change). */
    private resolved = new Map<string, (string | null)[]>()
    /** The notes linking to each path, with the lines they do it on. */
    private incoming = new Map<string, Map<string, number[]>>()
    /** Paths linked to that no file has. */
    private dangling = new Set<string>()
    /** The notes holding a link a file of that name could re-resolve. */
    private byName = new Map<string, Set<string>>()

    /** Record that `path` exists (a note is also parsed with `setNote`). */
    addFile(path: string): void {
        const clean = normalizePath(path)
        if (this.files.add(clean)) this.fileChanged(clean)
    }

    /** Record a note's links, as scanned from its current text. */
    setNote(path: string, links: ScannedLink[]): void {
        const clean = normalizePath(path)
        const arrived = this.files.add(clean)
        this.unlink(clean)
        this.notes.set(clean, links)
        this.link(clean)
        if (arrived) this.fileChanged(clean)
    }

    /** Forget a file (and, for a note, its links). */
    removeFile(path: string): void {
        const clean = normalizePath(path)
        this.unlink(clean)
        this.notes.delete(clean)
        if (this.files.remove(clean)) this.fileChanged(clean)
    }

    /** Move a file's record without touching its links' text. */
    moveFile(oldPath: string, newPath: string): void {
        const from = normalizePath(oldPath)
        const to = normalizePath(newPath)
        const links = this.notes.get(from)
        this.removeFile(from)
        if (links && isNote(to)) this.setNote(to, links)
        else this.addFile(to)
    }

    /** The notes whose links are recorded. */
    noteList(): string[] {
        return [...this.notes.keys()]
    }

    /** The links recorded for `note`, as written. */
    linksOf(note: string): readonly ScannedLink[] {
        return this.notes.get(normalizePath(note)) ?? []
    }

    resolve(link: ScannedLink, from: string): LinkResolution | null {
        // `[[#heading]]` and `[a](#heading)` stay in the note (the latter is
        // already dropped by the scanner as not a file link).
        return resolveLink(link.target, from, syntaxOf(link), this.files)
    }

    /** The notes with a link into `path`. */
    sources(path: string): string[] {
        return [...(this.incoming.get(normalizePath(path))?.keys() ?? [])]
    }

    /** Every link into `note`, in vault order. */
    backlinks(note: string): LinkRef[] {
        const target = normalizePath(note)
        const out: LinkRef[] = []
        for (const [source, lines] of this.incoming.get(target) ?? []) {
            for (const line of lines) out.push({ source, target, line })
        }
        return out.sort(byLocation)
    }

    /** Every link whose target does not exist. */
    unresolved(): LinkRef[] {
        const out: LinkRef[] = []
        for (const target of this.dangling) {
            for (const [source, lines] of this.incoming.get(target) ?? []) {
                for (const line of lines) out.push({ source, target, line })
            }
        }
        return out.sort(byLocation)
    }

    /**
     * Files to offer after `[[query`: notes before other files; names that
     * start with the query, then contain it, then paths that contain it,
     * then paths holding its characters in order; nearer to `from` first.
     */
    suggest(query: string, from: string | null, limit = 20): LinkSuggestion[] {
        const q = query.trim().toLowerCase()
        const scored: { path: string; rank: number; title: string }[] = []
        for (const path of this.files.all()) {
            if (path === from) continue
            const title = extname(path) === 'md' ? basename(path).slice(0, -3) : basename(path)
            const name = title.toLowerCase()
            const lower = path.toLowerCase()
            let rank: number
            if (!q) rank = 0
            else if (name.startsWith(q)) rank = 0
            else if (name.includes(q)) rank = 1
            else if (lower.includes(q)) rank = 2
            else if (subsequence(q, lower)) rank = 3
            else continue
            scored.push({ path, rank: rank * 2 + (isNote(path) ? 0 : 1), title })
        }
        scored.sort((a, b) => a.rank - b.rank || a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : 1))
        return scored.slice(0, limit).map(({ path, title }) => ({ path, title, link: wikilinkTextFor(path, from, this.files) }))
    }

    // ── Keeping resolutions current ──────────────────────────────────────────

    /** Resolve `note`'s links and record where they lead. */
    private link(note: string): void {
        const links = this.notes.get(note) ?? []
        const resolved: (string | null)[] = []
        for (const link of links) {
            const target = link.target.trim() ? this.resolve(link, note)?.path ?? null : null
            resolved.push(target)
            if (target === null) continue
            let sources = this.incoming.get(target)
            if (!sources) this.incoming.set(target, (sources = new Map()))
            let lines = sources.get(note)
            if (!lines) sources.set(note, (lines = []))
            lines.push(link.line)
            if (!this.files.has(target)) this.dangling.add(target)
            const key = keyOf(link)
            let holders = this.byName.get(key)
            if (!holders) this.byName.set(key, (holders = new Set()))
            holders.add(note)
        }
        this.resolved.set(note, resolved)
    }

    /** Take back what `link` recorded for `note`. */
    private unlink(note: string): void {
        const resolved = this.resolved.get(note)
        if (!resolved) return
        for (const target of resolved) {
            if (target === null) continue
            const sources = this.incoming.get(target)
            if (!sources?.delete(note) || sources.size) continue
            this.incoming.delete(target)
            this.dangling.delete(target)
        }
        for (const link of this.notes.get(note) ?? []) {
            const key = keyOf(link)
            const holders = this.byName.get(key)
            if (holders?.delete(note) && holders.size === 0) this.byName.delete(key)
        }
        this.resolved.delete(note)
    }

    /** A file appeared or went: links its name could change resolve again. */
    private fileChanged(path: string): void {
        if (this.files.has(path)) this.dangling.delete(path)
        else if (this.incoming.has(path)) this.dangling.add(path)
        const holders = this.byName.get(linkName(path))
        if (!holders) return
        for (const note of [...holders]) {
            this.unlink(note)
            this.link(note)
        }
    }
}

function byLocation(a: LinkRef, b: LinkRef): number {
    return a.source < b.source ? -1 : a.source > b.source ? 1 : a.line - b.line
}

function subsequence(needle: string, hay: string): boolean {
    let i = 0
    for (const c of hay) if (c === needle[i] && ++i === needle.length) return true
    return needle.length === 0
}
