/**
 * A snapshot as the workers are given one: its bytes, or a URL to fetch;
 * and restoring one into a vault only when it is not the one already
 * there.
 */
import { restoreSnapshot } from '../snapshot.js'
import type { VfsInterface } from '../vfs.js'

export type SnapshotSource = Uint8Array | string

/** Where a vault notes the snapshot last restored into it. */
const STAMP = '.vault/snapshot'

/** What tells a snapshot from the last one restored: where it came from,
 *  and the server's validator for it (an ETag, else Last-Modified), or a
 *  digest of its bytes when the server gives none, or it came as bytes. */
interface Stamp {
    source: string
    etag?: string
    modified?: string
    digest?: string
}

export async function snapshotBytes(source: SnapshotSource): Promise<Uint8Array> {
    if (typeof source !== 'string') return source
    const response = await fetch(source)
    if (!response.ok) throw new Error(`Could not fetch the snapshot ${source}: ${response.status} ${response.statusText}`)
    return new Uint8Array(await response.arrayBuffer())
}

/**
 * Restore `source` into `fs` unless it is the snapshot restored last time:
 * the vault keeps a stamp of that one, a URL is asked for conditionally
 * (`If-None-Match`, `If-Modified-Since`) and bytes are compared by digest,
 * so a page opened again neither fetches nor rewrites files that have not
 * changed, and edits made to them meanwhile stay. Resolves to the number
 * of files written (0: nothing changed).
 */
export async function restoreFresh(fs: VfsInterface, source: SnapshotSource): Promise<number> {
    const last = await readStamp(fs)
    const next: Stamp = { source: typeof source === 'string' ? source : 'bytes' }
    let bytes: Uint8Array
    if (typeof source === 'string') {
        const headers: Record<string, string> = {}
        if (last?.source === source) {
            if (last.etag) headers['If-None-Match'] = last.etag
            else if (last.modified) headers['If-Modified-Since'] = last.modified
        }
        const response = await fetch(source, { headers })
        if (response.status === 304) return 0
        if (!response.ok) throw new Error(`Could not fetch the snapshot ${source}: ${response.status} ${response.statusText}`)
        bytes = new Uint8Array(await response.arrayBuffer())
        const etag = response.headers.get('etag')
        const modified = response.headers.get('last-modified')
        if (etag) next.etag = etag
        else if (modified) next.modified = modified
        else next.digest = await digest(bytes)
    } else {
        bytes = source
        next.digest = await digest(bytes)
    }
    if (last && same(last, next)) return 0
    const written = await restoreSnapshot(fs, bytes)
    await writeStamp(fs, next)
    return written
}

const same = (a: Stamp, b: Stamp) =>
    a.source === b.source && ((!!a.etag && a.etag === b.etag) || (!!a.modified && a.modified === b.modified) || (!!a.digest && a.digest === b.digest))

async function readStamp(fs: VfsInterface): Promise<Stamp | null> {
    try {
        const parsed = JSON.parse(await fs.readFile(STAMP)) as unknown
        return parsed && typeof parsed === 'object' && typeof (parsed as Stamp).source === 'string' ? (parsed as Stamp) : null
    } catch {
        return null
    }
}

async function writeStamp(fs: VfsInterface, stamp: Stamp): Promise<void> {
    await fs.mkdir('.vault', { recursive: true }).catch(() => undefined)
    await fs.writeFile(STAMP, JSON.stringify(stamp))
}

/** SHA-256 of `bytes` as hex; a cheaper hash where the platform has no
 *  WebCrypto (an insecure origin). */
async function digest(bytes: Uint8Array): Promise<string> {
    const subtle = globalThis.crypto?.subtle
    if (subtle) {
        const hash = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
        return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')
    }
    let h = 0x811c9dc5
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0
    return `fnv:${h.toString(16)}:${bytes.length}`
}
