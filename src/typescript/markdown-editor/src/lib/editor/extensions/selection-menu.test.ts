import { describe, it, expect, afterEach } from 'vitest'
import { AllSelection } from '@tiptap/pm/state'
import { MarkdownEditor } from '../index'
import { createTestContainer, createTestEditor, cleanupEditor } from '../../../test/utils'

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
})
