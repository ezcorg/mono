import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { MarkdownEditor } from '../index'
import { getMarkdownContent, trackEditors, waitFor } from '../../../test/utils'

/**
 * The slash menu as a person uses it: `/` typed on a word boundary opens
 * it under the slash, what follows filters it, the arrows move through it,
 * Enter and a press run the command over the typed range, Escape and a
 * press elsewhere close it.
 */
let outside: HTMLButtonElement | null = null
const { make } = trackEditors({
    also: () => {
        outside?.remove()
        outside = null
    },
})

/** An editor with the default commands, the caret at the end of `content`. */
async function typing(content: string): Promise<MarkdownEditor> {
    const { editor } = make(content)
    await userEvent.click(editor.view.dom)
    editor.commands.focus('end')
    return editor
}

/** Something to press that is neither the menu nor the note: the far corner. */
function elsewhere(): HTMLButtonElement {
    outside = document.createElement('button')
    outside.type = 'button'
    outside.textContent = 'elsewhere'
    outside.style.cssText = 'position: fixed; right: 8px; bottom: 8px;'
    document.body.append(outside)
    return outside
}

const menu = () => document.querySelector<HTMLElement>('.ezco-mde-slash-menu')
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.ezco-mde-slash-menu .ezco-mde-slash-item'))
const titles = () => rows().map((r) => r.querySelector('.ezco-mde-slash-item-title')?.textContent)
const selected = () => document.querySelector('.ezco-mde-slash-menu .ezco-mde-slash-item.is-selected .ezco-mde-slash-item-title')?.textContent
/** The note's top-level blocks, by type (a trailing paragraph may follow a list or heading). */
const blocks = (editor: MarkdownEditor) => editor.state.doc.content.content.map((n) => n.type.name)

describe('Slash commands', () => {
    it('opens under a typed `/` with every command, the first selected, and filters as the query is typed', async () => {
        const editor = await typing('Hello')
        await userEvent.keyboard('{Enter}/')
        await waitFor(() => !!menu(), 2000)
        expect(titles()).toEqual(['Heading 1', 'Heading 2', 'Heading 3', 'Bullet list', 'Numbered list', 'Task list', 'Code block', 'Quote', 'Callout', 'Math block', 'Footnote', 'Table', 'Divider'])
        expect(selected()).toBe('Heading 1')
        expect(rows()[0].getAttribute('aria-selected')).toBe('true')
        expect(rows()[1].getAttribute('aria-selected')).toBe('false')
        // The rows draw the chip, the title and the description.
        expect(rows()[0].querySelector('.ezco-mde-slash-item-icon')?.textContent).toBe('H1')
        expect(rows()[0].querySelector('.ezco-mde-slash-item-desc')?.textContent).toBe('Large section heading')
        // Under the slash: the menu's top at or below the line's bottom, its left at the slash.
        const slash = editor.view.coordsAtPos(editor.state.selection.from - 1)
        const box = menu()!.getBoundingClientRect()
        expect(box.top).toBeGreaterThanOrEqual(slash.bottom)
        expect(Math.abs(box.left - slash.left)).toBeLessThan(2)

        await userEvent.keyboard('head')
        await waitFor(() => rows().length === 3, 2000)
        expect(titles()).toEqual(['Heading 1', 'Heading 2', 'Heading 3'])
        expect(selected()).toBe('Heading 1')
        await userEvent.keyboard('zz')
        await waitFor(() => rows().length === 0, 2000)
        expect(menu()?.querySelector('.ezco-mde-slash-empty')?.textContent).toBe('No commands matching “headzz”')
    })

    it('moves with the arrows (wrapping at the end), and Enter runs the selected command over the typed range', async () => {
        const editor = await typing('Hello')
        await userEvent.keyboard('{Enter}/head')
        await waitFor(() => rows().length === 3, 2000)
        await userEvent.keyboard('{ArrowDown}')
        expect(selected()).toBe('Heading 2')
        await userEvent.keyboard('{ArrowUp}')
        expect(selected()).toBe('Heading 1')
        await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
        expect(selected()).toBe('Heading 1')
        await userEvent.keyboard('{ArrowDown}{ArrowDown}')
        expect(selected()).toBe('Heading 3')
        // The selected row is the one lit; the caret has not moved.
        expect(document.querySelectorAll('.ezco-mde-slash-item.is-selected')).toHaveLength(1)
        expect(editor.state.doc.textContent).toBe('Hello/head')

        await userEvent.keyboard('{Enter}')
        await waitFor(() => !menu(), 2000)
        expect(blocks(editor)).toContain('heading')
        const heading = editor.state.doc.content.content.find((n) => n.type.name === 'heading')!
        expect(heading.attrs.level).toBe(3)
        expect(heading.textContent).toBe('')
        await userEvent.keyboard('Third')
        expect(getMarkdownContent(editor)).toMatch(/^Hello\n\n### Third/)
    })

    it('runs a command on a press, keeping the note’s focus', async () => {
        const editor = await typing('Hello')
        await userEvent.keyboard('{Enter}/bul')
        await waitFor(() => rows().length === 1, 2000)
        await userEvent.click(rows()[0])
        await waitFor(() => !menu(), 2000)
        expect(blocks(editor)).toContain('bulletList')
        expect(editor.state.doc.textContent).toBe('Hello')
        expect(editor.isFocused).toBe(true)
        await userEvent.keyboard('one')
        expect(getMarkdownContent(editor)).toMatch(/^Hello\n\n\* one/)
    })

    it('closes on Escape, leaving the slash as typed', async () => {
        const editor = await typing('Hello')
        await userEvent.keyboard('{Enter}/tab')
        await waitFor(() => rows().length === 1, 2000)
        expect(titles()).toEqual(['Table'])
        await userEvent.keyboard('{Escape}')
        expect(menu()).toBeNull()
        expect(editor.state.doc.textContent).toBe('Hello/tab')
        // Closed is closed: more of the query does not bring it back.
        await userEvent.keyboard('l')
        await new Promise((r) => setTimeout(r, 100))
        expect(menu()).toBeNull()
        expect(editor.state.doc.textContent).toBe('Hello/tabl')
    })

    it('closes on ArrowUp from the first row, the caret staying put', async () => {
        const editor = await typing('Hello')
        await userEvent.keyboard('{Enter}/')
        await waitFor(() => !!menu(), 2000)
        const before = editor.state.selection.from
        await userEvent.keyboard('{ArrowUp}')
        expect(menu()).toBeNull()
        expect(editor.state.selection.from).toBe(before)
    })

    it('closes on a press elsewhere, and on the caret leaving the slash', async () => {
        const editor = await typing('Hello')
        const away = elsewhere()
        await userEvent.keyboard('{Enter}/')
        await waitFor(() => !!menu(), 2000)
        await userEvent.click(away)
        await waitFor(() => !menu(), 2000)
        expect(editor.state.doc.textContent).toBe('Hello/')

        // Back in the note (the press took the focus), the caret leaving the slash closes it.
        await userEvent.click(editor.view.dom)
        editor.commands.focus('end')
        await userEvent.keyboard(' /')
        await waitFor(() => !!menu(), 2000)
        await userEvent.keyboard(' ')
        await waitFor(() => !menu(), 2000)
    })

    it('does not open for a slash inside a word', async () => {
        const editor = await typing('TCP')
        await userEvent.keyboard('/IP')
        await new Promise((r) => setTimeout(r, 150))
        expect(menu()).toBeNull()
        expect(editor.state.doc.textContent).toBe('TCP/IP')
    })
})
