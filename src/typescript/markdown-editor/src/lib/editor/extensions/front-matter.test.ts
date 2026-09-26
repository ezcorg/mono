import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { memoryVfs, type VfsInterface } from '@joinezco/storage'
import { createEditor, documentId, MarkdownEditor, MarkdownEditorOptions } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

function make(options: MarkdownEditorOptions): { editor: MarkdownEditor; container: HTMLElement } {
    const container = createTestContainer(`fm-${created.length}`)
    const editor = createEditor({ element: container, ...options })
    created.push({ editor, container })
    return { editor, container }
}

const view = (container: HTMLElement) => container.querySelector('.ezco-mde-front-matter') as HTMLElement

describe('Front matter syntax', () => {
    const roundTrips = [
        '---\nid: 01J9K0000000000000000000AA\ntitle: Plan\ntags: [a, b]\n---\n\n# Title',
        '---\n---\n\nAn empty block of properties.',
        '---\nclosed: the YAML way\n...\n\nbody',
        '---\nonly: properties\n---',
        '---\n# a YAML comment, kept\nlist:\n  - one\n  - two\n---\n\ntext',
        '---\nid: X\n\n---\n\nA blank line before the closing fence.',
        '---\n\nid: X\n---\n\nA blank line after the opening one.',
    ]

    it.each(roundTrips)('round-trips %j byte for byte', (md) => {
        const { editor } = make({ content: md })
        expect(editor.state.doc.firstChild?.type.name).toBe('frontMatter')
        expect(getMarkdownContent(editor)).toBe(md)
    })

    it('is front matter only at the very start, and only when closed', () => {
        for (const md of ['---\n\nA rule, then text.', '# Title\n\n---\n\nlater: rule']) {
            const { editor } = make({ content: md })
            expect(editor.state.doc.firstChild?.type.name).not.toBe('frontMatter')
            expect(getMarkdownContent(editor)).toBe(md)
        }
    })

    it('stays text when turned off', () => {
        const { editor } = make({ content: '---\na: 1\n---\n\nx', frontMatter: false })
        expect(editor.state.doc.firstChild?.type.name).not.toBe('frontMatter')
    })
})

describe('Front matter view', () => {
    it('shows the properties as a table, links followable, and the YAML once the caret is in it', async () => {
        const { editor, container } = make({
            content: '---\nid: X1\ntags: [plan, draft]\nrelated: "[[Other note]]"\n---\n\n# Body',
        })
        await waitFor(() => !!view(container)?.querySelector('.ezco-mde-props'), 3000)
        const keys = [...view(container).querySelectorAll('.ezco-mde-prop-key')].map((k) => k.textContent)
        expect(keys).toEqual(['id', 'tags', 'related'])
        expect([...view(container).querySelectorAll('.ezco-mde-prop-chip')].map((c) => c.textContent)).toEqual(['plan', 'draft'])
        expect(view(container).querySelector('.ezco-mde-prop-value .ezco-mde-wikilink')?.textContent).toBe('Other note')
        expect(view(container).classList.contains('is-editing')).toBe(false)
        expect(documentId(editor)).toBe('X1')

        // Arrow up from the first block enters the front matter's source.
        await userEvent.click(editor.view.dom)
        editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1)
        await userEvent.keyboard('{ArrowUp}')
        await waitFor(() => view(container).classList.contains('is-editing'), 2000)
        expect(editor.state.selection.$from.parent.type.name).toBe('frontMatter')
    })

    it('is one line until asked for, opens and closes on it, and stays open from note to note', async () => {
        const { editor, container } = make({ content: '---\nid: X1\ntags: [a]\n---\n\n# Body' })
        await waitFor(() => !!view(container)?.querySelector('.ezco-mde-prop'), 3000)
        const toggle = () => view(container).querySelector('.ezco-mde-props-toggle') as HTMLButtonElement
        const edit = () => view(container).querySelector('.ezco-mde-props-edit') as HTMLButtonElement
        expect(view(container).classList.contains('is-collapsed')).toBe(true)
        expect(toggle().getAttribute('aria-expanded')).toBe('false')
        expect(toggle().textContent).toBe('▸ 2 properties')
        expect(edit().hidden).toBe(true)
        expect(getComputedStyle(view(container).querySelector('.ezco-mde-props-host')!).display).toBe('none')
        toggle().click()
        expect(view(container).classList.contains('is-collapsed')).toBe(false)
        expect(toggle().textContent).toBe('▾ 2 properties')
        expect(edit().hidden).toBe(false)
        expect(getComputedStyle(view(container).querySelector('.ezco-mde-props-host')!).display).not.toBe('none')
        // Clicking the table is not a way into the YAML; "Edit YAML" is.
        ;(view(container).querySelector('.ezco-mde-prop-key') as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        expect(view(container).classList.contains('is-editing')).toBe(false)
        edit().click()
        await waitFor(() => view(container).classList.contains('is-editing'), 2000)
        expect(editor.state.selection.$from.parent.type.name).toBe('frontMatter')
        // Back out of the YAML: the table is still open.
        editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1)
        await waitFor(() => !view(container).classList.contains('is-editing'), 2000)
        expect(view(container).classList.contains('is-collapsed')).toBe(false)
        // Another note in the same editor opens the way this one was left.
        editor.commands.setContent('---\nid: X2\n---\n\n# Other')
        await waitFor(() => !!view(container)?.querySelector('.ezco-mde-prop'), 3000)
        expect(view(container).classList.contains('is-collapsed')).toBe(false)
    })

    it('says so when the YAML does not parse', async () => {
        const { container } = make({ content: '---\na: [unclosed\n---\n\nx' })
        await waitFor(() => !!view(container)?.querySelector('.ezco-mde-props-error'), 3000)
    })
})

