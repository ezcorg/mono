import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { getMarkdownContent, trackEditors, waitFor } from '../../../test/utils'
import { calloutKindsMatching } from './callout'

const { make } = trackEditors()

const callouts = (c: HTMLElement) => [...c.querySelectorAll('.ezco-mde-callout')] as HTMLElement[]
const kindMenu = () => document.querySelector<HTMLElement>('.ezco-mde-callout-menu')
const kindRows = () => [...document.querySelectorAll<HTMLElement>('.ezco-mde-callout-menu .ezco-mde-slash-item')]
const kindTitles = () => kindRows().map((r) => r.querySelector('.ezco-mde-slash-item-title')?.textContent)
const kindSelected = () => document.querySelector('.ezco-mde-callout-menu .is-selected .ezco-mde-slash-item-title')?.textContent

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

    it('draws the kind’s icon before the title, and offers every kind from it: the menu filtered by typing, the callout’s own kind selected', async () => {
        const { editor, container } = make('> [!tip] x\n> y')
        await waitFor(() => callouts(container).length === 1, 2000)
        const icon = callouts(container)[0].querySelector('.ezco-mde-callout-icon') as HTMLElement
        expect(icon.textContent).toBe('✦')
        icon.click()
        await waitFor(() => !!kindMenu(), 2000)
        expect(kindTitles()).toEqual(['Note', 'Abstract', 'Info', 'Todo', 'Tip', 'Success', 'Question', 'Warning', 'Failure', 'Danger', 'Bug', 'Example', 'Quote'])
        expect(kindSelected()).toBe('Tip')
        expect(kindRows()[7].dataset.calloutType).toBe('warning')
        expect(icon.getAttribute('aria-expanded')).toBe('true')
        // Typed: the kinds called that (by any of their names), the first selected; nothing lands in the note.
        await userEvent.keyboard('ca')
        expect(kindTitles()).toEqual(['Warning'])
        expect(kindSelected()).toBe('Warning')
        expect(getMarkdownContent(editor)).toBe('> [!tip] x\n> y')
        await userEvent.keyboard('{Backspace}{Backspace}d')
        expect(kindTitles()).toEqual(['Success', 'Danger'])
        await userEvent.keyboard('{ArrowDown}{Enter}')
        await waitFor(() => !kindMenu(), 2000)
        expect(getMarkdownContent(editor)).toBe('> [!danger] x\n> y')
        expect(icon.textContent).toBe('⚡')
        // A second press closes it; Escape too; Backspace on no filter too.
        icon.click()
        await waitFor(() => !!kindMenu(), 2000)
        icon.click()
        await waitFor(() => !kindMenu(), 2000)
        icon.click()
        await waitFor(() => !!kindMenu(), 2000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !kindMenu(), 2000)
        expect(icon.getAttribute('aria-expanded')).toBe('false')
        icon.click()
        await waitFor(() => !!kindMenu(), 2000)
        await userEvent.keyboard('{Backspace}')
        await waitFor(() => !kindMenu(), 2000)
        expect(getMarkdownContent(editor)).toBe('> [!danger] x\n> y')
    })

    it('matches kinds by every name accepted for them', () => {
        expect(calloutKindsMatching('').map((k) => k.type)).toHaveLength(13)
        expect(calloutKindsMatching('tl').map((k) => k.type)).toEqual(['abstract'])
        expect(calloutKindsMatching('T').map((k) => k.type)).toEqual(['abstract', 'todo', 'tip'])
        expect(calloutKindsMatching('xyz')).toEqual([])
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

    it('asks the kind after the slash command, typed to filter', async () => {
        const { editor } = make('Hello')
        await userEvent.click(editor.view.dom)
        editor.commands.focus('end')
        await userEvent.keyboard('{Enter}/call')
        await waitFor(() => document.querySelectorAll('.ezco-mde-slash-menu .ezco-mde-slash-item').length === 1, 2000)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => !!kindMenu(), 2000)
        expect(editor.state.doc.textContent).toBe('Hello')
        await userEvent.keyboard('war{Enter}')
        await waitFor(() => !kindMenu(), 2000)
        await userEvent.keyboard('Heads up{Enter}body')
        expect(getMarkdownContent(editor)).toBe('Hello\n\n> [!warning] Heads up\n> body')
    })

    it('changes kind, folds, and comes apart again by command, a quote or plain blocks', () => {
        const { editor } = make('> [!note] Title\n> one\n> \n> two')
        const pos = 0
        editor.commands.setCalloutKind('bug', pos)
        expect(getMarkdownContent(editor)).toBe('> [!bug] Title\n> one\n>\n> two')
        editor.commands.toggleCalloutFold(pos)
        expect(getMarkdownContent(editor)).toBe('> [!bug]+ Title\n> one\n>\n> two')
        editor.commands.toggleCalloutFold(pos)
        expect(getMarkdownContent(editor)).toBe('> [!bug] Title\n> one\n>\n> two')
        // By the caret, when no position is given.
        editor.commands.setTextSelection(4)
        editor.commands.setCalloutKind('info')
        expect(getMarkdownContent(editor)).toBe('> [!info] Title\n> one\n>\n> two')
        editor.commands.calloutToQuote(pos)
        expect(getMarkdownContent(editor)).toBe('> Title\n>\n> one\n>\n> two')
        editor.commands.setCallout('tip')
        expect(getMarkdownContent(editor)).toBe('> [!tip]\n> Title\n>\n> one\n>\n> two')
        editor.commands.unsetCallout()
        expect(getMarkdownContent(editor)).toBe('Title\n\none\n\ntwo')
    })
})
