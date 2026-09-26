/**
 * Every file's version log: who wrote what, on top of what.
 *
 * The files stay the truth; the log is a record beside them, in `.vault/`.
 * A version is a file's bytes (stored once, by their blake3 hash, in
 * `.vault/objects/`) and the versions it follows; its id is a hash over
 * both, so a revert to earlier bytes is a new version. A file's versions and
 * its head are kept under `.vault/versions/<path>/`.
 *
 * A write names the version it was made on: `put(path, base, bytes)` is
 * refused when `base` is no longer the file's head, and the refused bytes
 * are kept beside it as a conflict copy (`Note (conflict, 2026-09-23
 * 12.04).md`, the Syncthing and Obsidian Sync habit), so nobody's work is
 * lost and the conflict is a file anyone can open. A change made by
 * anything else (an editor, git) is taken for a version on the head it
 * replaced the moment the log looks at the file again.
 *
 * Versions are signed when the log is given a `Signer` (a device key); the
 * keys themselves are not this package's.
 */
import { blake3 } from '@noble/hashes/blake3'
import { bytesToHex } from '@noble/hashes/utils'
import { walk, type VfsInterface } from './vfs.js'
import { basename, dirname, joinPath, normalizePath } from './path.js'
import { Locks } from './lock.js'

export interface FileVersion {
    /** blake3 over the content hash, the parents and the path. */
    id: string
    /** blake3 of the bytes; `read` finds them by it. */
    content: string
    /** The versions this one follows (one, or none for a file's first). */
    parents: string[]
    /** Where it was written. */
    path: string
    /** Milliseconds since the epoch. */
    time: number
    size: number
    /** The signer's id, when signed. */
    author?: string
    /** The signer's signature over `id`, base64. */
    signature?: string
    /** For a conflict copy, the file it lost to. */
    conflictOf?: string
}

export type PutResult =
    | { ok: true; version: FileVersion }
    /** Refused: `base` was not the head. The bytes are kept at `conflict.path`. */
    | { ok: false; head: FileVersion | null; conflict: { path: string; version: FileVersion } }

/** Signs versions: a device key, held wherever the environment keeps keys. */
export interface Signer {
    id: string
    sign(bytes: Uint8Array): Promise<Uint8Array>
}

export interface VersionLogOptions {
    /** Where the log lives (default `.vault`). */
    dir?: string
    signer?: Signer
    /** The clock (tests). */
    now?: () => number
}

const encoder = new TextEncoder()
const hash = (bytes: Uint8Array) => bytesToHex(blake3(bytes))

/**
 * A free name beside `path` for a copy of it that lost a write
 * (`plan (conflict, 2026-09-23 12.04).md`; `who`, a signer's id, in place of
 * `conflict` when there is one). Anything that keeps a losing write beside
 * the file names it so, with a log or without.
 */
