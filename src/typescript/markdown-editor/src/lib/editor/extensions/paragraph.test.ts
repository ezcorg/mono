import { describe, it, expect } from 'vitest'
import { getMarkdownContent, trackEditors } from '../../../test/utils'

const editors = trackEditors()
const make = (content: string) => editors.make(content).editor

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
