/**
 * A vault held in memory: every method of the contract, no persistence. For
 * tests, demos, and a scratch space before a real store is chosen.
 */
import { FileType, type FileStat, type VfsInterface, type WatchEvent } from './vfs'
import { normalizePath } from './path'

interface MemFile {
    kind: 'file'
    data: Uint8Array
    mtime: number
    ctime: number
}
interface MemDir {
    kind: 'dir'
    entries: Map<string, MemNode>
    mtime: number
    ctime: number
}
type MemNode = MemFile | MemDir

function notFound(path: string): Error {
    return Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: 'ENOENT' })
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A new, empty in-memory vault; `files` seeds it (`{ 'notes/a.md': '# A' }`). */
export function memoryVfs(files: Record<string, string | Uint8Array> = {}): VfsInterface {
    const root: MemDir = { kind: 'dir', entries: new Map(), mtime: Date.now(), ctime: Date.now() }
    const watchers = new Set<(event: WatchEvent, path: string) => void>()
    // A clock that always moves forward, so two writes in one millisecond
    // still look like two versions to anything comparing mtimes.
    let last = 0
    const now = () => (last = Math.max(Date.now(), last + 1))

    const segments = (path: string) => normalizePath(path).split('/').filter(Boolean)

    const lookup = (path: string): MemNode | undefined => {
        let node: MemNode = root
        for (const seg of segments(path)) {
            if (node.kind !== 'dir') return undefined
            const next = node.entries.get(seg)
            if (!next) return undefined
            node = next
        }
        return node
    }

    const parentOf = (path: string, create: boolean): { dir: MemDir; name: string } => {
        const segs = segments(path)
        const name = segs.pop()
        if (!name) throw new Error(`EISDIR: the vault root, '${path}'`)
        let dir = root
        for (const seg of segs) {
            let next = dir.entries.get(seg)
            if (!next) {
                if (!create) throw notFound(path)
                next = { kind: 'dir', entries: new Map(), mtime: now(), ctime: now() }
                dir.entries.set(seg, next)
            }
            if (next.kind !== 'dir') throw new Error(`ENOTDIR: '${path}'`)
            dir = next
        }
        return { dir, name }
    }

    const emit = (eventType: WatchEvent['eventType'], path: string) => {
        const clean = normalizePath(path)
        for (const w of watchers) w({ eventType, filename: clean }, clean)
    }

    const put = (path: string, data: Uint8Array) => {
        const { dir, name } = parentOf(path, false)
        const existing = dir.entries.get(name)
        if (existing?.kind === 'dir') throw new Error(`EISDIR: '${path}'`)
        const t = now()
        dir.entries.set(name, { kind: 'file', data: data.slice(), mtime: t, ctime: existing?.ctime ?? t })
        dir.mtime = t
        emit(existing ? 'change' : 'rename', path)
    }

    const readFileNode = (path: string): MemFile => {
        const node = lookup(path)
        if (!node) throw notFound(path)
        if (node.kind !== 'file') throw new Error(`EISDIR: '${path}'`)
        return node
    }

    const vfs: VfsInterface = {
        async readFile(path) {
            return decoder.decode(readFileNode(path).data)
        },
        async writeFile(path, data) {
            put(path, encoder.encode(data))
        },
        async readBytes(path) {
            return readFileNode(path).data.slice()
        },
        async writeBytes(path, data) {
            put(path, data)
        },
        async rename(oldPath, newPath) {
            const from = parentOf(oldPath, false)
            const node = from.dir.entries.get(from.name)
            if (!node) throw notFound(oldPath)
            const to = parentOf(newPath, false)
            const existing = to.dir.entries.get(to.name)
            if (existing?.kind === 'dir' && node.kind === 'file') throw new Error(`EISDIR: '${newPath}'`)
            from.dir.entries.delete(from.name)
            to.dir.entries.set(to.name, node)
            from.dir.mtime = to.dir.mtime = now()
            emit('rename', oldPath)
            emit('rename', newPath)
        },
        async mkdir(path, options) {
            if (!segments(path).length) return
            if (options.recursive) {
                const { dir, name } = parentOf(path, true)
                const existing = dir.entries.get(name)
                if (existing?.kind === 'file') throw new Error(`EEXIST: '${path}'`)
                if (!existing) {
                    dir.entries.set(name, { kind: 'dir', entries: new Map(), mtime: now(), ctime: now() })
                    emit('rename', path)
                }
                return
            }
            const { dir, name } = parentOf(path, false)
            if (dir.entries.has(name)) throw new Error(`EEXIST: '${path}'`)
            dir.entries.set(name, { kind: 'dir', entries: new Map(), mtime: now(), ctime: now() })
            emit('rename', path)
        },
        async readDir(path) {
            const node = lookup(path)
            if (!node) throw notFound(path)
            if (node.kind !== 'dir') throw new Error(`ENOTDIR: '${path}'`)
            return [...node.entries].map(([name, child]): [string, FileType] => [
                name,
                child.kind === 'dir' ? FileType.Directory : FileType.File,
            ])
        },
        async exists(path) {
            return lookup(path) !== undefined
        },
        async stat(path): Promise<FileStat | null> {
            const node = lookup(path)
            if (!node) return null
            return {
                name: path,
                type: node.kind === 'dir' ? FileType.Directory : FileType.File,
                size: node.kind === 'file' ? node.data.byteLength : 0,
                mtime: node.mtime,
                ctime: node.ctime,
            }
        },
        async unlink(path) {
            const { dir, name } = parentOf(path, false)
            const node = dir.entries.get(name)
            if (!node) throw notFound(path)
            if (node.kind === 'dir') throw new Error(`EISDIR: '${path}'`)
            dir.entries.delete(name)
            dir.mtime = now()
            emit('rename', path)
        },
        async *watch(path, { signal }) {
            const scope = normalizePath(path)
            const queue: WatchEvent[] = []
            let wake: (() => void) | null = null
            const listener = (event: WatchEvent, full: string) => {
                if (scope && full !== scope && !full.startsWith(`${scope}/`)) return
                queue.push({ eventType: event.eventType, filename: scope ? full.slice(scope.length + 1) : full })
                wake?.()
            }
            watchers.add(listener)
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
                watchers.delete(listener)
                signal.removeEventListener('abort', onAbort)
            }
        },
    }

    for (const [path, content] of Object.entries(files)) {
        parentOf(path, true)
        put(path, typeof content === 'string' ? encoder.encode(content) : content)
    }
    return vfs
}
