import { describe, it, expect, afterEach } from 'vitest'
import { MarkdownEditor } from '../index'
import {
    createTestContainer,
    createTestEditor,
    cleanupEditor,
    getMarkdownContent,
} from '../../../test/utils'

/**
 * `WrapSelection`: typing a wrapping character over a non-empty selection
 * surrounds the selected text instead of replacing it. Driven through the same
 * `handleTextInput` prop ProseMirror itself invokes for typed input, so these
 * exercise the real handler path.
 */
describe('Smart selection wrap', () => {
    const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []

    afterEach(() => {
        created.forEach((c) => cleanupEditor(c.editor, c.container))
        created.length = 0
    })

    async function make(content: string): Promise<MarkdownEditor> {
        const container = createTestContainer(`wrap-${created.length}`)
        const editor = await createTestEditor(container, { content })
        created.push({ editor, container })
        return editor
    }

    /** Select the (first) occurrence of `sub` in a single-paragraph doc. */
    function selectWord(editor: MarkdownEditor, sub: string): { from: number; to: number } {
        const text = editor.state.doc.textBetween(0, editor.state.doc.content.size)
        const idx = text.indexOf(sub)
        // Single top-level paragraph → doc pos = text offset + 1.
        const from = idx + 1
        const to = from + sub.length
        expect(editor.state.doc.textBetween(from, to)).toBe(sub)
        editor.commands.setTextSelection({ from, to })
        return { from, to }
    }

    /** Fire the typed character through ProseMirror's input pipeline. */
    function type(editor: MarkdownEditor, char: string): boolean {
        const { from, to } = editor.state.selection
        return !!editor.view.someProp('handleTextInput', (f) =>
            f(editor.view, from, to, char),
        )
    }

    it('wraps a selection in inline code on `', async () => {
        const editor = await make('Hello world')
        selectWord(editor, 'world')

        expect(type(editor, '`')).toBe(true)
        expect(editor.state.doc.rangeHasMark(7, 12, editor.schema.marks.code)).toBe(true)
        expect(getMarkdownContent(editor)).toContain('`world`')
    })

    it('encloses a selection in [ ] on [', async () => {
        const editor = await make('Hello world')
        selectWord(editor, 'world')

        expect(type(editor, '[')).toBe(true)
        expect(editor.state.doc.textContent).toBe('Hello [world]')
        // The inner text stays selected, now between the brackets.
        const { from, to } = editor.state.selection
        expect(editor.state.doc.textBetween(from, to)).toBe('world')
    })

    it('does nothing for a collapsed caret (normal typing proceeds)', async () => {
        const editor = await make('Hello world')
        editor.commands.setTextSelection(3) // collapsed
        expect(type(editor, '`')).toBe(false)
        expect(type(editor, '[')).toBe(false)
        expect(editor.state.doc.textContent).toBe('Hello world')
    })
})
