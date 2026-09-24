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
})
