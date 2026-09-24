/**
 * Host-filesystem adapter for `@joinezco/markdown-editor`.
 *
 * The editor (and its file-search toolbar) talk to storage through
 * `@joinezco/storage`'s `VfsInterface` — `readFile` / `writeFile` /
 * `readDir` / `stat` / … . This module implements that interface on top of
 * Tauri's `@tauri-apps/plugin-fs`, so notes live as real files on the host
 * disk under `~/Documents/eznote/`.
 *
 * Every path the editor hands over — bare note names (`Untitled-….md`),
 * `.`/empty, or a rooted path like `/` or `/attachments/a.png` — is
 * resolved *inside* the notes directory. The editor's file browser and search
 * indexer treat `/` as the root of the workspace, so a leading slash means
 * "the notes dir", never the host filesystem root (which the Tauri fs scope
 * would refuse anyway).
 */
import {
    readTextFile,
    writeTextFile,
    readFile as fsReadFile,
    writeFile as fsWriteFile,
    rename as fsRename,
    mkdir as fsMkdir,
    exists as fsExists,
    readDir as fsReadDir,
    stat as fsStat,
    remove as fsRemove,
    watch as fsWatch,
} from '@tauri-apps/plugin-fs'
import { documentDir, join } from '@tauri-apps/api/path'
import { FileType, type VfsInterface, type WatchEvent } from '@joinezco/storage'
import { watchEventsOf } from './watch-events'


/** Create a host-filesystem VFS rooted at the absolute directory `base`. */
export function createTauriVfs(base: string): VfsInterface {
    // Everything resolves under `base`: strip any leading `/` or `./`
    // segments (the editor's VFS convention roots the workspace at `/`), and
    // `.`/empty means the dir itself. A caller that already has the absolute
    // notes-dir path is left alone.
    const resolve = (p: string): string => {
        if (p.startsWith(base)) return p
        const rel = p.replace(/^(?:\.?\/)+/, '').replace(/^\.$/, '')
        return rel ? `${base}/${rel}` : base
    }

    return {
        async readFile(path) {
            return readTextFile(resolve(path))
        },

        async writeFile(path, data) {
            await writeTextFile(resolve(path), data)
        },

        async readBytes(path) {
            return fsReadFile(resolve(path))
        },

        async writeBytes(path, data) {
            await fsWriteFile(resolve(path), data)
        },

        async rename(oldPath, newPath) {
            await fsRename(resolve(oldPath), resolve(newPath))
        },

        async mkdir(path, options) {
            await fsMkdir(resolve(path), { recursive: options.recursive })
        },

        async exists(path) {
            return fsExists(resolve(path))
        },

        async unlink(path) {
            await fsRemove(resolve(path))
        },

        async readDir(path) {
            const entries = await fsReadDir(resolve(path))
            return entries.map((e): [string, FileType] => {
                const type = e.isDirectory
                    ? FileType.Directory
                    : e.isSymlink
                        ? FileType.SymbolicLink
                        : FileType.File
                return [e.name, type]
            })
        },

        async stat(path) {
            try {
                const info = await fsStat(resolve(path))
                const type = info.isDirectory
                    ? FileType.Directory
                    : info.isSymlink
                        ? FileType.SymbolicLink
                        : FileType.File
                return {
                    name: path,
                    size: info.size,
                    mtime: info.mtime ?? null,
                    atime: info.atime ?? null,
                    ctime: info.birthtime ?? info.mtime ?? null,
                    type,
                }
            } catch {
                return null
            }
        },

        // Best-effort file watching, bridged from plugin-fs's callback API into
        // the async-generator shape the interface expects. If the platform
        // denies/disallows watching, the generator simply idles until aborted —
        // the editor's autosave doesn't depend on it, and the toolbar tolerates
        // its absence.
        async *watch(path, { signal }) {
            const queue: WatchEvent[] = []
            let wake: (() => void) | null = null
            const push = (e: WatchEvent) => {
                queue.push(e)
                wake?.()
                wake = null
            }

            let unwatch: (() => void) | undefined
            const watched = resolve(path)
            try {
                unwatch = await fsWatch(
                    watched,
                    // Every path the event names: a rename carries both sides.
                    (event: any) => {
                        for (const e of watchEventsOf(watched, event)) push(e)
                    },
                    { recursive: true },
                )
            } catch {
                // watching unavailable — fall through to the abort-only loop
            }

            const onAbort = () => wake?.()
            signal.addEventListener('abort', onAbort, { once: true })
            try {
                while (!signal.aborted) {
                    if (queue.length) {
                        yield queue.shift()!
                        continue
                    }
                    await new Promise<void>((r) => {
                        wake = r
                    })
                }
            } finally {
                signal.removeEventListener('abort', onAbort)
                unwatch?.()
            }
        },
    }
}

/** Absolute path to the notes directory (`~/Documents/eznote/`). */
export async function notesDir(): Promise<string> {
    return join(await documentDir(), 'eznote')
}

/** Resolve + create the notes directory if needed; returns its absolute path. */
export async function ensureNotesDir(): Promise<string> {
    const dir = await notesDir()
    await fsMkdir(dir, { recursive: true })
    return dir
}

/** A fresh, collision-resistant name for a new untitled scratch note. */
export function newScratchPath(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    return `Untitled-${stamp}.md`
}

/** Most-recently-modified `*.md` in the notes dir, or null if there are none. */
export async function latestNotePath(fs: VfsInterface): Promise<string | null> {
    let entries: [string, FileType][]
    try {
        entries = await fs.readDir('.')
    } catch {
        return null
    }
    const md = entries.filter(
        ([name, type]) => type === FileType.File && name.toLowerCase().endsWith('.md'),
    )
    if (!md.length) return null

    let best: { name: string; mtime: number } | null = null
    for (const [name] of md) {
        const info = await fs.stat(name)
        const mtime = info?.mtime ? new Date(info.mtime).getTime() : 0
        if (!best || mtime > best.mtime) best = { name, mtime }
    }
    return best?.name ?? null
}
