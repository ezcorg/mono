/**
 * Search over a vault: every file by its path and name, and every note by
 * its title, headings and text. The index holds tokens, not text: the
 * snippet shown with a hit is read from the file when the hit is asked for,
 * so memory stays proportional to the vocabulary, not the vault.
 *
 * It is a derived, per-device index (RFC §2.2): rebuilt from the files, never
 * synced. MiniSearch serves up to the low tens of thousands of notes; past
 * that the same interface can be served by SQLite FTS5 or the daemon.
 */
import MiniSearch from 'minisearch'
import { basename, extname, isNote, normalizePath } from './path'
import { frontMatterOf } from './id'

export interface SearchHit {
    /** The file's vault path. */
    path: string
    score: number
    /** Whether the query matched the file's path and name, or a note's text. */
    match: 'path' | 'content'
    /** A note's title (its first heading, else its name). */
    title?: string
    /** For a content match: the text around the first place it matched. */
    snippet?: string
    /** For a content match: the 1-based line of that place. */
    line?: number
}

export interface SearchOptions {
    /** At most this many hits (default 50). */
    limit?: number
    /** Search notes' text as well as paths (default true). */
    content?: boolean
}

/** Search over a vault. Asynchronous, so an index held elsewhere (a daemon,
 *  a peer) can serve it. */
export interface FileSearch {
    search(query: string, options?: SearchOptions): Promise<SearchHit[]>
}

interface Doc {
    id: string
    path: string
    name: string
    title: string
    headings: string
    text: string
}

const PATH_FIELDS = ['path', 'name']

/** A note's title: `title:` in its front matter, else its first heading, else its name. */
export function titleOf(path: string, text: string): string {
    const yaml = frontMatterOf(text)
    const fm = yaml && /^title[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(yaml)?.[1]?.replace(/^(['"])(.*)\1$/, '$2')
    if (fm) return fm
    const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1]
    if (heading) return heading
    const name = basename(path)
    return extname(name) === 'md' ? name.slice(0, -3) : name
}

function docFor(path: string, text: string | null): Doc {
    const name = basename(path)
    if (text === null) return { id: path, path, name, title: '', headings: '', text: '' }
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '')
    const headings = [...body.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)].map((m) => m[1]).join('\n')
    return { id: path, path, name, title: titleOf(path, text), headings, text: body }
}

export class SearchIndex {
    private index = SearchIndex.create()

    private static create() {
        return new MiniSearch<Doc>({
            fields: ['path', 'name', 'title', 'headings', 'text'],
            storeFields: ['path', 'title'],
            // A path is words too: `projects/2026/plan.md` → projects, 2026, plan, md.
            tokenize: (text) => text.split(/[\s\-_./\\:#[\](){}"'`*~|,;!?<>=+]+/u).filter(Boolean),
            searchOptions: {
                boost: { name: 3, title: 3, path: 1.5, headings: 2 },
                prefix: true,
                fuzzy: (term) => (term.length > 4 ? 0.2 : false),
                combineWith: 'AND',
            },
        })
    }

    /** Index a file; pass a note's text, or null for any other file. */
    set(path: string, text: string | null): void {
        const clean = normalizePath(path)
        const doc = docFor(clean, isNote(clean) ? text : null)
        if (this.index.has(clean)) this.index.replace(doc)
        else this.index.add(doc)
    }

    remove(path: string): void {
        const clean = normalizePath(path)
        if (this.index.has(clean)) this.index.discard(clean)
    }

    clear(): void {
        this.index = SearchIndex.create()
    }

    /**
     * Files matching `query`, best first. `read` supplies a note's text for
     * the snippet of a content hit (the index keeps no text).
     */
    async search(query: string, options: SearchOptions & { read?: (path: string) => Promise<string> } = {}): Promise<SearchHit[]> {
        const q = query.trim()
        if (!q) return []
        const limit = options.limit ?? 50
        const results = this.index.search(q, options.content === false ? { fields: PATH_FIELDS } : undefined).slice(0, limit)
        const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
        return Promise.all(
            results.map(async (r): Promise<SearchHit> => {
                const path = r.path as string
                // A path hit when every term matched the path or name (whatever
                // else it matched too): the file is what was asked for by name.
                const onPath = Object.values(r.match).every((fields) => fields.some((f) => PATH_FIELDS.includes(f)))
                const hit: SearchHit = { path, score: r.score, match: onPath ? 'path' : 'content' }
                if (r.title) hit.title = r.title as string
                if (!onPath && options.read) {
                    const place = await options.read(path).then((text) => snippetOf(text, terms, r.terms), () => null)
                    if (place) Object.assign(hit, place)
                }
                return hit
            }),
        )
    }
}

/** The line where the query (or a term it matched as) first appears in
 *  `text`, trimmed around the match. */
export function snippetOf(text: string, query: string[], matched: string[] = []): { snippet: string; line: number } | null {
    const lower = text.toLowerCase()
    let at = -1
    for (const term of [query.join(' '), ...query, ...matched]) {
        if (!term) continue
        const i = lower.indexOf(term.toLowerCase())
        if (i >= 0 && (at < 0 || i < at)) at = i
    }
    if (at < 0) return null
    const lineStart = text.lastIndexOf('\n', at - 1) + 1
    const lineEnd = text.indexOf('\n', at)
    const lineText = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
    const line = text.slice(0, at).split('\n').length
    const offset = at - lineStart
    const from = Math.max(0, offset - 40)
    const to = Math.min(lineText.length, offset + 80)
    const snippet = `${from > 0 ? '…' : ''}${lineText.slice(from, to).trim()}${to < lineText.length ? '…' : ''}`
    return { snippet, line }
}
