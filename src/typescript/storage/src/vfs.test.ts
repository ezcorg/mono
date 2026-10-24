import { afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VfsInterface } from './vfs.js'
import { memoryVfs } from './memory.js'
import { nodeVfs } from './node.js'
import { describeVfs } from './testing/conformance.js'

// The contract (testing/conformance.ts), held against the stores that run in
// Node. The browser's are held to it in browser/*.browser.test.ts; Tauri's and
// icanhaz's by their own environments' tests.

const temps: string[] = []
afterAll(async () => {
    await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })))
})

const implementations: [string, () => Promise<VfsInterface>][] = [
    ['memory', async () => memoryVfs()],
    [
        'node',
        async () => {
            const dir = await mkdtemp(join(tmpdir(), 'storage-vfs-'))
            temps.push(dir)
            return nodeVfs(dir)
        },
    ],
]

for (const [name, make] of implementations) describeVfs(name, make)
