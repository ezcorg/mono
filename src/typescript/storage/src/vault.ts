/**
 * A vault: a folder of files behind any `VfsInterface`, with the indexes
 * derived from it kept current.
 *
 * The files are the truth; everything here is rebuilt from them. `open`
 * walks the vault once; after that the index follows every write made
 * through `vault.fs` (the same filesystem, observed), and, when the store
 * can report them, changes made by anything else (`watch`).
 *
 *     const vault = await Vault.open(hostFs)
 *     createEditor({
 *         fs: { fs: vault.fs, … },
 *         links: { resolver: vault.links, index: vault.links },
 *         toolbar: { search: vault.search, files: vault.files },
 *     })
 */
import { FileType, type VfsInterface } from './vfs.js'
import { basename, dirname, extname, isHidden, isNote, normalizePath } from './path.js'
import { SearchIndex, type FileSearch } from './search.js'
import { pathTaken, type FileOperations } from './files.js'
import { LinkGraph, syntaxOf } from './links/graph.js'
import { markdownDestinationFor, resolveLink, wikilinkTextFor } from './links/resolve.js'
import { rewriteLinks, scanLinks, type ScannedLink } from './links/syntax.js'
import type { LinkIndex, LinkRef, LinkResolution, LinkResolver, LinkSuggestion, LinkSyntax } from './links/types.js'

export interface VaultOptions {
    /** Follow changes made outside `vault.fs` through the store's `watch`.
     *  Default true; a store that cannot watch simply never reports. */
    watch?: boolean
    /** Leave a path out of every index (the default leaves out dot-files and
     *  dot-directories: `.git`, `.obsidian`, the vault's own state). */
    ignore?: (path: string) => boolean
}

/** The links of a vault, as the editor asks for them. */
export type VaultLinks = LinkIndex & LinkResolver

export class Vault {
    /** The vault's filesystem, observed: writes through it update the index. */
    readonly fs: VfsInterface
    /** Backlinks, unresolved links, resolution, suggestions and renames. */
    readonly links: VaultLinks
    /** Files by path and name, notes by their text. */
    readonly search: FileSearch
    /** Creating, moving (links kept) and deleting files. */
    readonly files: FileOperations

    private graph = new LinkGraph()
    private text = new SearchIndex()
    private listeners = new Set<() => void>()
    private notifyScheduled = false
    private watchAbort = new AbortController()
    private ignore: (path: string) => boolean

    /** Resolves once the first walk of the store is indexed. Every
     *  asynchronous query waits for it; `fs` is usable at once. */
    readonly ready: Promise<void>

    /**
     * A vault over `store`, indexing it in the background (`ready`). Use
     * `Vault.open` to wait for the index; construct directly when the
     * filesystem is needed before the index is (an editor opening a note).
     */
    constructor(
        /** The store as given, unobserved. */
        readonly store: VfsInterface,
        options: VaultOptions = {},
    ) {
        this.ignore = options.ignore ?? isHidden
        this.fs = this.observe(store)
        const ready = () => this.ready
        this.links = {
            backlinks: async (note) => (await ready(), this.graph.backlinks(note)),
            unresolved: async () => (await ready(), this.graph.unresolved()),
            rename: async (oldPath, newPath) => (await ready(), this.rename(oldPath, newPath)),
            resolve: async (target, from, syntax) => (await ready(), this.resolve(target, from, syntax)),
            suggest: async (query, from, limit) => (await ready(), this.suggest(query, from, limit)),
            subscribe: (listener) => this.subscribe(listener),
        }
        this.search = {
            search: async (query, options) => {
                await ready()
                return this.text.search(query, { ...options, read: (path) => this.store.readFile(path) })
            },
        }
        const fs = this.fs
        this.files = {
            async create(path, content = '', options = {}) {
                const clean = normalizePath(path)
                if (!options.overwrite && (await fs.exists(clean))) throw new Error(`${clean} already exists`)
                const parent = dirname(clean)
                if (parent && !(await fs.exists(parent))) await fs.mkdir(parent, { recursive: true })
                if (typeof content === 'string') await fs.writeFile(clean, content)
                else await fs.writeBytes(clean, content)
            },
            mkdir: (path) => fs.mkdir(normalizePath(path), { recursive: true }),
            rename: async (oldPath, newPath) => (await ready(), this.rename(oldPath, newPath)),
            async remove(path) {
                const clean = normalizePath(path)
                if ((await fs.stat(clean))?.type === FileType.Directory) throw new Error(`${clean} is a folder`)
                await fs.unlink(clean)
            },
        }
        // Following starts before the first walk, so a change made while the
        // walk runs is heard (and applied once the walk is done).
        if (options.watch !== false) this.follow()
        this.ready = this.rebuild()
    }

    /** Index `store`, and resolve when the index is built. */
    static async open(store: VfsInterface, options: VaultOptions = {}): Promise<Vault> {
        const vault = new Vault(store, options)
        await vault.ready
        return vault
    }

