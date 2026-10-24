/**
 * Snapshots: a folder of files as one blob, to ship a vault with a page (a
 * demo, a template, a package's own sources) and restore it into any
 * `VfsInterface`.
 *
 * The format is memfs's: CBOR of `[0, meta, { name: node }]` for a folder
 * and `[1, meta, bytes]` for a file (`[2, { target }]`, a link, is read and
 * skipped), gzipped.
 */
import { decodeCbor, encodeCbor } from './cbor.js'
import { FileType, type VfsInterface } from './vfs.js'
import { normalizePath } from './path.js'

export type SnapshotNode =
    | [0, Record<string, unknown>, Record<string, SnapshotNode>]
    | [1, Record<string, unknown>, Uint8Array]
    | [2, { target: string }]

export interface TakeSnapshotOptions {
    /** The folder to take (default: the root). */
    path?: string
    /** Keep a file or folder (a vault path); a folder left out is not read. */
    filter?: (path: string, type: FileType) => boolean | Promise<boolean>
}

/** `path` of `fs` (every file under it, as bytes), encoded and gzipped. */
export async function takeSnapshot(fs: VfsInterface, options: TakeSnapshotOptions = {}): Promise<Uint8Array> {
    const { filter } = options
    const folder = async (dir: string): Promise<SnapshotNode> => {
        const entries: Record<string, SnapshotNode> = {}
        for (const [name, type] of (await fs.readDir(dir || '/')).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
            const path = dir ? `${dir}/${name}` : name
            if (filter && !(await filter(path, type))) continue
            if (type === FileType.Directory) entries[name] = await folder(path)
            else if (type === FileType.File) entries[name] = [1, {}, await fs.readBytes(path)]
        }
        return [0, {}, entries]
    }
    return gzip(encodeCbor(await folder(normalizePath(options.path ?? ''))))
}

/**
 * Write the files of `snapshot` into `fs` under `path` (default: the root),
 * creating folders as needed and replacing files that are there. Resolves
 * to the number of files written.
 */
export async function restoreSnapshot(fs: VfsInterface, snapshot: Uint8Array, options: { path?: string } = {}): Promise<number> {
    const tree = decodeCbor(await gunzip(snapshot)) as SnapshotNode | null
    let written = 0
    const restore = async (node: SnapshotNode, path: string): Promise<void> => {
        if (node[0] === 0) {
            if (path) await fs.mkdir(path, { recursive: true })
            for (const [name, child] of Object.entries(node[2])) {
                if (child) await restore(child, path ? `${path}/${name}` : name)
            }
        } else if (node[0] === 1 && path) {
            await fs.writeBytes(path, node[2])
            written++
        }
    }
    if (tree) await restore(tree, normalizePath(options.path ?? ''))
    return written
}

// ── Compression, where the platform has it (browsers, Node 18+, Deno) ────────

const isGzip = (data: Uint8Array) => data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b

async function gzip(data: Uint8Array): Promise<Uint8Array> {
    if (typeof CompressionStream === 'undefined') return data
    return pipe(data, new CompressionStream('gzip'))
}

/** `data` unzipped; data that is not gzip is returned as it is. */
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
    if (!isGzip(data)) return data
    if (typeof DecompressionStream === 'undefined') throw new Error('This platform cannot read a gzipped snapshot')
    return pipe(data, new DecompressionStream('gzip'))
}

async function pipe(data: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform)
    return new Uint8Array(await new Response(stream).arrayBuffer())
}
