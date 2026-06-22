/**
 * Host-filesystem adapter for `@joinezco/markdown-editor`.
 *
 * The editor (and its file-search toolbar) talk to storage through the
 * `VfsInterface` shape from `@joinezco/codeblock` — `readFile` / `writeFile` /
 * `readDir` / `stat` / … . This module implements that shape on top of Tauri's
 * `@tauri-apps/plugin-fs`, so notes live as real files on the host disk under
 * `~/Documents/eznote/`.
 *
 * Paths handed to the editor are bare note names (e.g. `Untitled-….md`); the
 * adapter resolves them against the notes directory. Absolute paths pass
 * through unchanged.
 */
import {
    readTextFile,
    writeTextFile,
    mkdir as fsMkdir,
    exists as fsExists,
    readDir as fsReadDir,
    stat as fsStat,
    remove as fsRemove,
    watch as fsWatch,
} from '@tauri-apps/plugin-fs'
import { documentDir, join } from '@tauri-apps/api/path'

// vscode/`@volar/language-service` FileType values, inlined so the adapter
// doesn't pull a dependency in just for an enum.
const FILE = 1
const DIRECTORY = 2
const SYMLINK = 64

export interface HostFileInfo {
    name: string
    size: number
    mtime: Date | null
    atime: Date | null
    ctime: Date | null
    type: number
}

/**
 * The subset of `@joinezco/codeblock`'s `VfsInterface` the editor + toolbar
 * use. Declared locally (rather than importing the package just for a type) so
 * the adapter stays dependency-light; it still structurally satisfies the
 * library's `fs` option at the `createEditor` call site.
 */
export interface HostVfs {
    readFile: (path: string) => Promise<string>
    writeFile: (path: string, data: string) => Promise<void>
    watch: (
        path: string,
        options: { signal: AbortSignal },
    ) => AsyncGenerator<{ eventType: 'rename' | 'change'; filename: string }>
    mkdir: (path: string, options: { recursive: boolean }) => Promise<void>
    readDir: (path: string) => Promise<[string, number][]>
    exists: (path: string) => Promise<boolean>
    stat: (path: string) => Promise<HostFileInfo | null>
    unlink: (path: string) => Promise<void>
}

const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p

/** Create a host-filesystem VFS rooted at the absolute directory `base`. */
export function createTauriVfs(base: string): HostVfs {
    // Bare names → joined onto the notes dir; `.`/empty → the dir itself;
    // already-absolute paths pass through.
    const resolve = (p: string): string => {
        if (!p || p === '.') return base
        if (p.startsWith('/')) return p
        return `${base}/${p}`
    }

    return {
        async readFile(path) {
            return readTextFile(resolve(path))
        },

        async writeFile(path, data) {
            await writeTextFile(resolve(path), data)
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
            return entries.map((e): [string, number] => {
                const type = e.isDirectory
                    ? DIRECTORY
                    : e.isSymlink
                        ? SYMLINK
                        : FILE
                return [e.name, type]
            })
        },

        async stat(path) {
            try {
                const info = await fsStat(resolve(path))
                const type = info.isDirectory
                    ? DIRECTORY
                    : info.isSymlink
                        ? SYMLINK
                        : FILE
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
            const queue: { eventType: 'rename' | 'change'; filename: string }[] = []
            let wake: (() => void) | null = null
            const push = (e: { eventType: 'rename' | 'change'; filename: string }) => {
                queue.push(e)
                wake?.()
                wake = null
            }

            let unwatch: (() => void) | undefined
            try {
                unwatch = await fsWatch(
                    resolve(path),
                    (event: any) => {
                        const t = event?.type
                        const isRename =
                            t && typeof t === 'object'
                                ? 'create' in t || 'remove' in t || 'rename' in t
                                : false
                        const first: string = event?.paths?.[0] ?? ''
                        push({
                            eventType: isRename ? 'rename' : 'change',
                            filename: basename(first),
                        })
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
export async function latestNotePath(fs: HostVfs): Promise<string | null> {
    let entries: [string, number][]
    try {
        entries = await fs.readDir('.')
    } catch {
        return null
    }
    const md = entries.filter(
        ([name, type]) => type === FILE && name.toLowerCase().endsWith('.md'),
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
