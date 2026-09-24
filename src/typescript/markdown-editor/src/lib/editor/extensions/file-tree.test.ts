import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { Vault, memoryVfs } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const FILES = {
    'index.md': '# Index\n\nSee [[plan]].',
    'projects/plan.md': '# Plan',
    'projects/2026/goals.md': '# Goals',
    '.obsidian/app.json': '{}',
    'zebra.md': '# Z',
}

async function open(path = 'index.md') {
    const vault = await Vault.open(memoryVfs(FILES), { watch: false })
    const container = createTestContainer(`ft-${created.length}`)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: path, autoSave: true },
        links: { resolver: vault.links, index: vault.links },
        search: vault.search,
        files: vault.files,
        fileTree: {},
    })
    created.push({ editor, container })
    await waitFor(() => editor.getText().length > 0, 3000)
    return { editor, vault, container }
}

const rows = (c: HTMLElement) => [...c.querySelectorAll('.ezco-mde-files-item')] as HTMLElement[]
const shown = (c: HTMLElement) => rows(c).map((r) => r.dataset.path)
const row = (c: HTMLElement, path: string) => rows(c).find((r) => r.dataset.path === path)!
const filepath = (editor: MarkdownEditor) => (editor.storage as any).persistence.options.filepath as string

describe('File tree', () => {
    it('lists folders first, hides dot-folders, and opens the folders of the open file', async () => {
        const { container } = await open('projects/2026/goals.md')
        await waitFor(() => shown(container).includes('projects/2026/goals.md'), 3000)
        expect(shown(container)).toEqual(['projects', 'projects/2026', 'projects/2026/goals.md', 'projects/plan.md', 'index.md', 'zebra.md'])
        expect(row(container, 'projects/2026/goals.md').classList.contains('is-current')).toBe(true)
        // It sits in the editor's left column by default.
        expect(container.querySelector('.ezco-mde-nav .ezco-mde-files')).not.toBeNull()
    })

    it('opens files, and folders from the keyboard', async () => {
        const { editor, container } = await open()
        await waitFor(() => shown(container).includes('projects'), 3000)
        row(container, 'projects').click()
        await waitFor(() => shown(container).includes('projects/plan.md'), 3000)
        row(container, 'projects/plan.md').click()
        await waitFor(() => filepath(editor) === 'projects/plan.md', 3000)
        // The toolbar shows the file, however it was opened.
        expect((container.querySelector('.cm-toolbar-input') as HTMLInputElement).value).toBe('projects/plan.md')
        // Arrow keys: up to the folder, left closes it.
        row(container, 'projects/plan.md').focus()
        await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowLeft}')
        await waitFor(() => !shown(container).includes('projects/plan.md'), 3000)
        expect(document.activeElement?.getAttribute('data-path')).toBe('projects')
    })

    it('renames in place with F2, keeping links, and follows the open note', async () => {
        const { editor, vault, container } = await open('projects/plan.md')
        await waitFor(() => shown(container).includes('projects/plan.md'), 3000)
        row(container, 'projects/plan.md').focus()
        await userEvent.keyboard('{F2}')
        const input = await (async () => {
            await waitFor(() => !!container.querySelector('.ezco-mde-files-rename'), 2000)
            return container.querySelector('.ezco-mde-files-rename') as HTMLInputElement
        })()
        expect(input.value.slice(input.selectionStart!, input.selectionEnd!)).toBe('plan')
        await userEvent.keyboard('roadmap{Enter}')
        await waitFor(() => filepath(editor) === 'projects/roadmap.md', 3000)
        expect(await vault.fs.readFile('index.md')).toBe('# Index\n\nSee [[roadmap]].')
        await waitFor(() => container.querySelector('.ezco-mde-files-status')?.textContent === 'Renamed; 1 link updated.', 3000)
        expect(shown(container)).toContain('projects/roadmap.md')
    })

    it('renames a note the open one links to, keeping the open note’s edits and its rewritten link', async () => {
        const { editor, vault, container } = await open('index.md')
        await waitFor(() => shown(container).includes('projects'), 3000)
        // An unsaved edit to the open note (autosave has not fired yet).
        editor.commands.focus('end')
        editor.commands.insertContent(' Also this.')
        row(container, 'projects').click()
        await waitFor(() => shown(container).includes('projects/plan.md'), 3000)
        // Down past projects/2026 to projects/plan.md, and rename it.
        row(container, 'projects').focus()
        await userEvent.keyboard('{ArrowDown}{ArrowDown}')
        expect(document.activeElement?.getAttribute('data-path')).toBe('projects/plan.md')
        await userEvent.keyboard('{F2}')
        await waitFor(() => !!container.querySelector('.ezco-mde-files-rename'), 2000)
        await userEvent.keyboard('roadmap{Enter}')
        await waitFor(() => shown(container).includes('projects/roadmap.md'), 3000)
        expect(await vault.fs.readFile('index.md')).toBe('# Index\n\nSee [[roadmap]]. Also this.')
        // The editor shows the rewritten link, and its next save keeps it.
        await waitFor(() => (editor.storage as any).markdown.getMarkdown() === '# Index\n\nSee [[roadmap]]. Also this.', 3000)
        editor.commands.insertContent('!')
        await new Promise((r) => setTimeout(r, 700))
        expect(await vault.fs.readFile('index.md')).toBe('# Index\n\nSee [[roadmap]]. Also this.!')
    })

    it('acts on the row that has focus, however it got there', async () => {
        const { container } = await open('index.md')
        await waitFor(() => shown(container).includes('zebra.md'), 3000)
        // Focus moved without the tree's own keys (Tab, a screen reader).
        row(container, 'zebra.md').focus()
        await userEvent.keyboard('{F2}')
        await waitFor(() => !!container.querySelector('.ezco-mde-files-rename'), 2000)
        expect(container.querySelector('.ezco-mde-files-rename')?.closest('[data-path]')?.getAttribute('data-path')).toBe('zebra.md')
        await userEvent.keyboard('{Escape}')
        expect(row(container, 'zebra.md').tabIndex).toBe(0)
    })

    it('deletes after asking, closing the note if it was open', async () => {
        const { editor, vault, container } = await open('zebra.md')
        await waitFor(() => shown(container).includes('zebra.md'), 3000)
        row(container, 'zebra.md').focus()
        await userEvent.keyboard('{Delete}')
        expect(row(container, 'zebra.md').textContent).toBe('Delete zebra.md? Enter / Esc')
        await userEvent.keyboard('{Enter}')
        await waitFor(() => !shown(container).includes('zebra.md'), 3000)
        expect(await vault.fs.exists('zebra.md')).toBe(false)
        expect(filepath(editor)).toBeUndefined()
    })

    it('makes a new note in the selected folder and names it in place', async () => {
        const { editor, vault, container } = await open('projects/plan.md')
        await waitFor(() => shown(container).includes('projects/plan.md'), 3000)
        ;(container.querySelector('.ezco-mde-files-action[aria-label="New note"]') as HTMLElement).click()
        await waitFor(() => filepath(editor) === 'projects/Untitled.md', 3000)
        await waitFor(() => !!container.querySelector('.ezco-mde-files-rename'), 2000)
        await userEvent.keyboard('Ideas{Enter}')
        await waitFor(() => filepath(editor) === 'projects/Ideas.md', 3000)
        expect(await vault.fs.exists('projects/Untitled.md')).toBe(false)
        expect(await vault.fs.exists('projects/Ideas.md')).toBe(true)
    })

    it('shows files written by other means once the vault reports them', async () => {
        const { vault, container } = await open()
        await waitFor(() => shown(container).includes('zebra.md'), 3000)
        await vault.fs.writeFile('apple.md', '# A')
        await waitFor(() => shown(container).includes('apple.md'), 3000)
    })
})