export async function conflictCopyPath(fs: VfsInterface, path: string, options: { when?: number; who?: string } = {}): Promise<string> {
    const clean = normalizePath(path)
    const name = basename(clean)
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    const when = new Date(options.when ?? Date.now())
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}.${pad(when.getMinutes())}`
    const who = options.who ?? 'conflict'
    for (let n = 1; ; n++) {
        const candidate = joinPath(dirname(clean), `${stem} (${who}, ${stamp}${n > 1 ? ` ${n}` : ''})${ext}`)
        if (!(await fs.exists(candidate))) return candidate
    }
}

export class VersionLog {
    private readonly dir: string
    private readonly now: () => number
    private readonly locks = new Locks()

    constructor(
        private readonly fs: VfsInterface,
        private readonly options: VersionLogOptions = {},
    ) {
        this.dir = normalizePath(options.dir ?? '.vault')
        this.now = options.now ?? Date.now
    }

    /**
     * The file's current version: the log's head, or, when the file has
     * changed since, a new version for what is there now (on that head).
     * Null when the file does not exist.
     */
    head(path: string): Promise<FileVersion | null> {
        const clean = normalizePath(path)
        return this.locks.run(clean, () => this.observe(clean))
    }

    /** The file's versions, newest first, back along first parents. */
    async history(path: string): Promise<FileVersion[]> {
        const clean = normalizePath(path)
        const out: FileVersion[] = []
        let next = (await this.head(clean))?.id ?? (await this.storedHead(clean))?.id
        const seen = new Set<string>()
        while (next && !seen.has(next)) {
            seen.add(next)
            const version = await this.entry(clean, next)
            if (!version) break
            out.push(version)
            next = version.parents[0]
        }
        return out
    }

    /** A version's bytes. */
    async read(version: FileVersion | string): Promise<Uint8Array> {
        const content = typeof version === 'string' ? version : version.content
        return this.fs.readBytes(this.objectPath(content))
    }

    /**
     * Write `bytes` to `path` if `base` is its head (null: the file must not
     * exist). Otherwise nothing at `path` changes: the bytes go to a conflict
     * copy beside it, recorded as a version on `base`.
     */
    put(path: string, base: string | null, bytes: Uint8Array | string): Promise<PutResult> {
        const clean = normalizePath(path)
        const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes
        return this.locks.run(clean, async () => {
            const head = await this.observe(clean)
            if ((head?.id ?? null) !== base) {
                const copy = await this.conflictPath(clean)
                await this.fs.writeBytes(copy, data)
                const version = await this.record(copy, data, base ? [base] : [], clean)
                return { ok: false, head, conflict: { path: copy, version } }
            }
            const content = hash(data)
            if (head && head.content === content) return { ok: true, version: head }
            await this.fs.writeBytes(clean, data)
            return { ok: true, version: await this.record(clean, data, head ? [head.id] : []) }
        })
    }

    /**
     * The file (or folder) at `from` moved to `to`: its history follows. A
     * log already at `to` is one a file removed outside the vault left
     * behind, and it is replaced (a file that arrives with no log leaves
     * `to` with none).
     */
    async move(from: string, to: string): Promise<void> {
        const source = this.logPath(normalizePath(from))
        const target = this.logPath(normalizePath(to))
        if (source === target) return
        const taken = await this.fs.exists(target)
        if (taken) await this.clear(target)
        if (!(await this.fs.exists(source))) return
        if (!taken) {
            await this.ensureDir(dirname(target))
            await this.fs.rename(source, target)
            return
        }
        // No store renames a folder onto a folder that exists, and none can
        // remove one, so onto a cleared log the files go one by one.
        for await (const file of walk(this.fs, source)) {
            const dest = joinPath(target, normalizePath(file).slice(source.length + 1))
            await this.ensureDir(dirname(dest))
            await this.fs.rename(file, dest)
        }
    }

    /**
     * The file's log removed (a folder's: every file's under it). The bytes
     * stay in `.vault/objects/`: they are shared by every version made of
     * them, wherever it was written.
     */
    async remove(path: string): Promise<void> {
        const log = this.logPath(normalizePath(path))
        if (await this.fs.exists(log)) await this.clear(log)
    }

    // ── Records ──────────────────────────────────────────────────────────────

    private logPath(path: string): string {
        return joinPath(this.dir, 'versions', path)
    }

    private objectPath(content: string): string {
        return joinPath(this.dir, 'objects', content.slice(0, 2), content)
    }

    private async storedHead(path: string): Promise<FileVersion | null> {
        const id = await this.fs.readFile(joinPath(this.logPath(path), 'HEAD')).catch(() => null)
        return id ? this.entry(path, id.trim()) : null
    }

    private async entry(path: string, id: string): Promise<FileVersion | null> {
        const json = await this.fs.readFile(joinPath(this.logPath(path), `${id}.json`)).catch(() => null)
        return json ? (JSON.parse(json) as FileVersion) : null
    }

    /** The head, after taking what is on disk now for a version if it differs. */
    private async observe(path: string): Promise<FileVersion | null> {
        const stored = await this.storedHead(path)
        const bytes = (await this.fs.exists(path)) ? await this.fs.readBytes(path) : null
        if (!bytes) return null
        if (stored && stored.content === hash(bytes)) return stored
        return this.record(path, bytes, stored ? [stored.id] : [])
    }

    private async record(path: string, bytes: Uint8Array, parents: string[], conflictOf?: string): Promise<FileVersion> {
        const content = hash(bytes)
        const object = this.objectPath(content)
        if (!(await this.fs.exists(object))) {
            await this.ensureDir(dirname(object))
            await this.fs.writeBytes(object, bytes)
        }
        const id = hash(encoder.encode(['ezco-version', content, path, ...parents].join('\n')))
        const version: FileVersion = { id, content, parents, path, time: this.now(), size: bytes.length }
        if (conflictOf) version.conflictOf = conflictOf
        const signer = this.options.signer
        if (signer) {
            version.author = signer.id
            version.signature = toBase64(await signer.sign(encoder.encode(id)))
        }
        const log = this.logPath(path)
        await this.ensureDir(log)
        await this.fs.writeFile(joinPath(log, `${id}.json`), JSON.stringify(version))
        await this.fs.writeFile(joinPath(log, 'HEAD'), id)
        return version
    }

    private conflictPath(path: string): Promise<string> {
        return conflictCopyPath(this.fs, path, { when: this.now(), who: this.options.signer?.id })
    }

    private async ensureDir(path: string): Promise<void> {
        if (path && !(await this.fs.exists(path))) await this.fs.mkdir(path, { recursive: true })
    }

    /** Every file under `dir` unlinked. The contract has no way to remove a
     *  folder, so the emptied ones stay; nothing reads them. */
    private async clear(dir: string): Promise<void> {
        for await (const file of walk(this.fs, dir)) await this.fs.unlink(file)
    }
}

function toBase64(bytes: Uint8Array): string {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
}
