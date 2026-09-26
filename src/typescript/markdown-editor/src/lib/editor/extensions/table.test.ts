import { describe, it, expect, afterEach } from 'vitest'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

describe('Tables', () => {
    // Cells whose only content is a node with no text of its own.
    const roundTrips = [
        '| a | b |\n| --- | --- |\n| x | [^1] |\n\n[^1]: A note.',
        '| a | b |\n| --- | --- |\n| x | ![](pic.png) |\n\nAfter.',
        '| a |\n| --- |\n| ![pic\\|200](pic.png) |\n\nAfter.',
        '| a | b |\n| --- | --- |\n|  | y |\n\nAfter.',
    ]

    it.each(roundTrips)('round-trips %j byte for byte', (md) => {
        const container = createTestContainer(`table-${created.length}`)
        const editor = createEditor({ element: container, content: md })
        created.push({ editor, container })
        expect(getMarkdownContent(editor)).toBe(md)
    })

    // What GFM cannot say is written as near as GFM comes, never as a marker.
    it('writes a cell holding two blocks (Enter in a cell) on one line', () => {
        const container = createTestContainer(`table-${created.length}`)
        const editor = createEditor({ element: container, content: '| a |\n| --- |\n| x |\n\nAfter.' })
        created.push({ editor, container })
        let cell = -1
        editor.state.doc.descendants((node, pos) => {
            if (cell < 0 && node.isText && node.text === 'x') cell = pos + 1
        })
        editor.commands.setTextSelection(cell)
        editor.commands.splitBlock()
        editor.commands.insertContent('y')
        expect(getMarkdownContent(editor)).toBe('| a |\n| --- |\n| x y |\n\nAfter.')
    })

    it('writes a table with no header row under an empty one', () => {
        const container = createTestContainer(`table-${created.length}`)
        const editor = createEditor({ element: container, content: '| a | b |\n| --- | --- |\n| x | y |\n\nAfter.' })
        created.push({ editor, container })
        editor.commands.setTextSelection(3)
        editor.commands.toggleHeaderRow()
        expect(getMarkdownContent(editor)).toBe('|  |  |\n| --- | --- |\n| a | b |\n| x | y |\n\nAfter.')
        // And that reads back as the same rows.
        const again = createEditor({ content: getMarkdownContent(editor) })
        expect(getMarkdownContent(again)).toBe(getMarkdownContent(editor))
        again.destroy()
    })
})
