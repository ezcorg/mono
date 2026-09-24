/**
 * The store: a dedicated worker holding vaults in the OPFS (in memory where
 * there is none). Only a dedicated worker gets synchronous access handles,
 * and Chromium lets no shared worker start one, so a page starts this and,
 * when asked, lends it to the origin's broker (`shared.worker.ts`).
 *
 * It answers, on its own scope and on every port it hands out:
 *   connect()                  another port answering the same
 *   mount(name, snapshot?)     a port serving the vault `name`, the
 *                              snapshot restored into it first
 *   restore(name, snapshot)    restore a snapshot into the vault `name`
 */
import { hasOpfs, opfsBucket, opfsVfs } from './opfs.js'
import { snapshotBytes, type SnapshotSource } from './snapshots.js'
import { memoryVfs } from '../memory.js'
import { peer, serveVfs, type PortLike } from '../remote.js'
import { restoreSnapshot } from '../snapshot.js'
import type { VfsInterface } from '../vfs.js'

const vaults = new Map<string, Promise<VfsInterface>>()

/** One instance per vault, so every port sees the others' writes. */
function vault(name: string): Promise<VfsInterface> {
    let fs = vaults.get(name)
    if (!fs) {
        fs = hasOpfs() ? opfsBucket(name).then(opfsVfs) : Promise.resolve(memoryVfs())
        vaults.set(name, fs)
    }
    return fs
}

async function restore(name: string, snapshot: SnapshotSource): Promise<number> {
    return restoreSnapshot(await vault(name), await snapshotBytes(snapshot))
}

const handlers = {
    connect(): MessagePort {
        const { port1, port2 } = new MessageChannel()
        peer(port1, handlers)
        return port2
    },
    async mount(name: string, snapshot?: SnapshotSource): Promise<MessagePort> {
        const fs = await vault(name)
        if (snapshot) await restore(name, snapshot)
        const { port1, port2 } = new MessageChannel()
        serveVfs(fs, port1)
        return port2
    },
    restore,
}

peer(self as unknown as PortLike, handlers)
