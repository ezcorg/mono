import { describe, it, expect, afterEach } from 'vitest'
import { Vault, memoryVfs, type VfsInterface } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

async function open(files: Record<string, string>, filepath: string) {
    const vault = await Vault.open(memoryVfs(files), { watch: false })
    const container = createTestContainer(`versions-${created.length}`)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath, autoSave: true },
        links: { resolver: vault.links },
        search: vault.search,
        files: vault.files,
        versions: vault.versions,
    })
    created.push({ editor, container })
    const persistence = (editor.storage as any).persistence
    const events: Array<{ type: string; path: string; copy?: string }> = []
    persistence.subscribe((event: any) => events.push(event))
    await waitFor(() => events.some((e) => e.type === 'load'), 3000)
    return { editor, vault, persistence, events, markdown: () => (editor.storage as any).markdown.getMarkdown() as string }
}

describe('Notes and their versions', () => {
    it('saves on the version it loaded, each save a version on the last', async () => {
        const { editor, vault, events } = await open({ 'a.md': 'A' }, 'a.md')
        editor.commands.focus('end')
        editor.commands.insertContent(' one')
        await waitFor(() => events.some((e) => e.type === 'save'), 3000)
        const [saved, first] = await vault.versions.history('a.md')
        expect(saved.parents).toEqual([first.id])
        expect(new TextDecoder().decode(await vault.versions.read(saved))).toBe('A one')
    })

    it('keeps its edits as a conflict copy when the file changed underneath, and shows the file', async () => {
        const { editor, vault, events, markdown } = await open({ 'a.md': 'A' }, 'a.md')
        editor.commands.focus('end')
        editor.commands.insertContent(' mine')
        // Before the save: another writer changes the file.
        await vault.fs.writeFile('a.md', 'Theirs')
        await waitFor(() => events.some((e) => e.type === 'conflict'), 3000)
        const conflict = events.find((e) => e.type === 'conflict')!
        expect(conflict.path).toBe('a.md')
        expect(await vault.fs.readFile(conflict.copy!)).toBe('A mine')
        expect(await vault.fs.readFile('a.md')).toBe('Theirs')
        await waitFor(() => markdown() === 'Theirs', 3000)
        // Editing on is a save on theirs.
        editor.commands.focus('end')
        editor.commands.insertContent(' and more')
        await waitFor(async () => (await vault.fs.readFile('a.md')) === 'Theirs and more', 3000)
        expect(events.filter((e) => e.type === 'conflict')).toHaveLength(1)
    })

    it('follows its file when it changes elsewhere and nothing here is unsaved', async () => {
        const { vault, events, markdown } = await open({ 'a.md': '# A', 'b.md': '# B' }, 'a.md')
        await vault.fs.writeFile('a.md', '# A, from an agent')
        await waitFor(() => markdown() === '# A, from an agent', 3000)
        // A change to another file leaves this one alone.
        await vault.fs.writeFile('b.md', '# B again')
        await new Promise((r) => setTimeout(r, 700))
        expect(events.filter((e) => e.type === 'save')).toEqual([])
        expect(markdown()).toBe('# A, from an agent')
    })

    it('gives a code file’s view the same log', async () => {
        const { vault, persistence, events } = await open({ 'a.md': '# A', 'main.ts': 'export {}\n' }, 'a.md')
        await persistence.loadFile('main.ts')
        await vault.fs.writeFile('main.ts', 'export const changed = 1\n')
        persistence.codeView.dispatch({ changes: { from: 0, insert: '// mine\n' }, userEvent: 'input.type' })
        await waitFor(() => events.some((e) => e.type === 'conflict' && e.path === 'main.ts'), 3000)
        expect(await vault.fs.readFile('main.ts')).toBe('export const changed = 1\n')
    })
})

// Keep the type import used under isolatedModules.
export type { VfsInterface }
