import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { Vault, memoryVfs } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { cleanupEditor, waitFor } from '../../../test/utils'

/**
 * The left column (the outline and the file tree) as laid out in a real
 * browser: measured boxes, not markup, so a regression that only shows once
 * the page scrolls is caught.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const NOTE = Array.from({ length: 30 }, (_, i) => `## Section ${i + 1}\n\nA paragraph of text for section ${i + 1}.`).join('\n\n')

/** The panels mounted into a column of the host's, the way the demo lays out
 *  its window: a scroller shorter than the page, a row inside it, the column
 *  a stretched flex item. */
async function openInHostColumn() {
    const files: Record<string, string> = { 'index.md': NOTE }
    for (let i = 0; i < 30; i++) files[`notes/note-${i}.md`] = `# Note ${i}`
    const vault = await Vault.open(memoryVfs(files), { watch: false })
    const container = document.createElement('div')
    container.style.cssText = 'width: 1000px; height: 400px; overflow-y: auto;'
    const row = document.createElement('div')
    row.style.cssText = 'display: flex; min-height: 100%;'
    const column = document.createElement('div')
    column.style.cssText = 'flex: none;'
    const body = document.createElement('div')
    body.style.cssText = 'flex: 1; min-width: 0;'
    row.append(column, body)
    container.append(row)
    document.body.append(container)
    const editor = createEditor({
        element: body,
        fs: { fs: vault.fs, filepath: 'index.md' },
        links: { resolver: vault.links },
        search: vault.search,
        files: vault.files,
        sidebar: { title: 'Document', mount: () => column },
        fileTree: { open: true, mount: () => column },
    })
    created.push({ editor, container })
    await waitFor(() => editor.getText().includes('Section 30'), 3000)
    await waitFor(() => container.querySelectorAll('.ezco-mde-files-item').length > 0, 3000)
    return { editor, container, column }
}

async function open(fileTree: { open?: boolean }) {
    const files: Record<string, string> = { 'index.md': NOTE }
    for (let i = 0; i < 12; i++) files[`notes/note-${i}.md`] = `# Note ${i}`
    const vault = await Vault.open(memoryVfs(files), { watch: false })
    // A page that scrolls, as an app's window does.
    const container = document.createElement('div')
    container.style.cssText = 'width: 1000px; height: 500px; overflow-y: auto;'
    document.body.append(container)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: 'index.md' },
        links: { resolver: vault.links },
        search: vault.search,
        files: vault.files,
        sidebar: { title: 'Document' },
        fileTree,
    })
    created.push({ editor, container })
    await waitFor(() => editor.getText().includes('Section 30'), 3000)
    return { editor, container }
}

const box = (c: HTMLElement, selector: string) => (c.querySelector(selector) as HTMLElement).getBoundingClientRect()
const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

describe('The left column', () => {
    it('keeps the outline and the file tree apart, however far the page scrolls', async () => {
        const { container } = await open({ open: true })
        await waitFor(() => container.querySelectorAll('.ezco-mde-files-item').length > 0, 3000)
        for (const top of [0, 400, 1500]) {
            container.scrollTop = top
            await new Promise((r) => requestAnimationFrame(() => r(null)))
            const outline = box(container, '.ezco-mde-sidebar')
            const files = box(container, '.ezco-mde-files')
            expect(outline.height).toBeGreaterThan(0)
            expect(files.height).toBeGreaterThan(0)
            expect(overlap(outline, files), `overlapping at scrollTop ${top}`).toBe(false)
        }
        // And the column stays in view as the note scrolls.
        const nav = box(container, '.ezco-mde-nav')
        expect(nav.top).toBeGreaterThanOrEqual(container.getBoundingClientRect().top - 1)
    })

    it('does the same in a column of the host’s, which it fits to the scroll area', async () => {
        const { container, column } = await openInHostColumn()
        for (const top of [0, 400, 1500]) {
            container.scrollTop = top
            await new Promise((r) => requestAnimationFrame(() => r(null)))
            expect(overlap(box(container, '.ezco-mde-sidebar'), box(container, '.ezco-mde-files')), `overlapping at scrollTop ${top}`).toBe(false)
            // The whole column can be reached: it is no taller than what shows.
            const rail = column.getBoundingClientRect()
            const view = container.getBoundingClientRect()
            expect(rail.top).toBeGreaterThanOrEqual(view.top - 1)
            expect(rail.bottom).toBeLessThanOrEqual(view.bottom + 1)
        }
    })

    it('keeps the file tree closed until asked for', async () => {
        const { editor, container } = await open({})
        const toggle = container.querySelector('.ezco-mde-files-toggle') as HTMLButtonElement
        const list = container.querySelector('.ezco-mde-files-list') as HTMLElement
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        expect(list.hidden).toBe(true)
        expect(box(container, '.ezco-mde-files-list').height).toBe(0)

        toggle.click()
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
        await waitFor(() => [...container.querySelectorAll('.ezco-mde-files-item')].some((r) => r.textContent === 'index.md'), 3000)

        // ⌘⇧E (Ctrl+Shift+E) from the note, both ways.
        await userEvent.click(editor.view.dom)
        editor.commands.keyboardShortcut('Mod-Shift-e')
        expect(list.hidden).toBe(true)
        editor.commands.toggleFileTree()
        expect(list.hidden).toBe(false)
    })
})

describe('The note column', () => {
    it('fits the host it is given, however long a word in the note', async () => {
        // A host that lays the editor out as a flex item (as the demo's
        // window does), narrower than the note's longest word at heading size.
        const container = document.createElement('div')
        container.style.cssText = 'display: flex; width: 420px; height: 400px; overflow: auto;'
        document.body.append(container)
        const word = '`@joinezco/markdown-editor-and-then-some`'
        const editor = createEditor({ element: container, content: `# ${word}\n\nhttps://example.com/${'a'.repeat(120)}` })
        created.push({ editor, container })
        await waitFor(() => editor.getText().includes('example.com'), 3000)
        const root = box(container, '.ezco-mde')
        expect(root.width).toBeLessThanOrEqual(420)
        // Nothing to scroll sideways to: the word wraps inside the column.
        expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth)
        expect(box(container, '.ezco-mde-body h1').right).toBeLessThanOrEqual(container.getBoundingClientRect().right)
    })
})

