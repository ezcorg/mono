import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

function make(content: string, options: { footnotes?: boolean } = {}) {
    const container = createTestContainer(`fn-${created.length}`)
    const editor = createEditor({ element: container, content, ...options })
    created.push({ editor, container })
    return { editor, container }
}

const refs = (c: HTMLElement) => [...c.querySelectorAll('sup.ezco-mde-footnote-ref')] as HTMLElement[]
const defs = (c: HTMLElement) => [...c.querySelectorAll('section.ezco-mde-footnote-def')] as HTMLElement[]

describe('Footnote syntax', () => {
    const roundTrips = [
        'A claim[^1] and another[^note].\n\n[^1]: The first.\n\n[^note]: The second.',
        'Definitions stay where written[^a].\n\n[^a]: Right here.\n\nThen more text.',
        'Several blocks[^long].\n\n[^long]: First paragraph.\n\n    Second paragraph, indented under it.\n\n    * and a list',
        'A thread[^c-01J9K].\n\n[^c-01J9K]: @theo 2026-09-13 · open\n\n    * @alice: a reply',
        'In a table:\n\n| a | b |\n| --- | --- |\n| x[^t] | y |\n\n[^t]: Defined.',
    ]

    it.each(roundTrips)('round-trips %j byte for byte', (md) => {
        const { editor } = make(md)
        expect(getMarkdownContent(editor)).toBe(md)
    })

    it('stays text when turned off', () => {
        const { container } = make('x[^1]\n\n[^1]: y', { footnotes: false })
        expect(refs(container)).toHaveLength(0)
    })
})

describe('Footnote view', () => {
    it('numbers references by first use, and marks what is missing', async () => {
        const { container } = make('B[^b] then A[^a] then B again[^b], and C[^c].\n\n[^a]: a\n\n[^b]: b\n\n[^z]: unreferenced')
        await waitFor(() => refs(container).length === 4, 2000)
        expect(refs(container).map((r) => r.textContent)).toEqual(['1', '2', '1', '3'])
        expect(refs(container).map((r) => r.classList.contains('is-missing'))).toEqual([false, false, false, true])
        expect(defs(container).map((d) => d.querySelector('.ezco-mde-footnote-label')?.textContent)).toEqual(['2', '1', 'z'])
        expect(defs(container)[2].classList.contains('is-unreferenced')).toBe(true)
    })

    it('goes from a reference to its definition and back', async () => {
        const { editor, container } = make('Text[^n].\n\nMiddle.\n\n[^n]: The note.')
        await waitFor(() => refs(container).length === 1, 2000)
        refs(container)[0].click()
        await waitFor(() => editor.state.selection.$from.node(1)?.type.name === 'footnoteDefinition', 2000)
        ;(defs(container)[0].querySelector('.ezco-mde-footnote-label') as HTMLElement).click()
        await waitFor(() => (editor.state.selection as any).node?.type.name === 'footnoteReference', 2000)
    })

    it('inserts a numbered footnote with its definition at the end, the caret in it', async () => {
        const { editor } = make('One[^1].\n\n[^1]: first')
        editor.commands.setTextSelection(4)
        editor.commands.insertFootnote()
        await userEvent.keyboard('second')
        expect(getMarkdownContent(editor)).toBe('One[^2][^1].\n\n[^1]: first\n\n[^2]: second')
    })

    it('makes a reference when `[^label]` is typed, and a definition when a line starts `[^label]: `', async () => {
        const { editor, container } = make('')
        await userEvent.click(editor.view.dom)
        await userEvent.keyboard('See[[^x]{Enter}[[^x]: ')
        await waitFor(() => defs(container).length === 1, 2000)
        await userEvent.keyboard('the note')
        expect(getMarkdownContent(editor)).toBe('See[^x]\n\n[^x]: the note')
    })
})
