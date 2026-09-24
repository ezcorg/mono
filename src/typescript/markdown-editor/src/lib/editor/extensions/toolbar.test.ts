import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { Vault, memoryVfs } from '@joinezco/storage'
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
})
