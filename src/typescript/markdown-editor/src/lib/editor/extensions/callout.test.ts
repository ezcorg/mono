import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

function make(content: string, options: { callouts?: boolean } = {}) {
    const container = createTestContainer(`co-${created.length}`)
    const editor = createEditor({ element: container, content, ...options })
    created.push({ editor, container })
    return { editor, container }
}

const callouts = (c: HTMLElement) => [...c.querySelectorAll('.ezco-mde-callout')] as HTMLElement[]

describe('Callout syntax', () => {
    const roundTrips = [
        '> [!note] Title\n> The body.',
        '> [!WARNING]-\n> Folded, no title.',
        '> [!tip] Spaced\n>\n> First paragraph.\n>\n> Second.',
        '> [!info]',
        '> [!question]+ A **bold** title\n> * one\n> * two',
        '> [!example] Nested\n> > [!quote] Inner\n> > Said.',
        '> A plain quote stays a quote.',
    ]

    it.each(roundTrips)('round-trips %j byte for byte', (md) => {
        const { editor } = make(md)
        expect(getMarkdownContent(editor)).toBe(md)
    })

    it('keeps kind, fold and title, and quotes without a kind stay quotes', () => {
        const { editor } = make('> [!Caution]- Careful\n> body\n\n> quote')
        const first = editor.state.doc.firstChild!
        expect(first.type.name).toBe('callout')
        expect(first.attrs).toMatchObject({ kind: 'Caution', fold: '-' })
        expect(first.firstChild!.textContent).toBe('Careful')
        expect(editor.state.doc.child(1).type.name).toBe('blockquote')
    })

    it('keeps a body that starts with a rule, or a line of `=`, from underlining the title', () => {
        for (const [md, first] of [
            ['> [!note] Title\n> ***', 'horizontalRule'],
            ['> [!note] Title\n> \\===', 'paragraph'],
        ] as const) {
            const { editor } = make(md)
            const saved = getMarkdownContent(editor)
            const { editor: again } = make(saved)
            const callout = again.state.doc.firstChild!
            expect(callout.type.name).toBe('callout')
            expect(callout.firstChild!.textContent).toBe('Title')
            expect(callout.child(1).type.name).toBe(first)
            expect(getMarkdownContent(again)).toBe(saved)
        }
    })

    it('stays a quote when turned off', () => {
        const { editor } = make('> [!note] x', { callouts: false })
        expect(editor.state.doc.firstChild!.type.name).toBe('blockquote')
    })
})

describe('Callout view', () => {
    it('draws aliases as their kind, starts folded when marked `-`, and folds without editing', async () => {
        const { editor, container } = make('> [!caution]- Mind\n> hidden\n\n> [!faq] Asked\n> shown')
        await waitFor(() => callouts(container).length === 2, 2000)
        const [warning, question] = callouts(container)
        expect(warning.getAttribute('data-callout-type')).toBe('warning')
        expect(question.getAttribute('data-callout-type')).toBe('question')
        expect(warning.classList.contains('is-collapsed')).toBe(true)
        const before = getMarkdownContent(editor)
        ;(warning.querySelector('.ezco-mde-callout-fold') as HTMLElement).click()
        expect(warning.classList.contains('is-collapsed')).toBe(false)
        expect(getMarkdownContent(editor)).toBe(before)
        expect(question.querySelector('.ezco-mde-callout-fold')?.hasAttribute('hidden')).toBe(true)
    })

    it('cycles the kind from its icon', async () => {
        const { editor, container } = make('> [!note] x\n> y')
        await waitFor(() => callouts(container).length === 1, 2000)
        ;(callouts(container)[0].querySelector('.ezco-mde-callout-icon') as HTMLElement).click()
        expect(getMarkdownContent(editor)).toBe('> [!tip] x\n> y')
    })
})

describe('Making callouts', () => {
    it('turns a quote into a callout when its first line is typed `[!kind] `', async () => {
        const { editor, container } = make('')
        await userEvent.click(editor.view.dom)
        await userEvent.keyboard('> [[!warning] Heads up{Enter}body')
        await waitFor(() => callouts(container).length === 1, 2000)
        expect(getMarkdownContent(editor)).toBe('> [!warning] Heads up\n> body')
    })

    it('wraps a paragraph with setCallout, the caret in the title', () => {
        const { editor } = make('Some text.')
        editor.commands.setTextSelection(3)
        editor.commands.setCallout('info')
        editor.commands.insertContent('Title')
        expect(getMarkdownContent(editor)).toBe('> [!info] Title\n> Some text.')
    })
})
