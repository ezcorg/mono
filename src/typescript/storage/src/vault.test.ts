import { describe, expect, it } from 'vitest'
import { dirname as nodeDirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Vault } from './vault.js'
import { fileOperations } from './files.js'
import { memoryVfs } from './memory.js'
import { nodeVfs } from './node.js'
import { walk, type VfsInterface } from './vfs.js'
import { isNote, normalizePath } from './path.js'
import { caseInsensitive } from './testing/case-insensitive.js'

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
    const notes = vault.paths().filter(isNote)
    return {
        files: vault.paths(),
        backlinks: Object.fromEntries(notes.map((n) => [n, vault.backlinks(n)])),
        unresolved: vault.unresolved(),
    }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('the link index, rebuilt from a fixture vault', () => {
    it('knows every file, what links where, and what points nowhere', async () => {
        const vault = await Vault.open(nodeVfs(FIXTURE), { watch: false })
        expect(vault.paths()).toEqual([
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
        expect(vault.paths()).toContain('work/roadmap.md')
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

    it('moves a note whose link wraps an image, fixing both paths', async () => {
        const store = memoryVfs({
            'a/n.md': 'See [![thumb](thumb.png)](full.png) end\n',
            'a/thumb.png': new Uint8Array([1]),
            'a/full.png': new Uint8Array([2]),
        })
        await store.mkdir('b', { recursive: true })
        const vault = await Vault.open(store, { watch: false })
        await vault.rename('a/n.md', 'b/n.md')
        expect(await store.readFile('b/n.md')).toBe('See [![thumb](../a/thumb.png)](../a/full.png) end\n')
    })

    it('counts and rewrites links written with escapes: aliases in tables, parentheses in paths', async () => {
        const store = memoryVfs({
            'Meeting (2026).md': '# Meeting',
            'plan.md': '# Plan',
            'index.md': '| note | link |\n|---|---|\n| p | [[plan\\|The plan]] |\n\nSee [m](Meeting%20\\(2026\\).md).\n',
        })
        const vault = await Vault.open(store, { watch: false })
        expect(vault.backlinks('plan.md').map((l) => l.source)).toEqual(['index.md'])
        expect(vault.backlinks('Meeting (2026).md').map((l) => l.source)).toEqual(['index.md'])
        expect(vault.unresolved()).toEqual([])
        await vault.rename('plan.md', 'next.md')
        await vault.rename('Meeting (2026).md', 'Meeting 2026.md')
        const index = await store.readFile('index.md')
        expect(index).toContain('| p | [[next\\|The plan]] |')
        expect(index).toContain('See [m](Meeting%202026.md).')
    })

    it('renames a note to another spelling of its name on a disk that ignores case', async () => {
        const store = caseInsensitive(memoryVfs({ 'plan.md': '# Plan', 'index.md': 'See [[plan]] and [p](plan.md).' }))
        const vault = await Vault.open(store, { watch: false })
        await vault.rename('plan.md', 'Plan.md')
        expect((await store.readDir('/')).map(([name]) => name).sort()).toEqual(['Plan.md', 'index.md'])
        expect(await store.readFile('Plan.md')).toBe('# Plan')
        expect(await store.readFile('index.md')).toBe('See [[plan]] and [p](Plan.md).')
        // Another file's name, however spelled, is still taken.
        await store.writeFile('a.md', 'a')
        await expect(vault.rename('a.md', 'PLAN.md')).rejects.toThrow(/exists/)
        await expect(fileOperations(store).rename('a.md', 'pLaN.md')).rejects.toThrow(/exists/)
        expect(await fileOperations(store).rename('a.md', 'A.md')).toBe(0)
        expect((await store.readDir('/')).map(([name]) => name).sort()).toEqual(['A.md', 'Plan.md', 'index.md'])
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

    it('renames while watching the store as it would without: the move’s own events change nothing', async () => {
        const store = memoryVfs({ 'a/plan.md': '# Plan', 'x.md': 'See [[plan]].' })
        const vault = await Vault.open(store)
        expect(await vault.rename('a/plan.md', 'b/plan.md')).toBe(0)
        expect(await store.readFile('x.md')).toBe('See [[plan]].')
        await tick()
        expect(vault.backlinks('b/plan.md').map((l) => l.source)).toEqual(['x.md'])
        vault.close()
    })

    it('walks around what it leaves out, and past what it cannot read', async () => {
        const store = memoryVfs({ 'a.md': '[[b]]', 'b.md': '# B', '.git/objects/x': 'blob', 'locked/c.md': '# C' })
        const listed: string[] = []
        const spy: VfsInterface = {
            ...store,
            readFile: async (path) => {
                if (normalizePath(path) === 'b.md') throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
                return store.readFile(path)
            },
            readDir: async (path) => {
                listed.push(normalizePath(path))
                if (normalizePath(path) === 'locked') throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
                return store.readDir(path)
            },
        }
        const vault = await Vault.open(spy, { watch: false })
        expect(vault.paths()).toEqual(['a.md', 'b.md'])
        expect(listed.some((p) => p.startsWith('.git'))).toBe(false)
        // b.md could not be read, but [[b]] still finds it.
        expect(vault.unresolved()).toEqual([])
    })

    it('hears changes made while it is first read', async () => {
        const store = memoryVfs({ 'a.md': '# A' })
        let wrote = false
        const spy: VfsInterface = {
            ...store,
            // Another program writes just after the walk has listed the root.
            readDir: async (path) => {
                const listed = await store.readDir(path)
                if (!wrote) {
                    wrote = true
                    await store.writeFile('late.md', '# Late')
                }
                return listed
            },
        }
        const vault = new Vault(spy)
        await vault.ready
        await waitUntil(() => vault.paths().includes('late.md'))
        vault.close()
    })

    it('leaves dot-directories out', async () => {
        const vault = await Vault.open(await fixtureCopy(), { watch: false })
        expect(vault.paths().some((f) => f.startsWith('.obsidian'))).toBe(false)
        await vault.fs.mkdir('.eznote', { recursive: true })
        await vault.fs.writeFile('.eznote/state.md', '[[index]]')
        expect(vault.backlinks('index.md').some((l) => l.source.startsWith('.'))).toBe(false)
    })
})

async function waitUntil(condition: () => boolean, timeout = 2000): Promise<void> {
    const start = Date.now()
    while (!condition()) {
        if (Date.now() - start > timeout) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 5))
    }
}

describe('A vault’s comments', () => {
    const REVIEW = [
        '# Review',
        '',
        '- @alice 2026-09-13T12:10Z · open · [[Plan#:~:text=ship%20it]]',
        '  Which release?',
        '- @bob 2026-09-13T12:11Z · open · [[Other#^x]]',
        '  Not about the plan.',
        '',
    ].join('\n')
    const NOTES = {
        'projects/Plan.md': '# Plan\n\nWe ship it. ^abc\n\n[^c-1]: @theo 2026-09-13T12:00Z · open · [[#^abc]]\n    Its own thread.\n',
        'reviews/2026-09-13.md': REVIEW,
        'journal.md': 'Today.\n\n[^c-2]: @theo 2026-09-13T13:00Z · resolved · [[Plan#^abc]] [[Other]]\n    Done?\n',
        'Other.md': '# Other\n',
    }

    it('are found by the note they are about, wherever they are written', async () => {
        const vault = await Vault.open(memoryVfs(NOTES), { watch: false })
        const about = await vault.comments.threadsAbout('projects/Plan.md')
        expect(about.map((t) => [t.source, t.form, t.label, t.thread.author])).toEqual([
            ['journal.md', 'footnote', 'c-2', 'theo'],
            ['reviews/2026-09-13.md', 'item', null, 'alice'],
        ])
        // A note's own threads are the editor's to read; they are not repeated.
        expect(about.some((t) => t.source === 'projects/Plan.md')).toBe(false)
        expect((await vault.comments.threadsAbout('Other.md')).map((t) => t.thread.author)).toEqual(['theo', 'bob'])
    })

    it('follow the notes they are in and about through renames', async () => {
        const vault = await Vault.open(memoryVfs(NOTES), { watch: false })
        await vault.rename('reviews/2026-09-13.md', 'reviews/done.md')
        await vault.rename('projects/Plan.md', 'Plan-2026.md')
        const about = await vault.comments.threadsAbout('Plan-2026.md')
        expect(about.map((t) => t.source)).toEqual(['journal.md', 'reviews/done.md'])
        // The links were kept pointing at the plan.
        expect(about[1].thread.targets[0]).toMatchObject({ target: 'Plan-2026', fragment: ':~:text=ship%20it' })
    })

    it('are changed where they live, and not over a change made meanwhile', async () => {
        const vault = await Vault.open(memoryVfs(NOTES), { watch: false })
        const [, review] = await vault.comments.threadsAbout('projects/Plan.md')
        const next = { ...review.thread, status: 'resolved' as const, replies: [{ author: 'theo', time: '2026-09-13T14:00Z', body: 'The next one.', replies: [] }] }
        const written = await vault.comments.update(review, next)
        expect(await vault.fs.readFile('reviews/2026-09-13.md')).toBe(REVIEW.replace(
            '- @alice 2026-09-13T12:10Z · open · [[Plan#:~:text=ship%20it]]\n  Which release?',
            '- @alice 2026-09-13T12:10Z · resolved · [[Plan#:~:text=ship%20it]]\n  Which release?\n  - @theo 2026-09-13T14:00Z: The next one.',
        ))
        expect(written?.thread).toEqual(next)
        // The index has the new text.
        expect((await vault.comments.threadsAbout('projects/Plan.md'))[1].thread.status).toBe('resolved')
        // The old reading is stale now.
        await expect(vault.comments.update(review, null)).rejects.toThrow(/changed since it was read/)
        // Removed, with the note otherwise as it was.
        await vault.comments.update(written!, null)
        expect(await vault.fs.readFile('reviews/2026-09-13.md')).toBe(REVIEW.split('\n').filter((_, i) => i !== 2 && i !== 3).join('\n'))
    })
})
