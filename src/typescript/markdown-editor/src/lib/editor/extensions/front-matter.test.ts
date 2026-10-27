import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { memoryVfs, type VfsInterface } from '@joinezco/storage'
import { documentId, MarkdownEditor } from '../index'
import { actionsForNode } from './block-actions'
import { getMarkdownContent, trackEditors, waitFor } from '../../../test/utils'

const { make, typing } = trackEditors()

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
    /** The fold as a setting (kept in this browser: these editors have no filesystem). */
    const collapsed = (editor: MarkdownEditor) => (editor.storage as any).settings.get('frontMatter.collapsed') as boolean
    const head = (container: HTMLElement) => view(container).querySelector('.ezco-mde-front-matter-head') as HTMLElement
    const field = (container: HTMLElement) => head(container).querySelector('.cm-toolbar-input') as HTMLInputElement
    const summary = (container: HTMLElement) => head(container).querySelector('.ezco-mde-front-matter-summary') as HTMLButtonElement
    const rows = (container: HTMLElement) => [...head(container).querySelectorAll('.cm-search-result')].map((r) => r.querySelector('.cm-search-result-label')?.textContent)
    const code = (container: HTMLElement) => view(container).querySelector('.cm-content') as HTMLElement
    const open = (container: HTMLElement) => !view(container).classList.contains('is-collapsed')
    /** The editor mounts after a tick, and puts the caret at the start of the body then. */
    const settled = (editor: MarkdownEditor, container: HTMLElement) => waitFor(() => !!code(container) && editor.state.selection.$from.parent.type.name !== 'frontMatter', 3000)

    it('is a header until the caret goes in, then the YAML under it, folded again on leaving', async () => {
        const { editor, container } = make({ content: '---\nid: X1\ntags: [plan, draft]\nrelated: "[[Other note]]"\n---\n\n# Body' })
        await settled(editor, container)
        expect(open(container)).toBe(false)
        // The header is the code blocks' toolbar row: the YAML glyph where the
        // search glyph is, "frontmatter" in the field, the properties at its
        // end. Folded, it is next to nothing: the field gone, no surface, the
        // glyph and the summary small and faint.
        expect(head(container).classList.contains('cm-toolbar-panel')).toBe(true)
        expect(head(container).querySelector('.cm-toolbar-state-icon')?.textContent).toBe('')
        expect(field(container).value).toBe('frontmatter')
        expect(field(container).readOnly).toBe(true)
        expect(summary(container).textContent).toBe('3 properties · id, tags, related')
        expect(getComputedStyle(head(container)).display).not.toBe('none')
        expect(getComputedStyle(field(container)).display).toBe('none')
        expect(getComputedStyle(head(container)).backgroundColor).toBe('rgba(0, 0, 0, 0)')
        expect(Number(getComputedStyle(head(container)).opacity)).toBeLessThan(0.6)
        expect(parseFloat(getComputedStyle(summary(container)).fontSize)).toBeLessThanOrEqual(11)
        expect(getComputedStyle(code(container).closest('.cm-scroller')!).display).toBe('none')
        expect(documentId(editor)).toBe('X1')
        expect(editor.state.selection.$from.parent.type.name).not.toBe('frontMatter')

        // Arrow up from the first block opens the YAML, the caret at its end;
        // the header stays above it.
        await userEvent.click(editor.view.dom)
        editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize + 1)
        await userEvent.keyboard('{ArrowUp}')
        await waitFor(() => open(container) && document.activeElement === code(container), 2000)
        expect(getComputedStyle(head(container)).display).not.toBe('none')
        expect(getComputedStyle(field(container)).display).not.toBe('none')
        expect(code(container).textContent).toContain('related: "[[Other note]]"')
        // The header's columns are the code's: the glyph ends where the line
        // numbers end, the field starts where the code starts.
        await waitFor(() => !!head(container).closest('.cm-editor')!.getAttribute('style')?.includes('--cm-gutter-width'), 2000)
        const numbers = view(container).querySelector('.cm-lineNumbers')!.getBoundingClientRect()
        const glyph = head(container).querySelector('.cm-toolbar-state-icon')!.getBoundingClientRect()
        expect(Math.abs(glyph.right - numbers.right)).toBeLessThanOrEqual(1)
        const line = view(container).querySelector('.cm-line')!.getBoundingClientRect()
        expect(Math.abs(field(container).getBoundingClientRect().left - line.left)).toBeLessThanOrEqual(1)
        // Typed there, the note has it; the header says so once folded.
        await userEvent.keyboard('{Enter}kind: note')
        await waitFor(() => getMarkdownContent(editor).startsWith('---\nid: X1\ntags: [plan, draft]\nrelated: "[[Other note]]"\nkind: note\n---'), 2000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !open(container), 2000)
        expect(editor.state.selection.$from.parent.type.name).toBe('heading')
        expect(summary(container).textContent).toBe('4 properties · id, tags, related, kind')
        // The summary pressed opens it too; a click in the note folds it.
        summary(container).click()
        await waitFor(() => open(container) && document.activeElement === code(container), 2000)
        await userEvent.click(editor.view.dom.querySelector('h1')!)
        await waitFor(() => !open(container), 2000)
    })

    it('offers what the properties can do in the field’s dropdown, as the code blocks’ toolbar does', async () => {
        const { editor, container } = make({ content: '---\nid: X1\n---\n\n# Body' })
        await settled(editor, container)
        expect(rows(container)).toEqual([])
        // Folded, the field is gone with the rest of the header's chrome:
        // the summary opens the YAML, and the field with it.
        expect(getComputedStyle(field(container)).display).toBe('none')
        summary(container).click()
        await waitFor(() => open(container) && document.activeElement === code(container), 2000)
        // Pressed, the field opens its dropdown; Escape closes it, the field keeps the focus.
        await userEvent.click(field(container))
        expect(document.activeElement).toBe(field(container))
        expect(rows(container)).toEqual(['Edit properties', 'Add property', 'Collapse when not editing: on', 'Delete front matter'])
        expect(field(container).getAttribute('aria-expanded')).toBe('true')
        await userEvent.keyboard('{Escape}')
        expect(rows(container)).toEqual([])
        expect(document.activeElement).toBe(field(container))
        // ArrowDown from the field goes into the YAML, opening it.
        await userEvent.keyboard('{ArrowDown}')
        await waitFor(() => open(container) && document.activeElement === code(container), 2000)
        // ArrowUp from the YAML's first line comes back to the field.
        await userEvent.keyboard('{ArrowUp}')
        await waitFor(() => document.activeElement === field(container), 2000)
        // Enter opens the dropdown; the arrows and Enter choose: a property added
        // on a fresh last line, the caret there.
        await userEvent.keyboard('{Enter}')
        expect(rows(container).length).toBe(4)
        await userEvent.keyboard('{ArrowDown}{Enter}')
        await waitFor(() => open(container) && document.activeElement === code(container), 2000)
        await userEvent.keyboard('tags: a')
        await waitFor(() => getMarkdownContent(editor) === '---\nid: X1\ntags: a\n---\n\n# Body', 2000)
        // Escape from the field (its dropdown closed) leaves to the note.
        await userEvent.keyboard('{ArrowUp}{ArrowUp}')
        await waitFor(() => document.activeElement === field(container), 2000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !open(container) && editor.state.selection.$from.parent.type.name === 'heading', 2000)
        expect(summary(container).textContent).toBe('2 properties · id, tags')
        // The dropdown's switch turns the fold off, and says so.
        summary(container).click()
        await waitFor(() => open(container) && document.activeElement === code(container), 2000)
        await userEvent.click(field(container))
        await userEvent.click([...head(container).querySelectorAll<HTMLElement>('.cm-search-result')][2])
        await waitFor(() => collapsed(editor) === false, 2000)
        await userEvent.click(field(container))
        expect(rows(container)[2]).toBe('Collapse when not editing: off')
        await userEvent.keyboard('{Escape}')
        // Deleted from the dropdown: the note is its body.
        await userEvent.click(field(container))
        await userEvent.click([...head(container).querySelectorAll<HTMLElement>('.cm-search-result')][3])
        await waitFor(() => editor.state.doc.firstChild?.type.name === 'heading', 2000)
        expect(getMarkdownContent(editor)).toBe('# Body')
    })

    it('stays open when told to, from the block action, and the choice is kept', async () => {
        const { editor, container } = make({ content: '---\nid: X1\n---\n\n# Body' })
        await settled(editor, container)
        expect(open(container)).toBe(false)
        const fold = () => actionsForNode(editor.state.doc.firstChild!, editor).find((a) => a.label === 'Collapse when not editing')!
        expect(fold().checked).toBe(true)
        fold().run({ editor, pos: 0, node: editor.state.doc.firstChild! })
        await waitFor(() => open(container), 2000)
        expect(fold().checked).toBe(false)
        expect(collapsed(editor)).toBe(false)
        await waitFor(() => Object.keys(localStorage).some((k) => k.startsWith('ezco-settings:') && localStorage.getItem(k)!.includes('collapsed: false')), 2000)
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
        expect(collapsed(editor)).toBe(true)
    })

    it('offers the front matter its own actions, shows what a property looks like while empty, and goes on Backspace', async () => {
        const { editor, container } = make({ content: '---\n---\n\n# Body' })
        await settled(editor, container)
        expect(summary(container).textContent).toBe('No properties')
        expect(actionsForNode(editor.state.doc.firstChild!, editor).map((a) => a.label)).toEqual(['Edit properties', 'Add property', 'Collapse when not editing', 'Delete'])
        editor.commands.editFrontMatter()
        await waitFor(() => document.activeElement === code(container), 2000)
        expect(view(container).querySelector('.cm-placeholder')?.textContent).toBe('key: value')
        await userEvent.keyboard('{Backspace}')
        await waitFor(() => editor.state.doc.firstChild?.type.name === 'heading', 2000)
        expect(getMarkdownContent(editor)).toBe('# Body')
    })

    it('has the same gutter menu whether folded, open or selected whole: nothing turns into a heading', async () => {
        const { editor, container } = make({ content: '---\nid: X1\n---\n\n# Body\n\nText.' })
        await settled(editor, container)
        const menu = () => document.querySelector<HTMLElement>('.ezco-mde-block-action-menu')
        const labels = () => [...menu()!.querySelectorAll<HTMLElement>('.ezco-mde-context-menu-item-label')].map((l) => l.textContent)
        const expected = ['Edit properties', 'Add property', 'Collapse when not editing', 'Delete']
        // Folded: its glyph in the gutter pressed selects the block whole
        // (ringed, not opened) and opens its own menu, named for it.
        await userEvent.click(editor.view.dom.querySelector('h1')!)
        await waitFor(() => container.querySelectorAll('.ezco-mde-block-icon').length >= 3, 2000)
        const glyph = [...container.querySelectorAll<HTMLElement>('.ezco-mde-block-icon')].find((g) => g.dataset.blockType === 'frontMatter')!
        await userEvent.click(glyph)
        await waitFor(() => !!menu(), 2000)
        expect(menu()!.querySelectorAll('.ezco-mde-context-menu-separator').length).toBe(1)
        expect(labels()).toEqual(expected)
        expect(open(container)).toBe(false)
        expect(view(container).classList.contains('is-selected')).toBe(true)
        expect(menu()!.querySelector('[role="menuitemcheckbox"]')?.getAttribute('aria-checked')).toBe('true')
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !menu(), 2000)
        // Open, the caret in the YAML: the indicator's menu is the same.
        editor.commands.editFrontMatter()
        await waitFor(() => open(container) && document.activeElement === code(container), 2000)
        const indicator = container.querySelector('.ezco-mde-block-action-btn') as HTMLElement
        await waitFor(() => indicator.style.opacity === '1' && indicator.dataset.blockType === 'frontMatter', 2000)
        await userEvent.click(indicator)
        await waitFor(() => !!menu(), 2000)
        expect(labels()).toEqual(expected)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !menu(), 2000)
    })
})

