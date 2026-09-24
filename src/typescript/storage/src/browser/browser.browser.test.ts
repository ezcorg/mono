import { afterAll, describe, expect, it } from 'vitest'
import { browserVfs, opfsBucket, opfsVfs, removeOpfsBucket } from './index.js'
import { peer, type Peer } from '../remote.js'
import { memoryVfs } from '../memory.js'
import { takeSnapshot } from '../snapshot.js'
import { describeVfs } from '../testing/conformance.js'

let n = 0
const run = Date.now().toString(36)
const buckets: string[] = []
/** A bucket of its own for each vault a test opens. */
const fresh = (label: string) => {
    const name = `test-${run}-${label}-${n++}`
    buckets.push(name)
    return name
}

afterAll(async () => {
    await Promise.all(buckets.map(removeOpfsBucket))
})

// First, while no page of this origin has opened a vault: which page lends
// the store is then known, and the failover can be watched happening.
describe('The origin’s broker', () => {
    /** A page of this origin in an iframe, driven over a port. `hosted`
     *  says whether it has started a store worker (lent one to the broker). */
    async function page(): Promise<{ frame: HTMLIFrameElement; call: Peer['call'] }> {
        const index = new URL('./index.ts', import.meta.url).href
        const remote = new URL('../remote.ts', import.meta.url).href
        const frame = document.createElement('iframe')
        frame.srcdoc = `<script type="module">
            let hosted = false
            const Original = Worker
            window.Worker = class extends Original {
                constructor(...args) { super(...args); hosted = true }
            }
            const { browserVfs } = await import(${JSON.stringify(index)})
            const { peer } = await import(${JSON.stringify(remote)})
            const vaults = new Map()
            const heard = []
            window.addEventListener('message', (event) => {
                peer(event.ports[0], {
                    hosted: () => hosted,
                    open: async (name) => { vaults.set(name, await browserVfs(name)) },
                    read: (name, path) => vaults.get(name).readFile(path),
                    write: (name, path, text) => vaults.get(name).writeFile(path, text),
                    watch: (name) => {
                        void (async () => {
                            for await (const e of vaults.get(name).watch('', { signal: new AbortController().signal })) heard.push(e.filename)
                        })()
                    },
                    heard: () => heard,
                })
            })
            parent.postMessage('loaded', '*')
        </script>`
        const loaded = new Promise<void>((resolve) => {
            const onMessage = (event: MessageEvent) => {
                if (event.source !== frame.contentWindow || event.data !== 'loaded') return
                window.removeEventListener('message', onMessage)
                resolve()
            }
            window.addEventListener('message', onMessage)
        })
        document.body.append(frame)
        await loaded
        const { port1, port2 } = new MessageChannel()
        frame.contentWindow!.postMessage('port', '*', [port2])
        const control = peer(port1)
        return { frame, call: control.call }
    }

    it('keeps a vault going when the page lending the store closes', async () => {
        const name = fresh('failover')
        const a = await page()
        await a.call('open', name)
        // Opening is lazy: the first call is what has the broker ask for a store.
        await a.call('write', name, 'from-a.md', 'a')
        const b = await page()
        await b.call('open', name)
        expect(await a.call('hosted')).toBe(true)
        expect(await b.call('hosted')).toBe(false)

        await b.call('write', name, 'before.md', 'written through a’s store')
        expect(await a.call('read', name, 'before.md')).toBe('written through a’s store')
        await b.call('watch', name)
        await b.call('write', name, 'heard-1.md', '1')
        await until(async () => ((await b.call('heard')) as string[]).includes('heard-1.md'))

        a.frame.remove()

        // b lends the next store, and its files and its watch carry on.
        expect(await b.call('read', name, 'before.md')).toBe('written through a’s store')
        expect(await b.call('hosted')).toBe(true)
        await b.call('write', name, 'heard-2.md', '2')
        await until(async () => ((await b.call('heard')) as string[]).includes('heard-2.md'))
        b.frame.remove()
    })
})

describeVfs('opfs (this thread)', async () => opfsVfs(await opfsBucket(fresh('opfs'))))
describeVfs('browser (broker and store workers)', () => browserVfs(fresh('browser')))

describe('Browser vaults', () => {
    it('are one vault to every connection of a name: files and watches', async () => {
        const name = fresh('shared')
        const one = await browserVfs(name)
        const two = await browserVfs(name)
        const controller = new AbortController()
        const heard: string[] = []
        const watching = (async () => {
            for await (const event of one.watch('', { signal: controller.signal })) {
                heard.push(event.filename)
                if (event.filename === 'from-two.md') return
            }
        })()
        await two.writeFile('from-two.md', 'hello')
        await watching
        controller.abort()
        expect(await one.readFile('from-two.md')).toBe('hello')
        // Another name is another vault.
        expect(await (await browserVfs(fresh('other'))).exists('from-two.md')).toBe(false)
    })

    it('hand a worker a port of its own', async () => {
        const fs = await browserVfs(fresh('connect'))
        await fs.writeFile('lib.ts', 'export {}')
        const { remoteVfs } = await import('../remote.js')
        const direct = remoteVfs(await fs.connect())
        expect(await direct.readFile('lib.ts')).toBe('export {}')
    })

    it('open with a snapshot, as bytes or from a URL', async () => {
        const snapshot = await takeSnapshot(memoryVfs({ 'readme.md': '# Demo', 'img/dot.png': new Uint8Array([137, 80, 78, 71]) }))
        const fromBytes = await browserVfs(fresh('snap-bytes'), { snapshot })
        expect(await fromBytes.readFile('readme.md')).toBe('# Demo')
        expect([...(await fromBytes.readBytes('img/dot.png'))]).toEqual([137, 80, 78, 71])

        const url = URL.createObjectURL(new Blob([snapshot as Uint8Array<ArrayBuffer>]))
        const name = fresh('snap-url')
        const first = await browserVfs(name, { snapshot: url })
        await first.writeFile('mine.md', 'kept')
        await first.writeFile('readme.md', 'edited')
        // Opening again restores the snapshot's files and leaves the rest.
        const again = await browserVfs(name, { snapshot: url })
        expect(await again.readFile('readme.md')).toBe('# Demo')
        expect(await again.readFile('mine.md')).toBe('kept')
        URL.revokeObjectURL(url)
    })

    it('persist: a vault opened again finds its files', async () => {
        const name = fresh('persist')
        await (await browserVfs(name)).writeFile('kept.md', 'still here')
        // Straight from the OPFS, bypassing the workers.
        expect(await opfsVfs(await opfsBucket(name)).readFile('kept.md')).toBe('still here')
    })
})

async function until(condition: () => Promise<boolean>, timeout = 3000): Promise<void> {
    const start = Date.now()
    while (!(await condition())) {
        if (Date.now() - start > timeout) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 20))
    }
}
