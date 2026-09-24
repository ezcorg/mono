import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { createEditor, MarkdownEditor, MarkdownEditorOptions } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

function make(options: MarkdownEditorOptions) {
    const container = createTestContainer(`math-${created.length}`)
    const editor = createEditor({ element: container, ...options })
    created.push({ editor, container })
    return { editor, container }
}

const nodes = (editor: MarkdownEditor, name: string) => {
    const out: { text: string; attrs: Record<string, unknown> }[] = []
    editor.state.doc.descendants((n) => {
        if (n.type.name === name) out.push({ text: n.textContent, attrs: n.attrs })
    })
    return out
}

describe('Math syntax', () => {
    const roundTrips = [
        'Euler: $e^{i\\pi} + 1 = 0$, and $x_1$.',
        '$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$',
        '$$x^2 + y^2$$',
        'Display inside a paragraph: $$a = b$$ here.',
        'A price is text: it costs $5 and $10, and $ 3$ too.',
        '* a list item with $\\sqrt{2}$\n* and another',
        '> $$\n> \\sum_i i\n> $$',
    ]

    it.each(roundTrips)('round-trips %j byte for byte', (md) => {
        const { editor } = make({ content: md })
        expect(getMarkdownContent(editor)).toBe(md)
    })

    it('parses TeX into math nodes, inline and block', () => {
        const { editor } = make({ content: 'Inline $a+b$ and $$c$$.\n\n$$\nd\n$$' })
        expect(nodes(editor, 'mathInline')).toEqual([
            { text: 'a+b', attrs: { display: false } },
            { text: 'c', attrs: { display: true } },
        ])
        expect(nodes(editor, 'mathBlock')).toEqual([{ text: 'd', attrs: { oneLine: false } }])
    })

    it('keeps literal dollars literal: escaped when they would read back as math', () => {
        const { editor } = make({ content: 'Not math: \\$x\\$ and \\$y$.' })
        expect(nodes(editor, 'mathInline')).toHaveLength(0)
        const saved = getMarkdownContent(editor)
        const { editor: reloaded } = make({ content: saved })
        expect(nodes(reloaded, 'mathInline')).toHaveLength(0)
        expect(reloaded.getText()).toBe('Not math: $x$ and $y$.')
    })

    it('stays text when turned off', () => {
        const { editor } = make({ content: 'a $x$ b', math: false })
        expect(nodes(editor, 'mathInline')).toHaveLength(0)
    })
})

describe('Math view', () => {
    it('typesets with KaTeX, and shows the TeX once the caret is in it', async () => {
        const { editor, container } = make({ content: 'Pythagoras: $a^2+b^2=c^2$ holds.' })
        const math = () => container.querySelector('.ezco-mde-math-inline') as HTMLElement
        await waitFor(() => !!math()?.querySelector('.katex'), 5000)
        expect(math().classList.contains('is-editing')).toBe(false)
        // Arrow right from just before the formula steps into its source.
        await userEvent.click(editor.view.dom)
        let before = 0
        editor.state.doc.descendants((n, pos) => {
            if (n.type.name === 'mathInline') before = pos
        })
        editor.commands.setTextSelection(before)
        await userEvent.keyboard('{ArrowRight}')
        await waitFor(() => math().classList.contains('is-editing'), 2000)
        expect(editor.state.selection.$from.parent.type.name).toBe('mathInline')
    })

    it('typesets through the renderer the host supplies', async () => {
        const seen: [string, boolean][] = []
        const { container } = make({
            content: '$x$\n\n$$\ny\n$$',
            math: {
                renderer: (tex, el, { displayMode }) => {
                    seen.push([tex, displayMode])
                    el.textContent = `<${tex}>`
                },
            },
        })
        await waitFor(() => seen.length === 2, 2000)
        expect(seen).toEqual([
            ['x', false],
            ['y', true],
        ])
        await waitFor(() => container.querySelector('.ezco-mde-math-block .ezco-mde-source-preview')?.textContent === '<y>', 2000)
    })

    it('makes inline math when `$…$` is typed', async () => {
        const { editor } = make({ content: '' })
        await userEvent.click(editor.view.dom)
        await userEvent.keyboard('so $x^2$')
        await waitFor(() => nodes(editor, 'mathInline').length === 1, 2000)
        expect(getMarkdownContent(editor)).toBe('so $x^2$')
    })
})
