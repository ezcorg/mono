/**
 * The broker: one shared worker per origin, through which every page and
 * worker of the origin reaches the same vaults in the same store. One store
 * keeps OPFS access handles from colliding across tabs, and lets a write in
 * one tab reach a watch in another.
 *
 * The store is a dedicated worker lent by a page (`store.worker.ts`). Each
 * page registers a Web Lock it holds for as long as it lives; when the page
 * lending the store closes, its lock comes free here, another page is asked
 * for a store, and the vaults carry on there: calls in flight are repeated
 * where repeating is harmless (all but `rename` and `unlink`), and watches
 * resume.
 *
 * Without the OPFS (an insecure context) the vaults live here, in memory,
 * for as long as a page of the origin is open.
 *
 * Pages ask:
 *   hello(lock)                register a page and the lock it holds
 *   mount(name, snapshot?)     a port serving the vault `name`, the
 *                              snapshot restored into it first
 */
import { hasOpfs } from './opfs.js'
import { snapshotBytes, type SnapshotSource } from './snapshots.js'
import { memoryVfs } from '../memory.js'
import { DISCONNECTED, peer, remoteVfs, serveVfs, type Peer, type RemoteVfs } from '../remote.js'
import { restoreSnapshot } from '../snapshot.js'
import type { VfsInterface, WatchEvent } from '../vfs.js'

declare const self: { addEventListener(type: 'connect', listener: (event: MessageEvent) => void): void }

interface Page {
    control: Peer
    alive: boolean
    /** What it was given, closed with it (its watches stop). */
    served: Peer[]
}

interface Store {
    control: Peer
    host: Page
    vaults: Map<string, Promise<RemoteVfs>>
}

const pages: Page[] = []
let arrived: (() => void) | null = null
let store: Store | null = null
let recruiting: Promise<Store> | null = null

const opfs = hasOpfs()
const vaults = new Map<string, VfsInterface>()

self.addEventListener('connect', (event) => {
    const port = event.ports[0]
    const page: Page = { control: null!, alive: true, served: [] }
    page.control = peer(port, {
        hello: (lock: string | null) => hello(page, lock),
        mount: (name: string, snapshot?: SnapshotSource) => mount(page, name, snapshot),
    })
})

function hello(page: Page, lock: string | null): void {
    pages.push(page)
    arrived?.()
    // Granted only once the page has let go of it: when it has closed.
    if (lock && typeof navigator.locks?.request === 'function') {
        void navigator.locks.request(lock, () => gone(page))
    }
}

function gone(page: Page): void {
    page.alive = false
    if (pages.includes(page)) pages.splice(pages.indexOf(page), 1)
    page.control.close('the page closed')
    for (const served of page.served) served.close('the page closed')
    if (store?.host === page) {
        const lost = store
        store = null
        lost.control.close('the page lending the store closed')
        for (const fs of lost.vaults.values()) void fs.then((remote) => remote.close('the page lending the store closed'), () => {})
    }
}

/** The store, asking a page to lend one if there is none. */
function currentStore(): Promise<Store> {
    if (store) return Promise.resolve(store)
    recruiting ??= recruit().finally(() => (recruiting = null))
    return recruiting
}

async function recruit(): Promise<Store> {
    for (;;) {
        const host = pages.at(-1)
        if (!host) {
            await new Promise<void>((resolve) => (arrived = resolve))
            continue
        }
        try {
            const port = await host.control.call<MessagePort>('host')
            // The host may have closed while it answered.
            if (!host.alive) continue
            store = { control: peer(port), host, vaults: new Map() }
            return store
        } catch (error) {
            if ((error as { code?: string }).code !== DISCONNECTED) throw error
        }
    }
}

const disconnected = (error: unknown) => (error as { code?: string })?.code === DISCONNECTED

/** The vault `name` in whichever store is current. */
function brokered(name: string): VfsInterface {
    const current = async (): Promise<RemoteVfs> => {
        for (;;) {
            const s = await currentStore()
            let fs = s.vaults.get(name)
            if (!fs) {
                fs = s.control.call<MessagePort>('mount', name).then(remoteVfs)
                s.vaults.set(name, fs)
            }
            try {
                return await fs
            } catch (error) {
                if (s.vaults.get(name) === fs) s.vaults.delete(name)
                if (!disconnected(error)) throw error
            }
        }
    }
    /** Run `fn`; if the store goes meanwhile, again on the next one. */
    const again = async <T>(fn: (fs: RemoteVfs) => Promise<T>): Promise<T> => {
        for (;;) {
            try {
                return await fn(await current())
            } catch (error) {
                if (!disconnected(error)) throw error
            }
        }
    }
    const once = async <T>(fn: (fs: RemoteVfs) => Promise<T>): Promise<T> => fn(await current())

    return {
        readFile: (path) => again((fs) => fs.readFile(path)),
        writeFile: (path, data) => again((fs) => fs.writeFile(path, data)),
        readBytes: (path) => again((fs) => fs.readBytes(path)),
        writeBytes: (path, data) => again((fs) => fs.writeBytes(path, data)),
        mkdir: (path, options) => again((fs) => fs.mkdir(path, options)),
        readDir: (path) => again((fs) => fs.readDir(path)),
        exists: (path) => again((fs) => fs.exists(path)),
        stat: (path) => again((fs) => fs.stat(path)),
        // Whether these happened before the store went is unknown: the
        // caller hears of it.
        rename: (oldPath, newPath) => once((fs) => fs.rename(oldPath, newPath)),
        unlink: (path) => once((fs) => fs.unlink(path)),
        async *watch(path, { signal }): AsyncGenerator<WatchEvent> {
            while (!signal.aborted) {
                try {
                    const fs = await current()
                    yield* fs.watch(path, { signal })
                    return
                } catch (error) {
                    if (!disconnected(error)) throw error
                }
            }
        },
    }
}

function vaultNamed(name: string): VfsInterface {
    let fs = vaults.get(name)
    if (!fs) {
        fs = opfs ? brokered(name) : memoryVfs()
        vaults.set(name, fs)
    }
    return fs
}

async function mount(page: Page, name: string, snapshot?: SnapshotSource): Promise<MessagePort> {
    const fs = vaultNamed(name)
    if (snapshot) {
        if (opfs) {
            // Restored in the store itself, next to the files; watchers here
            // hear of each write from there.
            for (;;) {
                const s = await currentStore()
                try {
                    await s.control.call('restore', name, snapshot)
                    break
                } catch (error) {
                    if (!disconnected(error)) throw error
                }
            }
        } else {
            await restoreSnapshot(fs, await snapshotBytes(snapshot))
        }
    }
    const { port1, port2 } = new MessageChannel()
    page.served.push(serveVfs(fs, port1))
    return port2
}