    /** Re-read every file. */
    async rebuild(): Promise<void> {
        this.graph = new LinkGraph()
        this.text.clear()
        for await (const path of this.walk('')) {
            // A note that cannot be read is still there to link to.
            await this.indexFile(path).catch(() => this.addFile(path))
        }
        this.changed()
    }

    /** The files under `dir` the vault indexes. A folder `ignore` leaves out
     *  is not entered (`.git` can be large), and one that cannot be read is
     *  passed over rather than failing the walk. */
    private async *walk(dir: string): AsyncGenerator<string> {
        let entries: [string, FileType][]
        try {
            entries = await this.store.readDir(dir || '/')
        } catch {
            return
        }
        for (const [name, type] of entries) {
            const path = dir ? `${dir}/${name}` : name
            if (this.ignore(path)) continue
            if (type === FileType.Directory) yield* this.walk(path)
            else yield path
        }
    }

    /** Stop following the store. */
    close(): void {
        this.watchAbort.abort()
        this.listeners.clear()
    }

    /** Be told (once per burst of changes) when anything indexed changed. */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    /** Every file in the vault, sorted. */
    paths(): string[] {
        return [...this.graph.files.all()].sort()
    }

    resolve(target: string, from: string | null, syntax: LinkSyntax = 'wikilink'): LinkResolution | null {
        return resolveLink(target, from ? normalizePath(from) : null, syntax, this.graph.files)
    }

    suggest(query: string, from: string | null, limit?: number): LinkSuggestion[] {
        return this.graph.suggest(query, from ? normalizePath(from) : null, limit)
    }

    backlinks(note: string): LinkRef[] {
        return this.graph.backlinks(note)
    }

    unresolved(): LinkRef[] {
        return this.graph.unresolved()
    }

    /**
     * Move a file or directory and keep every link meaning what it meant:
     * links to anything moved are rewritten to the new place, links inside
     * moved notes are rewritten where the move changed what they resolve to,
     * and a wikilink elsewhere that the new name would capture is lengthened
     * to keep its old target. Refuses to replace an existing file. Returns
     * how many links were rewritten.
     */
    async rename(oldPath: string, newPath: string): Promise<number> {
        const from = normalizePath(oldPath)
        const to = normalizePath(newPath)
        if (!from || !to) throw new Error('rename: an empty path is the vault root')
        if (from === to) return 0
        if (to.startsWith(`${from}/`)) throw new Error(`rename: cannot move ${from} into itself`)
        const stat = await this.store.stat(from)
        if (!stat) throw new Error(`rename: ${from} does not exist`)
        if (await pathTaken(this.store, to, from)) throw new Error(`rename: ${to} already exists`)

        // Everything that moves, old path → new.
        const moved = new Map<string, string>()
        if (stat.type === FileType.Directory) {
            for (const path of this.graph.files.all()) {
                if (path.startsWith(`${from}/`)) moved.set(path, to + path.slice(from.length))
            }
        } else {
            moved.set(from, to)
        }
        const after = (path: string) => moved.get(path) ?? path

        // Before moving: what each link that the move could affect resolves to.
        // That is every link to a moved file, every link inside a moved note,
        // and every wikilink whose name a moved file's new name could capture.
        // Candidates come from the index; their text is read fresh, so the
        // offsets rewritten below are the file's, not a stale copy's.
        const newNames = new Set([...moved.values()].map(linkName))
        const affects = (note: string, link: ScannedLink, resolved: string) =>
            moved.has(resolved) || moved.has(note) || (syntaxOf(link) === 'wikilink' && newNames.has(linkName(link.target)))
        const pending: { note: string; text: string; pins: Map<number, string> }[] = []
        for (const note of this.graph.noteList()) {
            const candidate = this.graph.linksOf(note).some((link) => {
                const r = link.target.trim() ? this.graph.resolve(link, note) : null
                return !!r?.exists && affects(note, link, r.path)
            })
            if (!candidate) continue
            const text = await this.store.readFile(note)
            this.setNote(note, text)
            const pins = new Map<number, string>()
            for (const link of scanLinks(text)) {
                const r = link.target.trim() ? this.graph.resolve(link, note) : null
                if (r?.exists && affects(note, link, r.path)) pins.set(link.targetStart, after(r.path))
            }
            if (pins.size) pending.push({ note, text, pins })
        }

        const parent = dirname(to)
        if (parent && !(await this.store.exists(parent))) await this.store.mkdir(parent, { recursive: true })
        await this.store.rename(from, to)
        for (const [a, b] of moved) {
            this.graph.moveFile(a, b)
            this.text.remove(a)
            this.text.set(b, isNote(b) ? await this.store.readFile(b) : null)
        }

        // After: rewrite whatever no longer resolves where it did.
        let count = 0
        for (const { note, text, pins } of pending) {
            const now = after(note)
            const rewritten = rewriteLinks(text, (link) => {
                const want = pins.get(link.targetStart)
                if (!want || this.graph.resolve(link, now)?.path === want) return null
                return syntaxOf(link) === 'wikilink'
                    ? wikilinkTextFor(want, now, this.graph.files, normalizePath(link.target).split('/').length)
                    : markdownDestinationFor(want, now, link)
            })
            if (rewritten.count === 0) continue
            await this.store.writeFile(now, rewritten.text)
            this.setNote(now, rewritten.text)
            count += rewritten.count
        }
        this.changed()
        return count
    }

