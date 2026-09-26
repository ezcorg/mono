/**
 * A vault in the Origin Private File System: the browser's own disk.
 *
 * In a dedicated worker, files are read through synchronous access handles,
 * the fast path; anywhere else through `getFile()`. Writes go through
 * writable streams everywhere. An access handle locks its file, so every
 * operation on a file waits for the one before it; different files proceed
 * at once.
 *
 * `watch` reports changes made through this instance. The browser has no
 * notification for OPFS, so a store should have one owner (`browserVfs`
 * arranges that for a whole origin) and others should reach it through it.
 */
import { FileType, type FileStat, type VfsInterface, type WatchEvent } from '../vfs.js'
import { normalizePath } from '../path.js'
import { Locks } from '../lock.js'

/** Whether this context can reach the OPFS. */
export function hasOpfs(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
}

/** The folder named `name` at the OPFS root, created if missing: one per
 *  vault, so an origin can keep several. */
export async function opfsBucket(name: string): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle(name, { create: true })
}

/** Remove the folder named `name` at the OPFS root, and everything in it. */
export async function removeOpfsBucket(name: string): Promise<void> {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(name, { recursive: true }).catch((error: unknown) => {
        if ((error as DOMException)?.name !== 'NotFoundError') throw error
    })
}

type SyncHandle = {
    getSize(): number
    read(buffer: Uint8Array, options: { at: number }): number
    close(): void
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The vault in `root`, an OPFS directory (`opfsBucket`). */
export function opfsVfs(root: FileSystemDirectoryHandle): VfsInterface {
    const syncHandles =
        typeof FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype
    const dirs = new Map<string, FileSystemDirectoryHandle>([['', root]])
    const locks = new Locks()
    const watchers = new Set<(event: WatchEvent) => void>()
    const locked = <T>(path: string, fn: () => Promise<T>): Promise<T> => locks.run(path, fn)

    const segments = (path: string) => normalizePath(path).split('/').filter(Boolean)

    /** The directory at `path`; `create` makes missing ones (mkdir -p). */
    const dir = async (path: string, create = false): Promise<FileSystemDirectoryHandle> => {
        const clean = normalizePath(path)
        const cached = dirs.get(clean)
        if (cached) return cached
        let handle = root
        let built = ''
        for (const seg of segments(clean)) {
            built = built ? `${built}/${seg}` : seg
            const known = dirs.get(built)
            if (known) {
                handle = known
                continue
            }
            handle = await handle.getDirectoryHandle(seg, { create }).catch((error) => {
                throw translate(error, path)
            })
            dirs.set(built, handle)
        }
        return handle
    }

    const split = (path: string): { parent: string; name: string; clean: string } => {
        const clean = normalizePath(path)
        const i = clean.lastIndexOf('/')
        return { parent: i < 0 ? '' : clean.slice(0, i), name: clean.slice(i + 1), clean }
    }

    /** The handle at `path`, a file or a directory, or null. */
    const entry = async (path: string): Promise<FileSystemHandle | null> => {
        const { parent, name, clean } = split(path)
        if (!clean) return root
        let folder: FileSystemDirectoryHandle
        try {
            folder = await dir(parent)
        } catch {
            return null
        }
        for (const get of [() => folder.getFileHandle(name), () => folder.getDirectoryHandle(name)]) {
            try {
                return await get()
            } catch (error) {
                const kind = (error as DOMException)?.name
                if (kind !== 'TypeMismatchError' && kind !== 'NotFoundError') throw error
            }
        }
        return null
    }

    const fileHandle = async (path: string, create = false): Promise<FileSystemFileHandle> => {
        const { parent, name, clean } = split(path)
        if (!clean) throw eisdir(path)
        const folder = await dir(parent)
        return folder.getFileHandle(name, { create }).catch((error) => {
            throw (error as DOMException)?.name === 'TypeMismatchError' ? eisdir(path) : translate(error, path)
        })
    }

    const emit = (eventType: WatchEvent['eventType'], path: string) => {
        const filename = normalizePath(path)
        for (const watcher of watchers) watcher({ eventType, filename })
    }

    const read = async (path: string): Promise<Uint8Array> => {
        const handle = await fileHandle(path)
        return locked(normalizePath(path), async () => {
            if (syncHandles) {
                const access: SyncHandle = await (handle as any).createSyncAccessHandle()
                try {
                    const buf = new Uint8Array(access.getSize())
                    access.read(buf, { at: 0 })
                    return buf
                } finally {
                    access.close()
                }
            }
            return new Uint8Array(await (await handle.getFile()).arrayBuffer())
        })
    }

    const write = async (path: string, data: Uint8Array): Promise<void> => {
        const clean = normalizePath(path)
        const existed = !!(await entry(clean))
        const handle = await fileHandle(clean, true)
        // Through a writable stream even where access handles exist: the new
        // contents replace the old at `close()` (a crash leaves the old file,
        // never half of the new) and the modification time moves, which an
        // access handle's writes do not do in Chromium.
        await locked(clean, async () => {
            const writable = await handle.createWritable()
            await writable.write(data as Uint8Array<ArrayBuffer>)
            await writable.close()
        })
        emit(existed ? 'change' : 'rename', clean)
    }

    const copyTree = async (from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle): Promise<void> => {
        for await (const [name, handle] of (from as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
            if (handle.kind === 'directory') {
                await copyTree(handle as FileSystemDirectoryHandle, await to.getDirectoryHandle(name, { create: true }))
            } else {
                const bytes = await (handle as FileSystemFileHandle).getFile()
                const out = await (await to.getFileHandle(name, { create: true })).createWritable()
                await out.write(bytes)
                await out.close()
            }
        }
    }

    const forget = (prefix: string) => {
        for (const key of [...dirs.keys()]) {
            if (key === prefix || key.startsWith(`${prefix}/`)) dirs.delete(key)
        }
    }

    return {
        async readFile(path) {
            return decoder.decode(await read(path))
        },
        async writeFile(path, data) {
            await write(path, encoder.encode(data))
        },
        readBytes: read,
        writeBytes: write,

        async rename(oldPath, newPath) {
            const from = split(oldPath)
            const to = split(newPath)
            if (!from.clean || !to.clean) throw eisdir(from.clean ? newPath : oldPath)
            // Onto itself: nothing to do (taking the file's lock twice would
            // wait on itself forever).
            if (from.clean === to.clean) return
            const source = await entry(from.clean)
            if (!source) throw enoent(oldPath)
            const target = await dir(to.parent)
            const existing = await entry(to.clean)
            if (source.kind === 'file') {
                if (existing?.kind === 'directory') throw eisdir(newPath)
                await locked(from.clean, () =>
                    locked(to.clean, async () => {
                        if (existing) await target.removeEntry(to.name)
                        if (typeof (source as any).move === 'function') {
                            await (source as any).move(target, to.name)
                            return
                        }
                        const out = await (await target.getFileHandle(to.name, { create: true })).createWritable()
                        await out.write(await (source as FileSystemFileHandle).getFile())
                        await out.close()
                        await (await dir(from.parent)).removeEntry(from.name)
                    }),
                )
            } else {
                if (existing) throw Object.assign(new Error(`EEXIST: '${newPath}'`), { code: 'EEXIST' })
                // Not every browser moves a directory: copy the tree, then
                // remove the original and forget its handles.
                await copyTree(source as FileSystemDirectoryHandle, await target.getDirectoryHandle(to.name, { create: true }))
                await (await dir(from.parent)).removeEntry(from.name, { recursive: true })
                forget(from.clean)
            }
            emit('rename', from.clean)
            emit('rename', to.clean)
        },

        async mkdir(path, options) {
            const { parent, name, clean } = split(path)
            if (!clean) return
            const existing = await entry(clean)
            if (existing?.kind === 'file') throw Object.assign(new Error(`EEXIST: '${path}'`), { code: 'EEXIST' })
            if (existing) {
                if (options.recursive) return
                throw Object.assign(new Error(`EEXIST: '${path}'`), { code: 'EEXIST' })
            }
            if (options.recursive) await dir(clean, true)
            else dirs.set(clean, await (await dir(parent)).getDirectoryHandle(name, { create: true }))
            emit('rename', clean)
        },

        async readDir(path) {
            const handle = await dir(path)
            const out: [string, FileType][] = []
            for await (const [name, child] of (handle as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
                out.push([name, child.kind === 'directory' ? FileType.Directory : FileType.File])
            }
            return out
        },

        async exists(path) {
            return !!(await entry(path))
        },

        async stat(path): Promise<FileStat | null> {
            const handle = await entry(path)
            if (!handle) return null
            if (handle.kind === 'directory') return { name: path, type: FileType.Directory, size: 0 }
            const file = await (handle as FileSystemFileHandle).getFile()
            return { name: path, type: FileType.File, size: file.size, mtime: file.lastModified }
        },

        async unlink(path) {
            const { parent, name, clean } = split(path)
            const handle = await entry(clean)
            if (!handle) throw enoent(path)
            if (handle.kind === 'directory') throw eisdir(path)
            await locked(clean, async () => (await dir(parent)).removeEntry(name))
            emit('rename', clean)
        },

        async *watch(path, { signal }) {
            const scope = normalizePath(path)
            const queue: WatchEvent[] = []
            let wake: (() => void) | null = null
            const watcher = (event: WatchEvent) => {
                const full = event.filename
                if (scope && full !== scope && !full.startsWith(`${scope}/`)) return
                queue.push({ eventType: event.eventType, filename: scope ? full.slice(scope.length + 1) : full })
                wake?.()
            }
            watchers.add(watcher)
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
                watchers.delete(watcher)
                signal.removeEventListener('abort', onAbort)
            }
        },
    }
}

// ── Errors, in the shape the other stores throw ──────────────────────────────

function enoent(path: string): Error {
    return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' })
}

function eisdir(path: string): Error {
    return Object.assign(new Error(`EISDIR: '${path}'`), { code: 'EISDIR' })
}

function translate(error: unknown, path: string): Error {
    const name = (error as DOMException)?.name
    if (name === 'NotFoundError') return enoent(path)
    if (name === 'TypeMismatchError') return Object.assign(new Error(`ENOTDIR: '${path}'`), { code: 'ENOTDIR' })
    return error as Error
}