describe('Note identity', () => {
    async function openNote(fs: VfsInterface, path: string) {
        let n = 0
        const { editor } = make({
            fs: { fs, filepath: path, autoSave: true },
            frontMatter: { assignId: () => `ID${++n}` },
        })
        return editor
    }

    it('gives a note opened without an id one, saved and outside the undo history', async () => {
        const fs = memoryVfs({ 'a.md': '# A\n\nBody.' })
        const editor = await openNote(fs, 'a.md')
        await waitFor(() => documentId(editor) === 'ID1', 3000)
        await new Promise((r) => setTimeout(r, 700))
        expect(await fs.readFile('a.md')).toBe('---\nid: ID1\n---\n\n# A\n\nBody.')
        editor.commands.undo()
        expect(documentId(editor)).toBe('ID1')
    })

    it('adds the id to front matter that lacks one, and fills an empty `id:`', async () => {
        const fs = memoryVfs({ 'b.md': '---\ntitle: B\n---\n\nx', 'c.md': '---\nid:\ntitle: C\n---\n\nx' })
        const b = await openNote(fs, 'b.md')
        await waitFor(() => documentId(b) === 'ID1', 3000)
        expect(getMarkdownContent(b)).toBe('---\nid: ID1\ntitle: B\n---\n\nx')
        const c = await openNote(fs, 'c.md')
        await waitFor(() => documentId(c) === 'ID1', 3000)
        expect(getMarkdownContent(c)).toBe('---\nid: ID1\ntitle: C\n---\n\nx')
    })

    it('leaves a note that has one alone, and never writes without being asked', async () => {
        const fs = memoryVfs({ 'd.md': '---\nid: KEEP\n---\n\nx', 'e.md': '# E' })
        const d = await openNote(fs, 'd.md')
        await waitFor(() => documentId(d) === 'KEEP', 3000)
        const { editor: e } = make({ fs: { fs, filepath: 'e.md', autoSave: true } })
        await waitFor(() => e.getText().includes('E'), 3000)
        await new Promise((r) => setTimeout(r, 700))
        expect(await fs.readFile('d.md')).toBe('---\nid: KEEP\n---\n\nx')
        expect(await fs.readFile('e.md')).toBe('# E')
        expect(documentId(e)).toBeNull()
    })
})
