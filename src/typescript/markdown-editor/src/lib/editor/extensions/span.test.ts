import { describe, it, expect, afterEach } from 'vitest'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent } from '../../../test/utils'
import { formatSpanAttributes, parseSpanAttributes } from './span'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

function open(content: string) {
    const container = createTestContainer(`span-${created.length}`)
    const editor = createEditor({ element: container, content })
    created.push({ editor, container })
    return { editor }
}

describe('A bracketed span’s attributes', () => {
    it('are read and written as Pandoc writes them', () => {
        expect(parseSpanAttributes('#c-1 .a .b key=v quoted="two words"')).toEqual({ id: 'c-1', classes: 'a b', attributes: { key: 'v', quoted: 'two words' } })
        expect(parseSpanAttributes('')).toBeNull()
        expect(parseSpanAttributes('#a #b')).toBeNull()
        expect(parseSpanAttributes('not attributes')).toBeNull()
        expect(formatSpanAttributes({ id: 'c-1', classes: 'a b', attributes: { key: 'v', quoted: 'two words' } })).toBe('{#c-1 .a .b key=v quoted="two words"}')
    })
})

describe('Bracketed spans', () => {
    it('round-trip with their attributes, and leave what is not one alone', () => {
        const md = 'The [quick]{.adjective} fox, [a *b*]{#x .y key="v w" k2=v} and [a link](url).'
        const spans = (editor: MarkdownEditor) => {
            const out: Record<string, unknown>[] = []
            editor.state.doc.descendants((node) => {
                for (const m of node.marks) if (m.type.name === 'span') out.push(m.attrs)
            })
            return out
        }
        const { editor } = open(md)
        expect(getMarkdownContent(editor)).toBe(md)
        expect(spans(editor)).toEqual([
            { id: null, classes: 'adjective', attributes: {} },
            { id: 'x', classes: 'y', attributes: { key: 'v w', k2: 'v' } },
            { id: 'x', classes: 'y', attributes: { key: 'v w', k2: 'v' } },
        ])
        // Braces with no attribute in them make no span.
        expect(spans(open('[not one]{} here').editor)).toEqual([])
    })
})

