/**
 * The links between a vault's files, held in memory: which files exist, and
 * every link in every note as written. Resolution happens on demand against
 * the current set of files, so creating a note resolves links to it without
 * re-reading anything, and there is no stored answer to go stale.
 */
import { basename, extname, isNote, normalizePath } from '../path'
import { scanLinks, type ScannedLink } from './syntax'
import { Catalog, resolveLink, wikilinkTextFor } from './resolve'
import type { LinkRef, LinkResolution, LinkSuggestion } from './types'

/** The syntax whose rules a scanned link resolves by. */
export function syntaxOf(link: ScannedLink): 'wikilink' | 'markdown' {
    return link.kind === 'wikilink' || link.kind === 'embed' ? 'wikilink' : 'markdown'
}

export class LinkGraph {
    readonly files = new Catalog()
    private notes = new Map<string, ScannedLink[]>()

    /** Record that `path` exists (a note is also parsed with `setNote`). */
    addFile(path: string): void {
        this.files.add(path)
    }

    /** Record a note's current text. */
    setNote(path: string, text: string): void {
        const clean = normalizePath(path)
        this.files.add(clean)
        this.notes.set(clean, scanLinks(text))
    }

    /** Forget a file (and, for a note, its links). */
    removeFile(path: string): void {
        const clean = normalizePath(path)
        this.files.remove(clean)
        this.notes.delete(clean)
    }

    /** Move a file's record without touching its links' text. */
    moveFile(oldPath: string, newPath: string): void {
        const from = normalizePath(oldPath)
        const to = normalizePath(newPath)
        const links = this.notes.get(from)
        this.removeFile(from)
        this.files.add(to)
        if (links && isNote(to)) this.notes.set(to, links)
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

    /** Every link into `note`, in vault order. */
    backlinks(note: string): LinkRef[] {
        const target = normalizePath(note)
        const out: LinkRef[] = []
        for (const [source, links] of this.notes) {
            for (const link of links) {
                if (!link.target.trim()) continue // a link within the source itself
                if (this.resolve(link, source)?.path === target) out.push({ source, target, line: link.line })
            }
        }
        return out.sort(byLocation)
    }

    /** Every link whose target does not exist. */
    unresolved(): LinkRef[] {
        const out: LinkRef[] = []
        for (const [source, links] of this.notes) {
            for (const link of links) {
                const r = this.resolve(link, source)
                if (r && !r.exists) out.push({ source, target: r.path, line: link.line })
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
}

function byLocation(a: LinkRef, b: LinkRef): number {
    return a.source < b.source ? -1 : a.source > b.source ? 1 : a.line - b.line
}

function subsequence(needle: string, hay: string): boolean {
    let i = 0
    for (const c of hay) if (c === needle[i] && ++i === needle.length) return true
    return needle.length === 0
}
