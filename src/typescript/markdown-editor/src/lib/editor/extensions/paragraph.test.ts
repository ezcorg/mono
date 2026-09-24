import { describe, it, expect, afterEach } from 'vitest'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

function make(content: string) {
    const container = createTestContainer(`para-${created.length}`)
    const editor = createEditor({ element: container, content })
    created.push({ editor, container })
    return editor
}

describe('Paragraph spacing', () => {
    it('keeps empty paragraphs between blocks across a save and load', () => {
        const md = 'A\n\n \n\n \n\nB'
        const editor = make(md)
        expect(editor.state.doc.childCount).toBe(4)
        expect(getMarkdownContent(editor)).toBe(md)
    })

    it('writes nothing for empty paragraphs at the end of the note', () => {
        const editor = make('A')
        editor.commands.focus('end')
        editor.commands.enter()
        editor.commands.enter()
        expect(editor.state.doc.childCount).toBe(3)
        expect(getMarkdownContent(editor)).toBe('A')
        editor.commands.setContent('')
        expect(getMarkdownContent(editor)).toBe('')
    })
})
