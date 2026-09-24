import { describe, expect, it } from 'vitest'
import { dirname as nodeDirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Vault } from './vault'
import { memoryVfs } from './memory'
import { nodeVfs } from './node'
import { walk, type VfsInterface } from './vfs'
import { isNote, normalizePath } from './path'

const FIXTURE = join(nodeDirname(fileURLToPath(import.meta.url)), '__fixtures__', 'vault')

/** Every file of the fixture vault, dot-directories included, as bytes. */
async function fixtureFiles(): Promise<Record<string, Uint8Array>> {
    const disk = nodeVfs(FIXTURE)
    const out: Record<string, Uint8Array> = {}
    for await (const rooted of walk(disk, '/')) out[normalizePath(rooted)] = await disk.readBytes(rooted)
    return out
}

/** A writable copy of the fixture vault, in memory. */
async function fixtureCopy(): Promise<VfsInterface> {
    return memoryVfs(await fixtureFiles())
}

/** What the index says about every note: backlinks per note, and the dangling links. */
async function snapshot(vault: Vault) {
    const notes = vault.files().filter(isNote)
    return {
        files: vault.files(),
        backlinks: Object.fromEntries(notes.map((n) => [n, vault.backlinks(n)])),
        unresolved: vault.unresolved(),
    }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('the link index, rebuilt from a fixture vault', () => {
    it('knows every file, what links where, and what points nowhere', async () => {
        const vault = await Vault.open(nodeVfs(FIXTURE), { watch: false })
        expect(vault.files()).toEqual([
            'archive/2025/plan.md',
            'attachments/diagram.png',
            'index.md',
            'projects/plan.md',
            'projects/roadmap.md',
        ])
        expect(vault.backlinks('index.md')).toEqual([
            { source: 'archive/2025/plan.md', target: 'index.md', line: 3 },
            { source: 'projects/plan.md', target: 'index.md', line: 5 },
            { source: 'projects/plan.md', target: 'index.md', line: 5 },
        ])
        expect(vault.backlinks('projects/plan.md')).toEqual([
            { source: 'index.md', target: 'projects/plan.md', line: 3 },
            { source: 'index.md', target: 'projects/plan.md', line: 7 },
            { source: 'index.md', target: 'projects/plan.md', line: 7 },
            { source: 'projects/roadmap.md', target: 'projects/plan.md', line: 3 },
        ])
        expect(vault.backlinks('archive/2025/plan.md').map((l) => l.source)).toEqual(['projects/roadmap.md'])
        expect(vault.backlinks('projects/roadmap.md').map((l) => l.source)).toEqual(['index.md', 'projects/plan.md'])
        expect(vault.backlinks('attachments/diagram.png').map((l) => l.line)).toEqual([9, 9])
        expect(vault.unresolved()).toEqual([
            { source: 'index.md', target: 'missing note.md', line: 7 },
            { source: 'projects/plan.md', target: 'projects/ghost.md', line: 7 },
        ])
        vault.close()
    })

    it('reaches the same index incrementally, one write at a time, targets last', async () => {
        const rebuilt = await Vault.open(nodeVfs(FIXTURE), { watch: false })
        const vault = await Vault.open(memoryVfs(), { watch: false })
        const files = Object.entries(await fixtureFiles()).reverse()
        for (const [path, bytes] of files) {
            const parent = path.split('/').slice(0, -1).join('/')
            if (parent) await vault.fs.mkdir(parent, { recursive: true })
            await vault.fs.writeBytes(path, bytes)
        }
        expect(await snapshot(vault)).toEqual(await snapshot(rebuilt))
        // And the index a fresh walk of that vault builds agrees with both.
        await vault.rebuild()
        expect(await snapshot(vault)).toEqual(await snapshot(rebuilt))
    })

    it('resolves and suggests the way the index counts', async () => {
        const vault = await Vault.open(nodeVfs(FIXTURE), { watch: false })
        expect(await vault.links.resolve('plan', 'index.md')).toEqual({ path: 'projects/plan.md', exists: true })
        expect(await vault.links.resolve('ghost', 'projects/plan.md')).toEqual({ path: 'projects/ghost.md', exists: false })
        expect(await vault.links.resolve('roadmap', 'projects/plan.md', 'markdown')).toEqual({
            path: 'projects/roadmap.md',
            exists: true,
        })
        const suggestions = await vault.links.suggest!('pla', 'index.md')
        expect(suggestions.map((s) => [s.path, s.link])).toEqual([
            ['projects/plan.md', 'plan'],
            ['archive/2025/plan.md', '2025/plan'],
        ])
    })
})

describe('renaming keeps every link meaning what it meant', () => {
    it('rewrites links to a moved note, in the style they were written', async () => {
        const store = await fixtureCopy()
        const vault = await Vault.open(store, { watch: false })
        expect(await vault.links.rename('projects/plan.md', 'projects/planning.md')).toBe(4)
        const index = await store.readFile('index.md')
        expect(index).toContain('related: "[[projects/planning]]"')
        expect(index).toContain('See [[planning]] and [[planning#Goals|the goals]]')
        expect(await store.readFile('projects/roadmap.md')).toContain('First [[planning]], then [[archive/2025/plan]]')
        // The moved note's own links still lead where they did.
        const moved = await store.readFile('projects/planning.md')
        expect(moved).toContain('Back to [[index]]. See [the roadmap](roadmap.md) and [[../index#Index|home]].')
        expect(await vault.links.backlinks('projects/planning.md')).toHaveLength(4)
        expect(await vault.links.backlinks('projects/plan.md')).toEqual([])
    })

    it('moves a directory, rewriting paths into it and nothing that still resolves', async () => {
        const store = await fixtureCopy()
        const vault = await Vault.open(store, { watch: false })
        const before = await store.readFile('projects/plan.md')
        await vault.rename('projects', 'work')
        const index = await store.readFile('index.md')
        expect(index).toContain('related: "[[work/plan]]"')
        expect(index).toContain('See [[plan]] and [[Plan#Goals|the goals]], the [roadmap](work/roadmap.md)')
        expect(await store.readFile('work/plan.md')).toBe(before)
        expect(vault.files()).toContain('work/roadmap.md')
        expect(vault.backlinks('work/roadmap.md').map((l) => l.source)).toEqual(['index.md', 'work/plan.md'])
    })

    it('lengthens a wikilink the new name would otherwise capture', async () => {
        const store = await fixtureCopy()
        await store.mkdir('notes', { recursive: true })
        await store.writeFile('notes/x.md', 'Current: [[plan]]\n')
        const vault = await Vault.open(store, { watch: false })
        expect(vault.resolve('plan', 'notes/x.md')?.path).toBe('projects/plan.md')
        // The archived plan moves beside x.md, where `[[plan]]` would now find it.
        await vault.rename('archive/2025/plan.md', 'notes/plan.md')
        expect(await store.readFile('notes/x.md')).toBe('Current: [[projects/plan]]\n')
        expect(await store.readFile('projects/roadmap.md')).toContain('then [[notes/plan]]')
        expect(vault.resolve('projects/plan', 'notes/x.md')?.path).toBe('projects/plan.md')
    })

    it('moves an attachment, rewriting image paths and leaving name links that still resolve', async () => {
        const store = await fixtureCopy()
        const vault = await Vault.open(store, { watch: false })
        const bytes = await store.readBytes('attachments/diagram.png')
        await vault.rename('attachments/diagram.png', 'media/diagram.png')
        expect([...(await store.readBytes('media/diagram.png'))]).toEqual([...bytes])
        expect(await store.readFile('index.md')).toContain('![diagram](media/diagram.png) and an embed ![[diagram.png]]')
    })

    it('refuses to replace an existing file', async () => {
        const vault = await Vault.open(await fixtureCopy(), { watch: false })
        await expect(vault.rename('projects/plan.md', 'index.md')).rejects.toThrow(/exists/)
    })
})

describe('keeping current', () => {
    it('follows writes through vault.fs, and tells subscribers once per burst', async () => {
        const vault = await Vault.open(memoryVfs({ 'a.md': 'to [[b]]' }), { watch: false })
        let notified = 0
        vault.subscribe(() => notified++)
        expect(vault.unresolved().map((l) => l.target)).toEqual(['b.md'])
        await vault.fs.writeFile('b.md', '# B')
        await vault.fs.writeFile('c.md', 'also [[b]]')
        await tick()
        expect(notified).toBe(1)
        expect(vault.unresolved()).toEqual([])
        expect(vault.backlinks('b.md').map((l) => l.source)).toEqual(['a.md', 'c.md'])
        await vault.fs.unlink('b.md')
        expect(vault.unresolved().map((l) => l.source)).toEqual(['a.md', 'c.md'])
    })

    it('follows changes made outside it, through the store’s watch', async () => {
        const store = memoryVfs({ 'a.md': 'to [[b]]' })
        const vault = await Vault.open(store)
        const changed = new Promise<void>((resolve) => vault.subscribe(resolve))
        await store.writeFile('b.md', '# B')
        await changed
        expect(vault.backlinks('b.md').map((l) => l.source)).toEqual(['a.md'])
        vault.close()
    })

    it('leaves dot-directories out', async () => {
        const vault = await Vault.open(await fixtureCopy(), { watch: false })
        expect(vault.files().some((f) => f.startsWith('.obsidian'))).toBe(false)
        await vault.fs.mkdir('.eznote', { recursive: true })
        await vault.fs.writeFile('.eznote/state.md', '[[index]]')
        expect(vault.backlinks('index.md').some((l) => l.source.startsWith('.'))).toBe(false)
    })
})
