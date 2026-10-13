import { describe, it, expect, afterEach } from 'vitest'
import { AllSelection } from '@tiptap/pm/state'
import { MarkdownEditor } from '../index'
import { createTestContainer, createTestEditor, cleanupEditor, waitFor } from '../../../test/utils'

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))

/**
 * The contextual selection menu surfaces a button (`.ezco-mde-selection-menu-btn`,
 * opacity 1 when shown) at the end of a non-empty prose selection. This pins the
 * regression where select-all — which yields an `AllSelection`, not a
 * `TextSelection` — failed to surface it.
 */
describe('Selection menu', () => {
    const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []

    afterEach(() => {
        created.forEach((c) => cleanupEditor(c.editor, c.container))
        created.length = 0
    })

    async function make(content: string): Promise<{ editor: MarkdownEditor; container: HTMLElement }> {
        const container = createTestContainer(`sel-${created.length}`)
        const editor = await createTestEditor(container, { content })
        created.push({ editor, container })
        return { editor, container }
    }

    const btnOpacity = (container: HTMLElement) =>
        (container.querySelector('.ezco-mde-selection-menu-btn') as HTMLElement | null)?.style.opacity

    it('shows for select-all (AllSelection — Cmd/Ctrl-A)', async () => {
        const { editor, container } = await make('# Title\n\nHello world paragraph.')
        editor.view.focus()
        // Exactly what the Mod-a baseKeymap binding produces.
        editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
        await tick()
        expect(btnOpacity(container)).toBe('1')
    })

    it('shows for an ordinary range selection', async () => {
        const { editor, container } = await make('# Title\n\nHello world paragraph.')
        editor.view.focus()
        editor.commands.setTextSelection({ from: 2, to: 6 })
        await tick()
        expect(btnOpacity(container)).toBe('1')
    })

    it('is hidden for a collapsed caret', async () => {
        const { editor, container } = await make('# Title\n\nHello world paragraph.')
        editor.view.focus()
        editor.commands.setTextSelection(3)
        await tick()
        expect(btnOpacity(container)).toBe('0')
    })

    it('gives way to the comment composer: Comment chosen, the button goes and the composer stands by the selection', async () => {
        const container = createTestContainer(`sel-${created.length}`)
        const editor = await createTestEditor(container, { content: '# Title\n\nHello world paragraph.', comments: { author: 'theo' } })
        created.push({ editor, container })
        editor.view.focus()
        editor.commands.setTextSelection({ from: 10, to: 21 })
        const btn = container.querySelector('.ezco-mde-selection-menu-btn') as HTMLElement
        await waitFor(() => btn.style.opacity === '1')
        btn.click()
        await waitFor(() => !!document.querySelector('.ezco-mde-selection-menu'))
        const item = [...document.querySelectorAll<HTMLElement>('.ezco-mde-selection-menu .ezco-mde-context-menu-item')].find((i) => i.textContent?.trim().endsWith('Comment'))
        expect(item).toBeDefined()
        item!.click()
        await waitFor(() => !document.querySelector('.ezco-mde-selection-menu'))
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-over .ezco-mde-comment-card'))
        await waitFor(() => btn.style.opacity === '0')
        const composer = container.querySelector('.ezco-mde-comment-over .ezco-mde-comment-card') as HTMLElement
        await waitFor(() => composer.style.top !== '')
        // The composer by the end of the selection, where the button was,
        // which it does not cover since the button is gone.
        const end = editor.view.coordsAtPos(21, -1)
        expect(composer.getBoundingClientRect().top).toBeGreaterThanOrEqual(end.bottom)
        expect(composer.getBoundingClientRect().top - end.bottom).toBeLessThan(16)
        editor.commands.cancelComment()
        editor.commands.focus()
        editor.commands.setTextSelection({ from: 10, to: 21 })
        await waitFor(() => btn.style.opacity === '1')
    })

    it('anchors at the end of the text on select-all (not the editor corner)', async () => {
        // The doc ends with a horizontal rule, so the document's very end (what
        // the button used to track on select-all) sits below/after the last
        // text — dropping the menu away from the content.
        const { editor, container } = await make('# Title\n\nThe last line of text.\n\n---')
        editor.view.focus()
        editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
        await tick()

        const btn = container.querySelector('.ezco-mde-selection-menu-btn') as HTMLElement
        expect(btn?.style.opacity).toBe('1')

        let lastTextEnd = -1
        editor.state.doc.descendants((node, pos) => {
            if (node.isText) lastTextEnd = pos + node.nodeSize
            return true
        })
        // The trailing rule really is past the last text.
        expect(lastTextEnd).toBeGreaterThan(0)
        expect(lastTextEnd).toBeLessThan(editor.state.doc.content.size)

        // The button is anchored just below the end of the last *text* line,
        // not down at the rule / editor bottom-right.
        const wrapper = (editor.view.dom.parentElement as HTMLElement).getBoundingClientRect()
        const textCoords = editor.view.coordsAtPos(lastTextEnd, -1)
        const expectedTop = textCoords.bottom - wrapper.top + 3
        expect(Math.abs(parseFloat(btn.style.top) - expectedTop)).toBeLessThan(8)
    })
})
