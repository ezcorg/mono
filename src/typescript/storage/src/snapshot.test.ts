import { describe, expect, it } from 'vitest'
import { decodeCbor, encodeCbor } from './cbor.js'
import { memoryVfs } from './memory.js'
import { restoreSnapshot, takeSnapshot } from './snapshot.js'
import { FileType, walk, type VfsInterface } from './vfs.js'

async function contents(fs: VfsInterface): Promise<Record<string, number[]>> {
    const out: Record<string, number[]> = {}
    for await (const path of walk(fs, '/')) out[path] = [...(await fs.readBytes(path))]
    return out
}

describe('Snapshots', () => {
    it('carry a vault into another store byte for byte, gzipped', async () => {
        // Text, bytes that are not text, and a hidden folder.
        const source = memoryVfs({
            'index.md': '# Index\n\n[[projects/plan]]\n',
            'projects/plan.md': '# Plan\n\n![[attachments/diagram.png]]\n',
            'attachments/diagram.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 0x0d, 0x0a]),
            '.obsidian/app.json': '{}',
        })
        const snapshot = await takeSnapshot(source)
        expect([snapshot[0], snapshot[1]]).toEqual([0x1f, 0x8b])
        const target = memoryVfs()
        const written = await restoreSnapshot(target, snapshot)
        const expected = await contents(source)
        expect(written).toBe(Object.keys(expected).length)
        expect(await contents(target)).toEqual(expected)
        // The image stays bytes.
        expect(Object.keys(expected)).toContain('/attachments/diagram.png')
    })

    it('leave out what the filter does, without reading into it', async () => {
        const read: string[] = []
        const source = memoryVfs({ 'a.md': 'a', '.obsidian/app.json': '{}', 'deep/b.md': 'b', 'deep/c.txt': 'c' })
        const spy: VfsInterface = { ...source, readDir: (path) => (read.push(path), source.readDir(path)) }
        const snapshot = await takeSnapshot(spy, {
            filter: (path, type) => !path.startsWith('.') && (type === FileType.Directory || path.endsWith('.md')),
        })
        const target = memoryVfs()
        await restoreSnapshot(target, snapshot)
        expect(Object.keys(await contents(target)).sort()).toEqual(['/a.md', '/deep/b.md'])
        expect(read).not.toContain('.obsidian')
    })

    it('restore under a folder, replacing files that are there and keeping the rest', async () => {
        const snapshot = await takeSnapshot(memoryVfs({ 'x.md': 'new', 'sub/y.md': 'y' }))
        const target = memoryVfs({ 'into/x.md': 'old', 'into/keep.md': 'keep' })
        await restoreSnapshot(target, snapshot, { path: 'into' })
        expect(await target.readFile('into/x.md')).toBe('new')
        expect(await target.readFile('into/sub/y.md')).toBe('y')
        expect(await target.readFile('into/keep.md')).toBe('keep')
    })

    it('read an uncompressed snapshot too', async () => {
        const tree = [0, {}, { 'n.md': [1, {}, new TextEncoder().encode('note')] }]
        const target = memoryVfs()
        await restoreSnapshot(target, encodeCbor(tree))
        expect(await target.readFile('n.md')).toBe('note')
    })
})

describe('CBOR', () => {
    const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((b) => parseInt(b, 16)))

    it('round-trips what snapshots hold', () => {
        const value = {
            n: [0, 23, 24, 255, 256, 65535, 65536, 2 ** 32, 2 ** 40, -1, -500, 1.5, -0.25],
            s: ['', 'a', 'Café ✓', 'x'.repeat(300)],
            b: new Uint8Array([0, 1, 254, 255]),
            misc: [null, true, false, [], {}],
        }
        expect(decodeCbor(encodeCbor(value))).toEqual(value)
    })

    // Items from RFC 8949 Appendix A that other encoders write.
    it.each([
        ['f93c00', 1],
        ['f97bff', 65504],
        ['fa47c35000', 100000],
        ['c11a514b67b0', 1363896240], // a tag, read through
        ['5f42010243030405ff', new Uint8Array([1, 2, 3, 4, 5])],
        ['7f657374726561646d696e67ff', 'streaming'],
        ['9f018202039f0405ffff', [1, [2, 3], [4, 5]]],
        ['bf61610161629f0203ffff', { a: 1, b: [2, 3] }],
        ['1b000000e8d4a51000', 1000000000000],
    ])('reads %s', (bytes, expected) => {
        expect(decodeCbor(hex(bytes))).toEqual(expected)
    })

    it('says when the data ends early', () => {
        expect(() => decodeCbor(hex('83010203').slice(0, 3))).toThrow(/truncated/)
    })
})
