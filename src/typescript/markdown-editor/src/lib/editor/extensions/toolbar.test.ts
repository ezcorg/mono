import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { memoryVfs } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
import { createEditor, MarkdownEditor, MarkdownEditorOptions } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

function make(options: MarkdownEditorOptions) {
    const container = createTestContainer(`tb-${created.length}`)
    const editor = createEditor({ element: container, ...options })
    created.push({ editor, container })
    return { editor, container }
}

const FILES = {
    'index.md': '# Index\n\nStart here.',
    'notes/animals.md': '# Animals\n\nThe quick brown fox jumps over the lazy dog.\n\nAnd a quokka.',
    'notes/plan.md': '# Plan\n\nNothing about foxes.',
}

const input = (c: HTMLElement) => c.querySelector('.cm-toolbar-input') as HTMLInputElement
const results = (c: HTMLElement) => [...c.querySelectorAll('.cm-search-result')] as HTMLElement[]
const filepath = (editor: MarkdownEditor) => (editor.storage as any).persistence.options.filepath as string

describe('The toolbar as a command palette', () => {
    it('finds notes by their text, shows where, and opens them at the match', async () => {
        const vault = await Vault.open(memoryVfs(FILES), { watch: false })
        const { editor, container } = make({
            fs: { fs: vault.fs, filepath: 'index.md' },
            search: vault.search,
            files: vault.files,
            links: { resolver: vault.links },
        })
        await waitFor(() => editor.getText().includes('Start here'), 3000)
        await userEvent.click(input(container))
        await userEvent.clear(input(container))
        await userEvent.type(input(container), 'quokka')
        await waitFor(() => results(container).some((r) => r.textContent?.includes('notes/animals.md')), 3000)
        const hit = results(container).find((r) => r.textContent?.includes('notes/animals.md'))!
        expect(hit.querySelector('.cm-search-result-snippet')?.textContent).toBe('5: And a quokka.')
        hit.click()
        await waitFor(() => filepath(editor) === 'notes/animals.md', 3000)
        await waitFor(() => editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to) === 'quokka', 3000)
    })

    it('opens on ⌘P, and lists the editor’s commands after `>`', async () => {
        const vault = await Vault.open(memoryVfs(FILES), { watch: false })
        const { editor, container } = make({
            fs: { fs: vault.fs, filepath: 'index.md' },
            search: vault.search,
            files: vault.files,
        })
        await waitFor(() => editor.getText().includes('Start here'), 3000)
        editor.commands.focus('end')
        editor.commands.keyboardShortcut('Mod-Shift-p')
        expect(document.activeElement).toBe(input(container))
        expect(input(container).value).toBe('>')
        await waitFor(() => results(container).some((r) => r.textContent?.includes('> Callout')), 3000)
        // Narrow the commands (set directly: the typing path is the test above's).
        input(container).value = '>callout'
        input(container).dispatchEvent(new Event('input', { bubbles: true }))
        const labels = () => results(container).map((r) => r.querySelector('.cm-search-result-label')?.textContent)
        await waitFor(() => labels().join() === '> Callout', 3000)
        results(container).find((r) => r.textContent?.includes('> Callout'))!.click()
        await waitFor(() => editor.state.doc.lastChild?.type.name === 'callout' || editor.state.doc.child(1)?.type.name === 'callout', 3000)
    })

    it('without the host’s search, searches a vault of its own over the filesystem', async () => {
        const fs = memoryVfs(FILES)
        const { editor, container } = make({ fs: { fs, filepath: 'index.md', autoSave: true } })
        await waitFor(() => editor.getText().includes('Start here'), 3000)
        // A note written through the editor is found by what it says.
        editor.commands.focus('end')
        editor.commands.insertContent(' Zebras live here.')
        await new Promise((r) => setTimeout(r, 700))
        await userEvent.click(input(container))
        await userEvent.clear(input(container))
        await userEvent.type(input(container), 'zebras')
        await waitFor(() => results(container).some((r) => r.textContent?.includes('index.md')), 3000)
        expect(getMarkdownContent(editor)).toContain('Zebras')
    })

    it('renames an open code file or image, carrying what is in it (autosave off)', async () => {
        const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
        const fs = memoryVfs({ 'main.ts': 'export const x = 1;\n', 'pic.png': png })
        const { editor, container } = make({ fs: { fs, filepath: 'main.ts' } })
        const persistence = (editor.storage as any).persistence
        await waitFor(() => !!persistence.codeView?.state.doc.toString().includes('x = 1'), 3000)
        persistence.codeView.dispatch({ changes: { from: 0, insert: '// edited\n' }, userEvent: 'input.type' })

        const rename = async (to: string) => {
            input(container).focus()
            input(container).value = to
            input(container).dispatchEvent(new Event('input', { bubbles: true }))
            await waitFor(() => results(container).some((r) => r.textContent?.includes(`Rename to "${to}"`)), 3000)
            results(container).find((r) => r.textContent?.includes(`Rename to "${to}"`))!.click()
            await waitFor(() => filepath(editor) === to, 3000)
        }
        await rename('moved.ts')
        expect(await fs.readFile('moved.ts')).toBe('// edited\nexport const x = 1;\n')

        await persistence.loadFile('pic.png')
        await waitFor(() => !!container.querySelector('.cm-image-preview'), 3000)
        await rename('renamed.png')
        expect([...(await fs.readBytes('renamed.png'))]).toEqual([...png])
    })

    it('deletes the open note, putting it down unsaved first', async () => {
        const vault = await Vault.open(memoryVfs(FILES), { watch: false })
        const { editor, container } = make({
            fs: { fs: vault.fs, filepath: 'notes/plan.md', autoSave: true },
            search: vault.search,
            files: vault.files,
        })
        const persistence = (editor.storage as any).persistence
        const events: Array<{ type: string; path: string }> = []
        persistence.subscribe((event: { type: string; path: string }) => events.push({ type: event.type, path: event.path }))
        await waitFor(() => editor.getText().includes('Nothing about foxes'), 3000)
        // An edit still inside the autosave debounce.
        editor.commands.focus('end')
        editor.commands.insertContent(' More.')
        const key = (k: string) => input(container).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
        input(container).focus()
        input(container).value = 'plan'
        input(container).dispatchEvent(new Event('input', { bubbles: true }))
        await waitFor(() => !!container.querySelector('.cm-file-result'), 3000)
        for (let i = 0; i < 5 && !container.querySelector('.cm-file-result.selected'); i++) key('ArrowDown')
        key('Delete')
        key('Enter')
        await waitFor(() => events.some((e) => e.type === 'close'), 3000)
        await new Promise((r) => setTimeout(r, 700))
        expect(await vault.fs.exists('notes/plan.md')).toBe(false)
        expect(filepath(editor)).toBeUndefined()
        expect(events.filter((e) => e.path === 'notes/plan.md').map((e) => e.type)).toEqual(['load', 'close'])
    })

    it('finds a file where a host’s link index moved it', async () => {
        const store = memoryVfs(FILES)
        // A host that renames itself (icanhaz's links capability), outside the editor.
        const index = {
            backlinks: async () => [],
            unresolved: async () => [],
            rename: async (from: string, to: string) => (await store.rename(from, to), 0),
        }
        const { editor, container } = make({ fs: { fs: store, filepath: 'index.md' }, links: { index } })
        await waitFor(() => editor.getText().includes('Start here'), 3000)
        await index.rename('notes/plan.md', 'notes/roadmap.md')
        // Searched again until the editor's vault has heard of the move.
        const shows = async (query: string, path: string) => {
            for (let i = 0; i < 30; i++) {
                input(container).focus()
                input(container).value = query
                input(container).dispatchEvent(new Event('input', { bubbles: true }))
                await new Promise((r) => setTimeout(r, 100))
                if (results(container).some((r) => r.textContent?.includes(path))) return true
            }
            return false
        }
        expect(await shows('roadmap', 'notes/roadmap.md')).toBe(true)
        expect(await shows('plan', 'notes/plan.md')).toBe(false)
    })
})