describe('Writing front matter', () => {
    const code = (container: HTMLElement) => view(container).querySelector('.cm-content') as HTMLElement
    const dashes = () => document.querySelector<HTMLElement>('.ezco-mde-dashes-menu')
    const titles = () => [...document.querySelectorAll<HTMLElement>('.ezco-mde-dashes-menu .ezco-mde-slash-item-title')].map((t) => t.textContent)

    it('asks whether `---` on the first line is front matter or a divider, and makes the one chosen', async () => {
        const { editor, container } = await typing('')
        await userEvent.keyboard('---')
        await waitFor(() => !!dashes(), 2000)
        expect(titles()).toEqual(['Front matter', 'Divider'])
        // Still text until chosen: no divider was made.
        expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
        expect(editor.state.doc.firstChild?.textContent).toBe('---')
        await userEvent.keyboard('{Enter}')
        await waitFor(() => editor.state.doc.firstChild?.type.name === 'frontMatter' && document.activeElement === code(container), 2000)
        expect(dashes()).toBeNull()
        await userEvent.keyboard('title: Plan')
        await waitFor(() => getMarkdownContent(editor) === '---\ntitle: Plan\n---', 2000)

        // The other answer: a divider, as the input rule would have made.
        const other = await typing('')
        await userEvent.keyboard('---')
        await waitFor(() => !!dashes(), 2000)
        await userEvent.keyboard('{ArrowDown}{Enter}')
        await waitFor(() => other.editor.state.doc.firstChild?.type.name === 'horizontalRule', 2000)
        expect(dashes()).toBeNull()
    })

    it('leaves the dashes as text on Escape, and makes a divider at once anywhere else', async () => {
        const { editor } = await typing('')
        await userEvent.keyboard('---')
        await waitFor(() => !!dashes(), 2000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !dashes(), 2000)
        expect(editor.state.doc.firstChild?.textContent).toBe('---')
        // Not asked again until typed on.
        editor.commands.setTextSelection(2)
        editor.commands.setTextSelection(4)
        await new Promise((r) => setTimeout(r, 50))
        expect(dashes()).toBeNull()

        // In a second block the dashes are a divider, no question asked.
        const later = await typing('Text')
        await userEvent.keyboard('{Enter}---')
        await waitFor(() => later.editor.state.doc.childCount >= 2 && later.editor.state.doc.child(1).type.name === 'horizontalRule', 2000)
        expect(dashes()).toBeNull()

        // With front matter already, the first body line's dashes are a divider too.
        const has = make({ content: '---\nid: X\n---\n\nBody' })
        await waitFor(() => has.editor.state.doc.childCount === 2, 2000)
        await userEvent.click(has.editor.view.dom)
        has.editor.commands.setTextSelection(has.editor.state.doc.firstChild!.nodeSize + 1)
        await userEvent.keyboard('{Enter}{ArrowUp}---')
        await waitFor(() => has.editor.state.doc.content.content.some((n) => n.type.name === 'horizontalRule'), 2000)
        expect(dashes()).toBeNull()
    })

    it('comes from the slash menu: made and opened, or opened when the note has some', async () => {
        const { editor, container } = await typing('')
        await userEvent.keyboard('/front')
        await waitFor(() => !!document.querySelector('.ezco-mde-slash-menu'), 2000)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => editor.state.doc.firstChild?.type.name === 'frontMatter' && document.activeElement === code(container), 2000)
        await userEvent.keyboard('a: 1')
        await waitFor(() => getMarkdownContent(editor) === '---\na: 1\n---', 2000)
        // Again, from the body: the same block opens, the caret at its end.
        await userEvent.keyboard('{Escape}')
        await waitFor(() => editor.state.selection.$from.parent.type.name === 'paragraph', 2000)
        await userEvent.keyboard('/front{Enter}')
        await waitFor(() => document.activeElement === code(container), 2000)
        await userEvent.keyboard('{Enter}b: 2')
        await waitFor(() => getMarkdownContent(editor) === '---\na: 1\nb: 2\n---', 2000)
    })

    it('is given to every note when the host asks (`ensure`), empty, outside the undo history', async () => {
        const { editor } = make({ content: '# A', frontMatter: { ensure: true } })
        await waitFor(() => editor.state.doc.firstChild?.type.name === 'frontMatter', 2000)
        expect(getMarkdownContent(editor)).toBe('---\n---\n\n# A')
        editor.commands.undo()
        expect(getMarkdownContent(editor)).toBe('---\n---\n\n# A')

        const fs = memoryVfs({ 'a.md': '# A\n\nBody.' })
        const opened = make({ fs: { fs, filepath: 'a.md', autoSave: true }, frontMatter: { ensure: true } })
        await waitFor(() => opened.editor.state.doc.firstChild?.type.name === 'frontMatter', 3000)
        await new Promise((r) => setTimeout(r, 700))
        expect(await fs.readFile('a.md')).toBe('---\n---\n\n# A\n\nBody.')
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
