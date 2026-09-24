import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryVfs } from './memory.js'
import { nodeVfs } from './node.js'
import { DISCONNECTED, peer, remoteVfs, serveVfs, streaming, vfsPort, type RemoteVfs } from './remote.js'
import { describeVfs } from './testing/conformance.js'
import type { VfsInterface } from './vfs.js'

const temps: string[] = []
afterAll(async () => {
    await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })))
})

/** `fs` as a worker would see it: served on one end of a channel. */
function remote(fs: VfsInterface): RemoteVfs {
    const { port1, port2 } = new MessageChannel()
    serveVfs(fs, port1)
    return remoteVfs(port2)
}

describeVfs('remote (memory)', async () => remote(memoryVfs()))
describeVfs('remote (node)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'storage-remote-'))
    temps.push(dir)
    return remote(nodeVfs(dir))
})

describe('A filesystem over a port', () => {
    it('keeps the kind of an error', async () => {
        const fs = remote(memoryVfs())
        const error = await fs.readFile('missing.md').catch((e) => e)
        expect(error).toBeInstanceOf(Error)
        expect(error.code).toBe('ENOENT')
        expect(error.message).toMatch(/missing\.md/)
    })

    it('hands out more ports to the same files, each hearing the others', async () => {
        const fs = remote(memoryVfs({ 'a.md': 'a' }))
        const again = remoteVfs(await fs.connect())
        const controller = new AbortController()
        const heard: string[] = []
        const watching = (async () => {
            for await (const event of fs.watch('', { signal: controller.signal })) {
                heard.push(event.filename)
                if (event.filename === 'b.md') return
            }
        })()
        await again.writeFile('b.md', 'b')
        await watching
        controller.abort()
        expect(await fs.readFile('b.md')).toBe('b')
        expect(heard).toEqual(['b.md'])
    })

    it('stops the watch on the serving side when the reader stops', async () => {
        let armed = 0
        let stopped = 0
        const watched: VfsInterface = {
            ...memoryVfs(),
            async *watch(_path, { signal }) {
                armed++
                // Waits for an event that never comes, as a quiet folder does.
                await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
                stopped++
            },
        }
        const fs = remote(watched)
        const controller = new AbortController()
        const reading = (async () => {
            for await (const _ of fs.watch('', { signal: controller.signal })) void _
        })()
        await waitUntil(() => armed === 1)
        controller.abort()
        await reading
        await waitUntil(() => stopped === 1)
    })

    it('fails calls in flight and ends watches when it hangs up', async () => {
        let release!: () => void
        const slow: VfsInterface = {
            ...memoryVfs(),
            readFile: () => new Promise<string>((resolve) => (release = () => resolve('late'))),
        }
        const fs = remote(slow)
        const reading = fs.readFile('x.md')
        const watching = (async () => {
            for await (const _ of fs.watch('', { signal: new AbortController().signal })) void _
        })()
        await waitUntil(() => !!release)
        fs.close('gone')
        await expect(reading).rejects.toMatchObject({ code: DISCONNECTED, message: 'gone' })
        await expect(watching).rejects.toMatchObject({ code: DISCONNECTED })
        await expect(fs.stat('x.md')).rejects.toMatchObject({ code: DISCONNECTED })
        release()
    })

    it('gives a port to any filesystem, serving a local one from here', async () => {
        const local = memoryVfs({ 'n.md': 'note' })
        const fs = remoteVfs(await vfsPort(local))
        expect(await fs.readFile('n.md')).toBe('note')
        // A remote one is asked for a port of its own instead.
        const direct = remoteVfs(await vfsPort(fs))
        await direct.writeFile('m.md', 'more')
        expect(await local.readFile('m.md')).toBe('more')
    })
})

describe('Peers', () => {
    it('call each other on one port, both ways at once', async () => {
        const { port1, port2 } = new MessageChannel()
        const a = peer(port1, { name: () => 'a', add: (x: number, y: number) => x + y })
        const b = peer(port2, { name: () => 'b' })
        expect(await b.call('name')).toBe('a')
        expect(await a.call('name')).toBe('b')
        expect(await b.call('add', 2, 3)).toBe(5)
        await expect(a.call('add', 1, 1)).rejects.toThrow(/No method 'add'/)
    })

    it('stream until the reader stops', async () => {
        const { port1, port2 } = new MessageChannel()
        peer(port1, {
            count: streaming(async function* (signal, upTo: number) {
                for (let i = 1; i <= upTo && !signal.aborted; i++) yield i
            }),
        })
        const client = peer(port2)
        const got: number[] = []
        for await (const n of client.stream<number>('count', [5], new AbortController().signal)) got.push(n)
        expect(got).toEqual([1, 2, 3, 4, 5])
    })
})

async function waitUntil(condition: () => boolean, timeout = 2000): Promise<void> {
    const start = Date.now()
    while (!condition()) {
        if (Date.now() - start > timeout) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 5))
    }
}
