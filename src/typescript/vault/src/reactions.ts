/**
 * Reactions: a statement by an identity about a document or one of its
 * references (an emoji), kept as per-identity state rather than as a
 * document. `Vault.reactions` implements `Reactions`.
 *
 * Each identity's reactions are one file in the vault's state directory,
 * `.vault/state/<identity>/reactions.jsonl`, one JSON object per line:
 *
 *     {"at":"2026-09-26T14:02Z","doc":"Plan.md","ref":"Plan#:~:text=ship%20it","emoji":"👍"}
 *
 * `ref` is the reference's link as `formatWikilink` writes it, without the
 * brackets or an alias (`referenceKey`), or null for the document itself. The identity
 * is the folder's name (`[A-Za-z0-9_.-]+`). Reading takes in every
 * identity's file; toggling rewrites the identity's own.
 */
import { FileType, Locks, joinPath, normalizePath, type VfsInterface } from '@joinezco/storage'
import { formatWikilink, type Wikilink } from './links/syntax.js'

export interface ReactionTarget {
    /** The document, a vault path. */
    doc: string
    /** The reference's link as `referenceKey` writes it (`Plan#:~:text=…`);
     *  null for the document itself. */
    ref: string | null
}

export interface Reaction {
    /** The identity that made it. */
    by: string
    /** UTC, ISO 8601 to the minute: `2026-09-26T14:02Z`. */
    at: string
    to: ReactionTarget
    emoji: string
}

export interface Reactions {
    /** The identity reactions are made as (null: read-only). */
    identity: string | null
    /** Every identity's reactions on `doc` and on its references. */
    on(doc: string): Promise<Reaction[]>
    /** Add the identity's `emoji` on `to`, or take it away if it is there. */
    toggle(to: ReactionTarget, emoji: string): Promise<void>
    /** Be told when the answers above may have changed. */
    subscribe?(listener: () => void): () => void
}

export interface ReactionsOptions {
    /** The vault's state directory (default `.vault`); reactions live under
     *  `state/` in it. */
    dir?: string
    /** The identity to react as; none makes the store read-only. */
    identity?: string | null
    /** The clock (tests). */
    now?: () => number
}

export const IDENTITY = /^[A-Za-z0-9_.-]+$/

/** A reference's link as reactions name it: `formatWikilink` without the
 *  brackets or the alias (`Plan#:~:text=ship%20it`), so a reference keeps
 *  its reactions however its link is displayed. */
export function referenceKey(link: Wikilink): string {
    return formatWikilink({ ...link, alias: null }).slice(2, -2)
}

/** A reaction's time, as the file writes it: UTC to the minute. */
export function reactionTime(now: number = Date.now()): string {
    return `${new Date(now).toISOString().slice(0, 16)}Z`
}

interface Line {
    at: string
    doc: string
    ref: string | null
    emoji: string
}

export class ReactionStore implements Reactions {
    readonly identity: string | null
    private readonly dir: string
    private readonly now: () => number
    /** Each identity's reactions as last read (null: read and not there). */
    private readonly cache = new Map<string, Line[]>()
    private readonly locks = new Locks()
    private readonly listeners = new Set<() => void>()

    constructor(
        private readonly fs: VfsInterface,
        options: ReactionsOptions = {},
    ) {
        const identity = options.identity ?? null
        if (identity !== null && !IDENTITY.test(identity)) throw new Error(`Not an identity: ${JSON.stringify(identity)} (allowed: A-Z a-z 0-9 _ . -)`)
        this.identity = identity
        this.dir = joinPath(normalizePath(options.dir ?? '.vault'), 'state')
        this.now = options.now ?? Date.now
    }

    /** Where every identity's state lives (`.vault/state`). */
    get stateDir(): string {
        return this.dir
    }

    async on(doc: string): Promise<Reaction[]> {
        const clean = normalizePath(doc)
        const out: Reaction[] = []
        for (const identity of await this.identities()) {
            for (const line of await this.read(identity)) {
                if (line.doc === clean) out.push({ by: identity, at: line.at, to: { doc: line.doc, ref: line.ref }, emoji: line.emoji })
            }
        }
        return out
    }

    toggle(to: ReactionTarget, emoji: string): Promise<void> {
        const identity = this.identity
        if (identity === null) return Promise.reject(new Error('Reactions are read-only without an identity'))
        if (!emoji.trim()) return Promise.reject(new Error('A reaction needs an emoji'))
        const target: ReactionTarget = { doc: normalizePath(to.doc), ref: to.ref }
        return this.locks.run(identity, async () => {
            this.cache.delete(identity)
            const lines = await this.read(identity)
            const at = lines.findIndex((l) => l.doc === target.doc && l.ref === target.ref && l.emoji === emoji)
            const next = at < 0 ? [...lines, { at: reactionTime(this.now()), doc: target.doc, ref: target.ref, emoji }] : lines.filter((_, i) => i !== at)
            const folder = joinPath(this.dir, identity)
            if (!(await this.fs.exists(folder))) await this.fs.mkdir(folder, { recursive: true })
            await this.fs.writeFile(this.file(identity), next.map((l) => JSON.stringify(l)).join('\n') + (next.length ? '\n' : ''))
            this.cache.set(identity, next)
            this.notify()
        })
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    /** Something under the state directory changed at `path` (the vault's
     *  watch): forget what was read of the identity it belongs to, or of
     *  every identity when the path is the directory itself. Returns false
     *  when the path is not under the state directory. */
    invalidate(path: string): boolean {
        const clean = normalizePath(path)
        if (clean.startsWith(`${this.dir}/`)) {
            this.cache.delete(clean.slice(this.dir.length + 1).split('/')[0])
        } else if (clean === this.dir || clean === '' || this.dir.startsWith(`${clean}/`)) {
            this.cache.clear()
        } else return false
        this.notify()
        return true
    }

    private file(identity: string): string {
        return joinPath(this.dir, identity, 'reactions.jsonl')
    }

    private async identities(): Promise<string[]> {
        const entries = await this.fs.readDir(this.dir).catch(() => [] as [string, FileType][])
        return entries
            .filter(([name, type]) => type === FileType.Directory && IDENTITY.test(name))
            .map(([name]) => name)
            .sort()
    }

    private async read(identity: string): Promise<Line[]> {
        const cached = this.cache.get(identity)
        if (cached) return cached
        const text = await this.fs.readFile(this.file(identity)).catch(() => '')
        const lines: Line[] = []
        for (const raw of text.split('\n')) {
            const line = raw.trim()
            if (!line) continue
            try {
                const parsed = JSON.parse(line) as Partial<Line>
                if (typeof parsed.doc !== 'string' || typeof parsed.emoji !== 'string') continue
                lines.push({
                    at: typeof parsed.at === 'string' ? parsed.at : '',
                    doc: normalizePath(parsed.doc),
                    ref: typeof parsed.ref === 'string' ? parsed.ref : null,
                    emoji: parsed.emoji,
                })
            } catch {
                // A line that is not JSON is passed over, not fatal.
            }
        }
        this.cache.set(identity, lines)
        return lines
    }

    private notify(): void {
        for (const listener of this.listeners) listener()
    }
}
