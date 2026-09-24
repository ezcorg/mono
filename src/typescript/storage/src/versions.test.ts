import { describe, expect, it } from 'vitest'
import { memoryVfs } from './memory.js'
import { VersionLog, conflictCopyPath, type FileVersion } from './versions.js'
import { Vault } from './vault.js'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

describe('A file’s version log', () => {
    it('writes on the current version and refuses a stale one, keeping the loser as a conflict copy', async () => {
        const fs = memoryVfs({ 'notes/plan.md': 'v1' })
        const log = new VersionLog(fs)
        const v1 = (await log.head('notes/plan.md'))!
        expect(v1).toMatchObject({ path: 'notes/plan.md', parents: [], size: 2 })

        const v2 = await log.put('notes/plan.md', v1.id, 'v2')
        expect(v2.ok).toBe(true)
        expect(await fs.readFile('notes/plan.md')).toBe('v2')

        const stale = await log.put('notes/plan.md', v1.id, 'v2, written elsewhere')
        if (stale.ok || !v2.ok) throw new Error('expected a refusal after a write')
        expect(stale.head?.id).toBe(v2.version.id)
        expect(stale.conflict.path).toMatch(/^notes\/plan \(conflict, \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\)\.md$/)
        expect(await fs.readFile(stale.conflict.path)).toBe('v2, written elsewhere')
        expect(stale.conflict.version.parents).toEqual([v1.id])
        // The file itself is the winner's.
        expect(await fs.readFile('notes/plan.md')).toBe('v2')
        // Another loser gets a name of its own.
        const again = await log.put('notes/plan.md', v1.id, 'and again')
        if (again.ok) throw new Error('expected a refusal')
        expect(again.conflict.path).not.toBe(stale.conflict.path)
    })

    it('names a conflict copy the same way for anything that keeps one, with a log or without', async () => {
        const fs = memoryVfs({ 'src/lib.rs': 'fn main() {}' })
        const when = new Date(2026, 8, 23, 12, 4).getTime()
        const first = await conflictCopyPath(fs, 'src/lib.rs', { when })
        expect(first).toBe('src/lib (conflict, 2026-09-23 12.04).rs')
        await fs.writeFile(first, 'lost')
        expect(await conflictCopyPath(fs, 'src/lib.rs', { when })).toBe('src/lib (conflict, 2026-09-23 12.04 2).rs')
        expect(await conflictCopyPath(fs, 'Makefile', { when, who: 'laptop' })).toBe('Makefile (laptop, 2026-09-23 12.04)')
    })

    it('takes a change made outside it (an editor, git) for a version on the one before', async () => {
        const fs = memoryVfs({ 'a.md': 'one' })
        const log = new VersionLog(fs)
        const v1 = (await log.head('a.md'))!
        const v2 = await log.put('a.md', v1.id, 'two')
        if (!v2.ok) throw new Error('expected a write')
        await fs.writeFile('a.md', 'three, from vim')
        const v3 = (await log.head('a.md'))!
        expect(v3.parents).toEqual([v2.version.id])
        expect((await log.history('a.md')).map((v) => v.id)).toEqual([v3.id, v2.version.id, v1.id])
        expect(text(await log.read(v1))).toBe('one')
        // A write on what it last saw is now stale.
        expect((await log.put('a.md', v2.version.id, 'four')).ok).toBe(false)
        expect((await log.put('a.md', v3.id, 'four')).ok).toBe(true)
    })

    it('creates a file on no version, and refuses that once the file exists', async () => {
        const fs = memoryVfs()
        const log = new VersionLog(fs)
        expect(await log.head('new.md')).toBeNull()
        const created = await log.put('new.md', null, 'hello')
        expect(created.ok).toBe(true)
        expect(await fs.readFile('new.md')).toBe('hello')
        expect((await log.put('new.md', null, 'another hello')).ok).toBe(false)
    })

    it('gives a revert a version of its own, and writing what is there none', async () => {
        const fs = memoryVfs({ 'a.md': 'A' })
        const log = new VersionLog(fs)
        const a = (await log.head('a.md'))!
        const b = await log.put('a.md', a.id, 'B')
        if (!b.ok) throw new Error('expected a write')
        const back = await log.put('a.md', b.version.id, 'A')
        if (!back.ok) throw new Error('expected a write')
        expect(back.version.id).not.toBe(a.id)
        expect(back.version.content).toBe(a.content)
        const same = await log.put('a.md', back.version.id, 'A')
        expect(same.ok && same.version.id).toBe(back.version.id)
        expect(await log.history('a.md')).toHaveLength(3)
    })

    it('keeps a file’s history when it moves', async () => {
        const fs = memoryVfs({ 'notes/plan.md': 'v1' })
        const log = new VersionLog(fs)
        const v1 = (await log.head('notes/plan.md'))!
        await fs.mkdir('archive', { recursive: true })
        await fs.rename('notes/plan.md', 'archive/plan.md')
        await log.move('notes/plan.md', 'archive/plan.md')
        const moved = await log.put('archive/plan.md', v1.id, 'v2')
        if (!moved.ok) throw new Error('expected a write')
        expect((await log.history('archive/plan.md')).map((v) => [v.path, v.id])).toEqual([
            ['archive/plan.md', moved.version.id],
            ['notes/plan.md', v1.id],
        ])
    })

    it('lets one of two writes on the same version win, the other becoming a conflict', async () => {
        const fs = memoryVfs({ 'a.md': 'base' })
        const log = new VersionLog(fs)
        const base = (await log.head('a.md'))!
        const results = await Promise.all([log.put('a.md', base.id, 'from the editor'), log.put('a.md', base.id, 'from an agent')])
        expect(results.filter((r) => r.ok)).toHaveLength(1)
        const lost = results.find((r) => !r.ok)
        if (!lost || lost.ok) throw new Error('expected a conflict')
        expect(await fs.readFile(lost.conflict.path)).toBe('from an agent')
    })

    it('signs what it records when given a signer', async () => {
        const signed: string[] = []
        const log = new VersionLog(memoryVfs(), {
            signer: {
                id: 'device-1',
                async sign(bytes) {
                    signed.push(text(bytes))
                    return new Uint8Array([1, 2, 3])
                },
            },
        })
        const result = await log.put('a.md', null, 'x')
        if (!result.ok) throw new Error('expected a write')
        expect(result.version).toMatchObject({ author: 'device-1', signature: 'AQID' })
        expect(signed).toEqual([result.version.id])
    })

    it('keeps its records in .eznote, out of the vault’s index', async () => {
        const vault = await Vault.open(memoryVfs({ 'a.md': '# A' }), { watch: false })
        const head = (await vault.versions.head('a.md')) as FileVersion
        await vault.versions.put('a.md', head.id, '# A, again')
        expect(await vault.fs.exists('.eznote/versions')).toBe(true)
        expect(vault.paths()).toEqual(['a.md'])
        // A write through the log reaches the index like any other.
        expect((await vault.search.search('again')).map((h) => h.path)).toEqual(['a.md'])
    })

    it('follows a file the vault renames', async () => {
        const vault = await Vault.open(memoryVfs({ 'a.md': '# A', 'b.md': 'See [[a]].' }), { watch: false })
        const head = (await vault.versions.head('a.md'))!
        await vault.rename('a.md', 'c.md')
        const next = await vault.versions.put('c.md', head.id, '# C')
        expect(next.ok).toBe(true)
        expect((await vault.versions.history('c.md')).map((v) => v.path)).toEqual(['c.md', 'a.md'])
    })
})
