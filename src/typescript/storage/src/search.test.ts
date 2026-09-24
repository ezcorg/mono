import { describe, expect, it } from 'vitest'
import { dirname as nodeDirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Vault } from './vault.js'
import { memoryVfs } from './memory.js'
import { nodeVfs } from './node.js'
import { snippetOf, titleOf } from './search.js'
import { fileOperations } from './files.js'
import { walk } from './vfs.js'
import { normalizePath } from './path.js'

const FIXTURE = join(nodeDirname(fileURLToPath(import.meta.url)), '__fixtures__', 'vault')

async function fixtureCopy() {
    const disk = nodeVfs(FIXTURE)
    const files: Record<string, Uint8Array> = {}
    for await (const p of walk(disk, '/')) files[normalizePath(p)] = await disk.readBytes(p)
    return memoryVfs(files)
}

describe('titles and snippets', () => {
    it('takes a title from front matter, else the first heading, else the name', () => {
        expect(titleOf('a/x.md', '---\ntitle: "From YAML"\n---\n# Heading')).toBe('From YAML')
        expect(titleOf('a/x.md', 'text\n\n## A Heading ##\n')).toBe('A Heading')
        expect(titleOf('a/My Note.md', 'no heading')).toBe('My Note')
    })

    it('finds the line and the text around the first match', () => {
        const text = 'first line\nsecond line mentions the gap here\nthird'
        expect(snippetOf(text, ['gap'])).toEqual({ snippet: 'second line mentions the gap here', line: 2 })
        expect(snippetOf(text, ['nothing'])).toBeNull()
        const long = `${'x'.repeat(100)} needle ${'y'.repeat(100)}`
        const { snippet } = snippetOf(long, ['needle'])!
        expect(snippet.startsWith('…')).toBe(true)
        expect(snippet.endsWith('…')).toBe(true)
        expect(snippet).toContain('needle')
    })
})

describe('searching a vault', () => {
    it('finds files by path and name, and notes by their text, with a snippet', async () => {
        const vault = await Vault.open(nodeVfs(FIXTURE), { watch: false })
        const plan = await vault.search.search('plan')
        expect(plan.slice(0, 2).map((h) => [h.path, h.match])).toEqual([
            ['projects/plan.md', 'path'],
            ['archive/2025/plan.md', 'path'],
        ])
        const [superseded] = await vault.search.search('superseded')
        expect(superseded).toMatchObject({
            path: 'archive/2025/plan.md',
            match: 'content',
            title: 'Old plan',
            snippet: 'Superseded; see [[index]].',
            line: 3,
        })
        expect(await vault.search.search('superseded', { content: false })).toEqual([])
        expect((await vault.search.search('diagram')).map((h) => h.path)).toContain('attachments/diagram.png')
        // Every term must match, each as a prefix.
        expect((await vault.search.search('road first')).map((h) => h.path)).toEqual(['projects/roadmap.md'])
        expect(await vault.search.search('   ')).toEqual([])
    })

    it('follows writes, deletions and renames', async () => {
        const vault = await Vault.open(await fixtureCopy(), { watch: false })
        await vault.files.create('notes/fresh.md', '# Fresh\n\nA quokka appears.')
        expect((await vault.search.search('quokka')).map((h) => h.path)).toEqual(['notes/fresh.md'])
        await vault.files.rename('notes/fresh.md', 'notes/renamed.md')
        expect((await vault.search.search('quokka')).map((h) => h.path)).toEqual(['notes/renamed.md'])
        await vault.files.remove('notes/renamed.md')
        expect(await vault.search.search('quokka')).toEqual([])
    })
})

describe('file operations', () => {
    it('create, move and delete over a plain VFS, refusing to clobber', async () => {
        const fs = memoryVfs({ 'a.md': 'a' })
        const files = fileOperations(fs)
        await expect(files.create('a.md', 'again')).rejects.toThrow(/exists/)
        await files.create('a.md', 'again', { overwrite: true })
        expect(await fs.readFile('a.md')).toBe('again')
        await files.create('deep/er/b.bin', new Uint8Array([1, 2]))
        expect([...(await fs.readBytes('deep/er/b.bin'))]).toEqual([1, 2])
        await expect(files.rename('a.md', 'deep/er/b.bin')).rejects.toThrow(/exists/)
        expect(await files.rename('a.md', 'moved/a.md')).toBe(0)
        expect(await fs.readFile('moved/a.md')).toBe('again')
        await expect(files.remove('deep')).rejects.toThrow(/folder/)
        await files.remove('deep/er/b.bin')
        expect(await fs.exists('deep/er/b.bin')).toBe(false)
    })

    it('in a vault, a rename keeps links, and the count says how many it rewrote', async () => {
        const vault = await Vault.open(await fixtureCopy(), { watch: false })
        expect(await vault.files.rename('projects/roadmap.md', 'projects/road.md')).toBe(2)
        expect(vault.backlinks('projects/road.md').map((l) => l.source)).toEqual(['index.md', 'projects/plan.md'])
    })
})
