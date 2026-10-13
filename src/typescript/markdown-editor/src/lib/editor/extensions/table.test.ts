import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, frames, getMarkdownContent, trackEditors } from '../../../test/utils'

const { created } = trackEditors()

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

describe('Keys in a table', () => {
    const TABLE = 'Before.\n\n| a | b |\n| --- | --- |\n| x | y |\n\nAfter.'
    /** An editor on the table, mounted (Tiptap mounts after a tick) and focused, the caret at the end of `text`. */
    async function caretAfter(text: string) {
        const container = createTestContainer(`table-keys-${created.length}`)
        const editor = createEditor({ element: container, content: TABLE })
        created.push({ editor, container })
        await frames()
        editor.commands.focus()
        await frames()
        let at = -1
        editor.state.doc.descendants((node, pos) => {
            if (at < 0 && node.isText && node.text === text) at = pos + node.nodeSize
        })
        editor.commands.setTextSelection(at)
        return editor
    }
    const blockText = (editor: MarkdownEditor) => editor.state.selection.$from.parent.textContent
    const rowCount = (editor: MarkdownEditor) => {
        let n = 0
        editor.state.doc.descendants((node) => { if (node.type.name === 'tableRow') n++ })
        return n
    }
    /** The row the caret's cell is in (the first is 0), or null outside a table. */
    const rowOf = (editor: MarkdownEditor) => {
        const { $from } = editor.state.selection
        for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'tableRow') return $from.index(d - 1)
        return null
    }

    it('Tab moves to the next cell and Shift-Tab back', async () => {
        const editor = await caretAfter('x')
        expect(blockText(editor)).toBe('x')
        await userEvent.keyboard('{Tab}')
        expect(blockText(editor)).toBe('y')
        expect(editor.state.selection.empty || editor.state.selection.$from.parent.textContent === 'y').toBe(true)
        await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
        expect(blockText(editor)).toBe('x')
        expect(rowCount(editor)).toBe(2)
        expect(getMarkdownContent(editor)).toBe(TABLE)
    })

    it('Tab in the last cell adds a row and moves into its first cell', async () => {
        const editor = await caretAfter('y')
        await userEvent.keyboard('{Tab}')
        expect(rowCount(editor)).toBe(3)
        expect(rowOf(editor)).toBe(2)
        expect(blockText(editor)).toBe('')
        await userEvent.keyboard('z')
        expect(getMarkdownContent(editor)).toBe('Before.\n\n| a | b |\n| --- | --- |\n| x | y |\n| z |  |\n\nAfter.')
    })

    it('Enter in a cell starts a new paragraph in that cell, not a new row; written on the cell’s one line', async () => {
        const editor = await caretAfter('x')
        await userEvent.keyboard('{Enter}')
        expect(rowCount(editor)).toBe(2)
        expect(rowOf(editor)).toBe(1)
        const cell = editor.state.selection.$from.node(-1)
        expect(cell.type.name).toBe('tableCell')
        expect(cell.childCount).toBe(2)
        await userEvent.keyboard('z')
        expect(getMarkdownContent(editor)).toBe('Before.\n\n| a | b |\n| --- | --- |\n| x z | y |\n\nAfter.')
    })

    it('ArrowDown from the last row leaves for the paragraph after the table, ArrowUp from the header for the one before', async () => {
        const editor = await caretAfter('x')
        await userEvent.keyboard('{ArrowDown}')
        expect(rowOf(editor)).toBeNull()
        expect(blockText(editor)).toBe('After.')
        const up = await caretAfter('a')
        await userEvent.keyboard('{ArrowUp}')
        expect(rowOf(up)).toBeNull()
        expect(blockText(up)).toBe('Before.')
        // Within the table, the arrows walk the rows.
        const inner = await caretAfter('a')
        await userEvent.keyboard('{ArrowDown}')
        expect(rowOf(inner)).toBe(1)
        expect(blockText(inner)).toBe('x')
        await userEvent.keyboard('{ArrowUp}')
        expect(rowOf(inner)).toBe(0)
        expect(blockText(inner)).toBe('a')
    })
})
