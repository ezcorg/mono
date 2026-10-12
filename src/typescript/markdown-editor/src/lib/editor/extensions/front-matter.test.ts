import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { memoryVfs, type VfsInterface } from '@joinezco/storage'
import { createEditor, documentId, MarkdownEditor, MarkdownEditorOptions } from '../index'
import { actionsForNode } from './block-actions'
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
    afterEach(() => localStorage.removeItem('ezco-mde-front-matter'))
    const line = (container: HTMLElement) => view(container).querySelector('.ezco-mde-front-matter-line') as HTMLButtonElement
    const code = (container: HTMLElement) => view(container).querySelector('.cm-content') as HTMLElement
    const open = (container: HTMLElement) => !view(container).classList.contains('is-collapsed')
    /** The editor mounts after a tick, and puts the caret at the start of the body then. */
    const settled = (editor: MarkdownEditor, container: HTMLElement) => waitFor(() => !!code(container) && editor.state.selection.$from.parent.type.name !== 'frontMatter', 3000)

    it('is one line until the caret goes in, then the YAML in a code block, folded again on leaving', async () => {
        const { editor, container } = make({ content: '---\nid: X1\ntags: [plan, draft]\nrelated: "[[Other note]]"\n---\n\n# Body' })
        await settled(editor, container)
        expect(open(container)).toBe(false)
        expect(line(container).textContent).toBe('3 propertiesid, tags, related')
        expect(getComputedStyle(code(container).closest('.cm-editor')!).display).toBe('none')
        expect(view(container).querySelector('.cm-toolbar-panel')).toBeNull()
        expect(documentId(editor)).toBe('X1')
        expect(editor.state.selection.$from.parent.type.name).not.toBe('frontMatter')

        // Arrow up from the first block opens the YAML, the caret at its end.
        await userEvent.click(editor.view.dom)
        editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1)
        await userEvent.keyboard('{ArrowUp}')
        await waitFor(() => open(container) && document.activeElement === code(container), 2000)
        expect(getComputedStyle(line(container)).display).toBe('none')
        expect(code(container).textContent).toContain('related: "[[Other note]]"')
        // Typed there, the note has it; the line says so once folded.
        await userEvent.keyboard('{Enter}kind: note')
        await waitFor(() => getMarkdownContent(editor).startsWith('---\nid: X1\ntags: [plan, draft]\nrelated: "[[Other note]]"\nkind: note\n---'), 2000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !open(container), 2000)
        expect(editor.state.selection.$from.parent.type.name).toBe('heading')
        expect(line(container).textContent).toBe('4 propertiesid, tags, related, kind')
        // A click on the line opens it too; a click in the note folds it.
        line(container).click()
        await waitFor(() => open(container) && document.activeElement === code(container), 2000)
        await userEvent.click(editor.view.dom.querySelector('h1')!)
        await waitFor(() => !open(container), 2000)
    })

    it('stays open when told to, from the block action, and the choice is kept', async () => {
        const { editor, container } = make({ content: '---\nid: X1\n---\n\n# Body' })
        await settled(editor, container)
        expect(open(container)).toBe(false)
        const fold = () => actionsForNode(editor.state.doc.firstChild!, editor).find((a) => a.label.endsWith('Collapse when not editing'))!
        expect(fold().label).toBe('✓ Collapse when not editing')
        fold().run({ editor, pos: 0, node: editor.state.doc.firstChild! })
        await waitFor(() => open(container), 2000)
        expect(fold().label).toBe('Collapse when not editing')
        expect(localStorage.getItem('ezco-mde-front-matter')).toBe('open')
        // Leaving it leaves it open.
        editor.commands.editFrontMatter()
        await waitFor(() => document.activeElement === code(container), 2000)
        await userEvent.click(editor.view.dom.querySelector('h1')!)
        await new Promise((r) => setTimeout(r, 100))
        expect(open(container)).toBe(true)
        // The next editor opens the way this one was left.
        const next = make({ content: '---\nid: X2\n---\n\n# Other' })
        await settled(next.editor, next.container)
        expect(open(next.container)).toBe(true)
        fold().run({ editor, pos: 0, node: editor.state.doc.firstChild! })
        await waitFor(() => !open(container), 2000)
        expect(localStorage.getItem('ezco-mde-front-matter')).toBeNull()
    })

    it('offers the front matter its own actions, and goes on Backspace when empty', async () => {
        const { editor, container } = make({ content: '---\n---\n\n# Body' })
        await settled(editor, container)
        expect(line(container).textContent).toBe('No properties')
        expect(actionsForNode(editor.state.doc.firstChild!, editor).map((a) => a.label)).toEqual(['Edit properties', '✓ Collapse when not editing', 'Delete'])
        editor.commands.editFrontMatter()
        await waitFor(() => document.activeElement === code(container), 2000)
        await userEvent.keyboard('{Backspace}')
        await waitFor(() => editor.state.doc.firstChild?.type.name === 'heading', 2000)
        expect(getMarkdownContent(editor)).toBe('# Body')
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
