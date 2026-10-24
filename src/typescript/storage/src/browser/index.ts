/**
 * Storage in a browser: vaults in the Origin Private File System, kept off
 * the main thread and shared by every page and worker of an origin.
 *
 *     const fs = await browserVfs('notes')                  // a RemoteVfs
 *     const demo = await browserVfs('demo', { snapshot: '/snapshot.bin' })
 *     const vault = await Vault.open(fs)
 *
 * Page → shared worker (the broker, one per origin) → a dedicated worker
 * holding the files (the store, lent by a page; the only place synchronous
 * OPFS access exists). Where there is no shared worker the page talks to a
 * store of its own. Where there is no OPFS the vaults are in memory.
 */
import { peer, remoteVfs, type Peer, type RemoteVfs } from '../remote.js'

export { opfsVfs, opfsBucket, removeOpfsBucket, hasOpfs } from './opfs.js'

export interface BrowserVfsOptions {
    /**
     * Files to put in the vault as it opens: a snapshot (`takeSnapshot`) or
     * the URL of one, fetched by the worker. Files at the same paths are
     * replaced; others are left alone. The snapshot restored last time,
     * unchanged since (the server's ETag or Last-Modified, else the bytes),
     * is neither fetched again nor written again: edits made to its files
     * meanwhile stay until the snapshot itself changes.
     */
    snapshot?: Uint8Array | string | URL
}

/**
 * The vault `name` of this origin: its own OPFS folder, reached through the
 * origin's shared worker, so every tab and worker (a language server given
 * `connect()`) reads and writes the same files and each one's `watch`
 * hears the others' writes.
 */
export async function browserVfs(name: string, options: BrowserVfsOptions = {}): Promise<RemoteVfs> {
    const { snapshot } = options
    const source = typeof snapshot === 'string' || snapshot instanceof URL ? new URL(snapshot, location.href).href : snapshot
    const port = await (await broker()).call<MessagePort>('mount', name, source)
    return remoteVfs(port)
}

let brokerPeer: Promise<Peer> | null = null
let storePeer: Peer | null = null

/** This page's way to the vaults: the origin's broker, or where there are
 *  no shared workers, a store of its own. */
function broker(): Promise<Peer> {
    brokerPeer ??= (async () => {
        if (typeof SharedWorker === 'undefined') return ownStore()
        const worker = new SharedWorker(new URL('./shared.worker.js', import.meta.url), {
            type: 'module',
            name: 'ezco-storage',
        })
        const control = peer(worker.port, {
            // The broker asks for a store when it has none (the first page
            // to open a vault, or when the page lending one closes).
            host: () => ownStore().call<MessagePort>('connect'),
        })
        await control.call('hello', await holdPageLock())
        return control
    })()
    return brokerPeer
}

function ownStore(): Peer {
    storePeer ??= peer(new Worker(new URL('./store.worker.js', import.meta.url), { type: 'module', name: 'ezco-storage-store' }))
    return storePeer
}

/** Take a lock this page holds until it closes, for the broker to learn
 *  when it has; null where there are no Web Locks. */
async function holdPageLock(): Promise<string | null> {
    if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') return null
    const name = `ezco-storage:page:${crypto.randomUUID()}`
    await new Promise<void>((held) => {
        void navigator.locks.request(name, () => {
            held()
            return new Promise<never>(() => {})
        })
    })
    return name
}
