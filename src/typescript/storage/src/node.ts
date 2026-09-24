/**
 * A vault on the local disk through Node's `fs`, rooted at a directory:
 * every path resolves inside it (`..` cannot climb out). For tests, command
 * line tools and anything running under Node; a separate entry point
 * (`@joinezco/storage/node`) so browser bundles never see `node:fs`.
 */
import { promises as fs, watch as fsWatch } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { FileType, type FileStat, type VfsInterface, type WatchEvent } from './vfs'
import { normalizePath } from './path'

export function nodeVfs(root: string): VfsInterface {
    const abs = (path: string) => join(root, normalizePath(path))
    const kind = (d: { isDirectory(): boolean; isSymbolicLink(): boolean }): FileType =>
        d.isDirectory() ? FileType.Directory : d.isSymbolicLink() ? FileType.SymbolicLink : FileType.File

    return {
        readFile: (path) => fs.readFile(abs(path), 'utf8'),
        writeFile: (path, data) => fs.writeFile(abs(path), data),
        async readBytes(path) {
            return new Uint8Array(await fs.readFile(abs(path)))
        },
        writeBytes: (path, data) => fs.writeFile(abs(path), data),
        rename: (oldPath, newPath) => fs.rename(abs(oldPath), abs(newPath)),
        async mkdir(path, options) {
            await fs.mkdir(abs(path), { recursive: options.recursive })
        },
        async readDir(path) {
            const entries = await fs.readdir(abs(path), { withFileTypes: true })
            return entries.map((e): [string, FileType] => [e.name, kind(e)])
        },
        async exists(path) {
            try {
                await fs.access(abs(path))
                return true
            } catch {
                return false
            }
        },
        async stat(path): Promise<FileStat | null> {
            try {
                const s = await fs.lstat(abs(path))
                return { name: path, type: kind(s), size: s.size, mtime: s.mtime, ctime: s.ctime, atime: s.atime }
            } catch {
                return null
            }
        },
        unlink: (path) => fs.unlink(abs(path)),
        async *watch(path, { signal }) {
            const base = abs(path)
            const queue: WatchEvent[] = []
            let wake: (() => void) | null = null
            const watcher = fsWatch(base, { recursive: true, signal }, (eventType, filename) => {
                if (!filename) return
                const rel = relative(base, join(base, filename.toString())).split(sep).join('/')
                queue.push({ eventType: eventType === 'change' ? 'change' : 'rename', filename: rel })
                wake?.()
            })
            watcher.on('error', () => wake?.())
            const onAbort = () => wake?.()
            signal.addEventListener('abort', onAbort, { once: true })
            try {
                while (!signal.aborted) {
                    const next = queue.shift()
                    if (next) {
                        yield next
                        continue
                    }
                    await new Promise<void>((resolve) => (wake = resolve))
                    wake = null
                }
            } finally {
                signal.removeEventListener('abort', onAbort)
                watcher.close()
            }
        },
    }
}