    // ── Keeping the index current ────────────────────────────────────────────

    private observe(store: VfsInterface): VfsInterface {
        const vault = this
        const indexed = (path: string) => !vault.ignore(normalizePath(path))
        // Every method delegated by name: the store may be a class instance or
        // a worker proxy, whose methods a spread would not copy.
        return {
            readFile: (path) => store.readFile(path),
            readBytes: (path) => store.readBytes(path),
            readDir: (path) => store.readDir(path),
            exists: (path) => store.exists(path),
            stat: (path) => store.stat(path),
            mkdir: (path, options) => store.mkdir(path, options),
            watch: (path, options) => store.watch(path, options),
            // A worker given a port this way reaches the store directly; what
            // it writes reaches the index as anything else's does, by `watch`.
            ...(store.connect ? { connect: () => store.connect!() } : {}),
            async writeFile(path, data) {
                await store.writeFile(path, data)
                if (!indexed(path)) return
                if (isNote(path)) vault.setNote(path, data)
                else vault.addFile(path)
                vault.changed()
            },
            async writeBytes(path, data) {
                await store.writeBytes(path, data)
                if (!indexed(path)) return
                if (isNote(path)) vault.setNote(path, new TextDecoder().decode(data))
                else vault.addFile(path)
                vault.changed()
            },
            async unlink(path) {
                await store.unlink(path)
                vault.removeFile(path)
                vault.changed()
            },
            async rename(oldPath, newPath) {
                await store.rename(oldPath, newPath)
                await vault.reindexUnder(oldPath)
                await vault.reindexUnder(newPath)
            },
        }
    }

    /** Bring the index in line with the store at `path` (a file, a directory,
     *  or something no longer there). Everything is read first and the index
     *  changed in one step, so nothing asking meanwhile (a rename resolving
     *  links while the store reports the move) sees the path missing. */
    private async reindexUnder(path: string): Promise<void> {
        const clean = normalizePath(path)
        const found: [string, string | null][] = []
        const read = async (file: string) => {
            if (!isNote(file)) return found.push([file, null])
            const text = await this.store.readFile(file).catch(() => null)
            if (text !== null) found.push([file, text])
        }
        const stat = this.ignore(clean) ? null : await this.store.stat(clean).catch(() => null)
        if (stat?.type === FileType.Directory) {
            for await (const file of this.walk(clean)) await read(file)
        } else if (stat) {
            await read(clean)
        }
        for (const known of [...this.graph.files.all()]) {
            if (known === clean || known.startsWith(`${clean}/`)) this.removeFile(known)
        }
        for (const [file, text] of found) {
            if (text === null) this.addFile(file)
            else this.setNote(file, text)
        }
        this.changed()
    }

    private async indexFile(path: string): Promise<void> {
        if (isNote(path)) this.setNote(path, await this.store.readFile(path))
        else this.addFile(path)
    }

    // Every change to what is indexed goes through these, so the link graph
    // and the search index never disagree.
    private setNote(path: string, text: string): void {
        this.graph.setNote(path, text)
        this.text.set(path, text)
    }

    private addFile(path: string): void {
        this.graph.addFile(path)
        this.text.set(path, null)
    }

    private removeFile(path: string): void {
        this.graph.removeFile(path)
        this.text.remove(path)
    }

    private follow(): void {
        const signal = this.watchAbort.signal
        void (async () => {
            try {
                for await (const event of this.store.watch('/', { signal })) {
                    await this.ready
                    const path = normalizePath(event.filename)
                    if (!path || this.ignore(path)) continue
                    await this.reindexUnder(path).catch(() => {})
                }
            } catch {
                // A store that cannot watch: the index follows `vault.fs` only.
            }
        })()
    }

    /** Notify on the next macrotask: a burst of writes (several awaited
     *  saves, a rename rewriting many notes) reaches listeners once. */
    private changed(): void {
        if (this.notifyScheduled) return
        this.notifyScheduled = true
        setTimeout(() => {
            this.notifyScheduled = false
            for (const listener of this.listeners) listener()
        }, 0)
    }
}

/** The name a wikilink matches by: the last segment, lower-cased, without `.md`. */
function linkName(pathOrTarget: string): string {
    const name = basename(pathOrTarget).toLowerCase()
    return extname(name) === 'md' ? name.slice(0, -3) : name
}

