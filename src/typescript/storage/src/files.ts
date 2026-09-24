/**
 * Changing what files a vault holds: creating, moving and deleting them, the
 * way a host means it. A plain VFS moves a file; a `Vault` moves it and keeps
 * every link to it working, and updates its indexes. Tools that manage files
 * (the toolbar, a file tree) take this interface, not a VFS, so they do
 * whichever the host provides.
 */
import { FileType, type VfsInterface } from './vfs.js'
import { basename, dirname, normalizePath } from './path.js'

export interface CreateOptions {
    /** Replace a file already at the path (default: refuse). */
    overwrite?: boolean
}

export interface FileOperations {
    /** Create a file with `content` (text or bytes; empty by default),
     *  making its folders. */
    create(path: string, content?: string | Uint8Array, options?: CreateOptions): Promise<void>
    /** Create a folder and any folders above it. */
    mkdir(path: string): Promise<void>
    /** Move a file or folder. Resolves to how many links were rewritten to
     *  follow it (always 0 where links are not kept). */
    rename(oldPath: string, newPath: string): Promise<number>
    /** Delete a file. */
    remove(path: string): Promise<void>
}

/**
 * Whether moving `from` to `path` would land on another entry. On a disk
 * that ignores case (macOS, Windows), `exists` says yes for another spelling
 * of the same name, so renaming `plan.md` to `Plan.md` would look like
 * replacing a file with itself; for such a rename, `path` is taken only if
 * its folder lists that exact spelling (a disk that tells case apart, with
 * both). Without `from`, whether anything is at `path`.
 */
export async function pathTaken(fs: VfsInterface, path: string, from?: string): Promise<boolean> {
    const clean = normalizePath(path)
    if (!(await fs.exists(clean))) return false
    if (from === undefined || normalizePath(from).toLowerCase() !== clean.toLowerCase()) return true
    const name = basename(clean)
    return (await fs.readDir(dirname(clean) || '/')).some(([entry]) => entry === name)
}

async function ensureParent(fs: VfsInterface, path: string): Promise<void> {
    const parent = dirname(path)
    if (parent && !(await fs.exists(parent))) await fs.mkdir(parent, { recursive: true })
}

/** File operations over a plain VFS: no links are kept. */
export function fileOperations(fs: VfsInterface): FileOperations {
    return {
        async create(path, content = '', options = {}) {
            const clean = normalizePath(path)
            if (!options.overwrite && (await fs.exists(clean))) throw new Error(`${clean} already exists`)
            await ensureParent(fs, clean)
            if (typeof content === 'string') await fs.writeFile(clean, content)
            else await fs.writeBytes(clean, content)
        },
        async mkdir(path) {
            await fs.mkdir(normalizePath(path), { recursive: true })
        },
        async rename(oldPath, newPath) {
            const from = normalizePath(oldPath)
            const to = normalizePath(newPath)
            if (from === to) return 0
            if (await pathTaken(fs, to, from)) throw new Error(`${to} already exists`)
            await ensureParent(fs, to)
            await fs.rename(from, to)
            return 0
        },
        async remove(path) {
            const clean = normalizePath(path)
            const stat = await fs.stat(clean)
            if (stat?.type === FileType.Directory) throw new Error(`${clean} is a folder`)
            await fs.unlink(clean)
        },
    }
}
