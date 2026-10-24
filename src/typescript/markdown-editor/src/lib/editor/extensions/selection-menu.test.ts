import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import type { JSONContent } from '@tiptap/core'
import { AllSelection } from '@tiptap/pm/state'
import { MarkdownEditor, MarkdownEditorOptions } from '../index'
import { createTestContainer, createTestEditor, getMarkdownContent, menuItem, menuLabels, tick, trackEditors, waitFor } from '../../../test/utils'

/**
 * The contextual selection menu surfaces a button (`.ezco-mde-selection-menu-btn`,
 * opacity 1 when shown) at the end of a non-empty prose selection. This pins the
 * regression where select-all — which yields an `AllSelection`, not a
 * `TextSelection` — failed to surface it.
 *
 * The second half drives the menu as a person does: the button pressed, an
 * item pressed or chosen with the keys, and what each action leaves in the
 * note.
 */
describe('Selection menu', () => {
    const { created } = trackEditors()

    async function make(content: string, options: Partial<MarkdownEditorOptions> = {}): Promise<{ editor: MarkdownEditor; container: HTMLElement }> {
        const container = createTestContainer(`sel-${created.length}`)
        const editor = await createTestEditor(container, { content, ...options })
        created.push({ editor, container })
        return { editor, container }
    }

    const button = (container: HTMLElement) => container.querySelector('.ezco-mde-selection-menu-btn') as HTMLElement
    const btnOpacity = (container: HTMLElement) => button(container)?.style.opacity
    const menu = () => document.querySelector<HTMLElement>('.ezco-mde-selection-menu')
    /** The label of the item holding the focus, if one does. */
    const focused = () => (document.activeElement as HTMLElement | null)?.closest('.ezco-mde-context-menu-item')?.querySelector('.ezco-mde-context-menu-item-label')?.textContent ?? null

    /** `from`–`to` selected in a focused note, the button shown. */
    async function select(editor: MarkdownEditor, container: HTMLElement, from: number, to: number) {
        await new Promise((r) => requestAnimationFrame(r))
        editor.view.focus()
        editor.commands.setTextSelection({ from, to })
        await waitFor(() => btnOpacity(container) === '1', 2000)
    }

    /** The button pressed: the menu open with its first item focused. */
    async function openMenu(container: HTMLElement): Promise<HTMLElement> {
        await userEvent.click(button(container))
        await waitFor(() => !!menu(), 2000)
        await waitFor(() => focused() !== null, 2000)
        return menu()!
    }

    /** `label` pressed in the open menu; the menu gone. */
    async function choose(label: string) {
        const item = menuItem(label, menu()!)
        if (!item) throw new Error(`No "${label}" in the menu: ${menuLabels(menu()!).join(', ')}`)
        await userEvent.click(item)
        await waitFor(() => !menu(), 2000)
    }

    // "Hello world paragraph.": the paragraph opens at 0, so "world" is 7–12.
    const PARA = 'Hello world paragraph.'
    const WORLD = { from: 7, to: 12 }

    it('shows for select-all (AllSelection — Cmd/Ctrl-A)', async () => {
        const { editor, container } = await make('# Title\n\nHello world paragraph.')
        editor.view.focus()
        // Exactly what the Mod-a baseKeymap binding produces.
        editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
        await tick(60)
        expect(btnOpacity(container)).toBe('1')
    })

    it('shows for an ordinary range selection', async () => {
        const { editor, container } = await make('# Title\n\nHello world paragraph.')
        editor.view.focus()
        editor.commands.setTextSelection({ from: 2, to: 6 })
        await tick(60)
        expect(btnOpacity(container)).toBe('1')
    })

    it('is hidden for a collapsed caret', async () => {
        const { editor, container } = await make('# Title\n\nHello world paragraph.')
        editor.view.focus()
        editor.commands.setTextSelection(3)
        await tick(60)
        expect(btnOpacity(container)).toBe('0')
    })

    it('opens on a press with the inline, block and clearing actions in order, the first focused, and marks the active ones', async () => {
        const { editor, container } = await make(`Hello **world** paragraph.`)
        await select(editor, container, WORLD.from, WORLD.to)
        const open = await openMenu(container)
        expect(menuLabels(open)).toEqual(['Bold ✓', 'Italic', 'Strikethrough', 'Inline code', 'Link', 'Heading 1', 'Heading 2', 'Quote', 'Clear formatting'])
        expect(focused()).toBe('Bold ✓')
        // The menu stands to the right of the button, in the reading flow.
        expect(open.getBoundingClientRect().left).toBeGreaterThanOrEqual(button(container).getBoundingClientRect().right)
        // Bold ✓ chosen takes the bold off.
        await choose('Bold ✓')
        expect(getMarkdownContent(editor)).toBe(PARA)
    })

    it('Bold, Italic, Strikethrough and Inline code mark the selection', async () => {
        for (const [label, expected] of [
            ['Bold', 'Hello **world** paragraph.'],
            ['Italic', 'Hello *world* paragraph.'],
            ['Strikethrough', 'Hello ~~world~~ paragraph.'],
            ['Inline code', 'Hello `world` paragraph.'],
        ] as const) {
            const { editor, container } = await make(PARA)
            await select(editor, container, WORLD.from, WORLD.to)
            await openMenu(container)
            await choose(label)
            expect(getMarkdownContent(editor)).toBe(expected)
            // The action's chain focuses the note again, the selection kept.
            expect(editor.isFocused).toBe(true)
            expect([editor.state.selection.from, editor.state.selection.to]).toEqual([WORLD.from, WORLD.to])
        }
    })

    it('Link opens the link popover with its input focused; a URL typed and Enter make the link', async () => {
        const { editor, container } = await make(PARA)
        await select(editor, container, WORLD.from, WORLD.to)
        await openMenu(container)
        await choose('Link')
        await waitFor(() => !!document.querySelector('.ezco-mde-link-popover'), 2000)
        const popover = document.querySelector('.ezco-mde-link-popover') as HTMLElement
        const input = popover.querySelector('.ezco-mde-link-popover-input') as HTMLInputElement
        await waitFor(() => document.activeElement === input, 2000)
        expect(input.value).toBe('')
        expect([...popover.querySelectorAll('.ezco-mde-link-popover-btn')].map((b) => b.textContent)).toEqual(['Save', 'Remove'])
        await userEvent.keyboard('https://example.com{Enter}')
        await waitFor(() => getMarkdownContent(editor).includes('example.com'), 2000)
        expect(getMarkdownContent(editor)).toBe('Hello [world](https://example.com) paragraph.')
        expect(editor.isFocused).toBe(true)
        // And the Save button does the same as Enter.
        const again = await make(PARA)
        await select(again.editor, again.container, WORLD.from, WORLD.to)
        await openMenu(again.container)
        await choose('Link')
        await waitFor(() => document.activeElement?.classList.contains('ezco-mde-link-popover-input') === true, 2000)
        await userEvent.keyboard('https://example.org')
        const save = [...document.querySelectorAll<HTMLElement>('.ezco-mde-link-popover-btn')].find((b) => b.textContent === 'Save')!
        await userEvent.click(save)
        await waitFor(() => getMarkdownContent(again.editor).includes('example.org'), 2000)
        expect(getMarkdownContent(again.editor)).toBe('Hello [world](https://example.org) paragraph.')
    })

    it('Heading 1, Heading 2 and Quote make the block', async () => {
        for (const [label, expected] of [
            ['Heading 1', '# Hello world paragraph.'],
            ['Heading 2', '## Hello world paragraph.'],
            ['Quote', '> Hello world paragraph.'],
        ] as const) {
            const { editor, container } = await make(PARA)
            await select(editor, container, WORLD.from, WORLD.to)
            await openMenu(container)
            await choose(label)
            expect(getMarkdownContent(editor)).toBe(expected)
            expect(editor.isFocused).toBe(true)
        }
        // Quote on a quote (Quote ✓) takes the quote off.
        const { editor, container } = await make('> Hello world paragraph.')
        await select(editor, container, WORLD.from + 1, WORLD.to + 1)
        const open = await openMenu(container)
        expect(menuLabels(open)).toContain('Quote ✓')
        await choose('Quote ✓')
        expect(getMarkdownContent(editor)).toBe(PARA)
    })

    it('Indent nests a list selection and Outdent lifts it; neither is offered outside a list', async () => {
        const { editor, container } = await make('* one\n* two')
        const twoAt = editor.state.doc.textContent.indexOf('two')
        // The second item's text: found by position, the list's wrappers aside.
        let from = -1
        editor.state.doc.descendants((node, pos) => {
            if (from < 0 && node.isText && node.text === 'two') from = pos
        })
        expect(twoAt).toBeGreaterThan(0)
        await select(editor, container, from, from + 3)
        // The second item can go under the first, or out of the list.
        let open = await openMenu(container)
        expect(menuLabels(open)).toContain('Indent')
        expect(menuLabels(open)).toContain('Outdent')
        await choose('Indent')
        expect(getMarkdownContent(editor)).toBe('* one\n  * two')
        const list = (): JSONContent => editor.getJSON().content![0]
        const nested = list().content![0].content!
        expect(nested.map((n) => n.type)).toEqual(['paragraph', 'bulletList'])
        // Nested now: Outdent offered, Indent not (nothing to go under).
        await waitFor(() => btnOpacity(container) === '1', 2000)
        open = await openMenu(container)
        expect(menuLabels(open)).toContain('Outdent')
        expect(menuLabels(open)).not.toContain('Indent')
        await choose('Outdent')
        expect(getMarkdownContent(editor)).toBe('* one\n* two')
        expect(list().content!.map((n) => n.content!.map((c) => c.type))).toEqual([['paragraph'], ['paragraph']])
        // Outdent at the top level takes the item out of the list.
        await waitFor(() => btnOpacity(container) === '1', 2000)
        await openMenu(container)
        await choose('Outdent')
        expect(getMarkdownContent(editor)).toBe('* one\n\ntwo')

        const plain = await make(PARA)
        await select(plain.editor, plain.container, WORLD.from, WORLD.to)
        open = await openMenu(plain.container)
        expect(menuLabels(open)).not.toContain('Indent')
        expect(menuLabels(open)).not.toContain('Outdent')
    })

    it('Clear formatting takes every mark off the selection', async () => {
        const { editor, container } = await make('Hello ***world*** paragraph.')
        expect(getMarkdownContent(editor)).toBe('Hello ***world*** paragraph.')
        await select(editor, container, WORLD.from, WORLD.to)
        await openMenu(container)
        await choose('Clear formatting')
        expect(getMarkdownContent(editor)).toBe(PARA)
    })

    it('gives way to the comment composer: Comment chosen, the button goes and the composer stands by the selection', async () => {
        const { editor, container } = await make('# Title\n\nHello world paragraph.', { comments: { author: 'theo' } })
        // The heading takes 0–7: "Hello world" is 8–19.
        await select(editor, container, 8, 19)
        const btn = button(container)
        const open = await openMenu(container)
        // Comment is offered only when the host says who is writing.
        expect(menuLabels(open)).toContain('Comment')
        await choose('Comment')
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-over .ezco-mde-comment-card'), 2000)
        await waitFor(() => btn.style.opacity === '0', 2000)
        expect(btn.style.pointerEvents).toBe('none')
        const composer = container.querySelector('.ezco-mde-comment-over .ezco-mde-comment-card') as HTMLElement
        await waitFor(() => composer.style.top !== '')
        // The composer by the end of the selection, where the button was,
        // which it does not cover since the button is gone.
        const end = editor.view.coordsAtPos(19, -1)
        expect(composer.getBoundingClientRect().top).toBeGreaterThanOrEqual(end.bottom)
        expect(composer.getBoundingClientRect().top - end.bottom).toBeLessThan(16)
        // The selection is the draft's range, drawn as such.
        expect([editor.state.selection.from, editor.state.selection.to]).toEqual([8, 19])
        expect(editor.view.dom.querySelector('.ezco-mde-comment.is-draft')?.textContent).toBe('Hello world')
        // The composer gone, the button is back for the same selection.
        editor.commands.cancelComment()
        editor.commands.focus()
        editor.commands.setTextSelection({ from: 8, to: 19 })
        await waitFor(() => btn.style.opacity === '1')
        // And without an author, no Comment.
        const { editor: anon, container: anonContainer } = await make(PARA)
        await select(anon, anonContainer, WORLD.from, WORLD.to)
        expect(menuLabels(await openMenu(anonContainer))).not.toContain('Comment')
    })

    it('the arrows move the focused item, Enter runs it', async () => {
        const { editor, container } = await make(PARA)
        await select(editor, container, WORLD.from, WORLD.to)
        await openMenu(container)
        expect(focused()).toBe('Bold')
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Italic')
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Strikethrough')
        await userEvent.keyboard('{ArrowUp}')
        expect(focused()).toBe('Italic')
        // Up from the first wraps to the last.
        await userEvent.keyboard('{ArrowUp}{ArrowUp}')
        expect(focused()).toBe('Clear formatting')
        await userEvent.keyboard('{ArrowDown}{ArrowDown}')
        expect(focused()).toBe('Italic')
        // The keys went to the menu, not the note: nothing typed, nothing moved.
        expect(editor.state.doc.textContent).toBe(PARA)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => !menu(), 2000)
        expect(getMarkdownContent(editor)).toBe('Hello *world* paragraph.')
        expect(editor.isFocused).toBe(true)
    })

    it('Escape closes the menu and returns the focus to the note with the selection kept', async () => {
        const { editor, container } = await make(PARA)
        await select(editor, container, WORLD.from, WORLD.to)
        await openMenu(container)
        expect(editor.isFocused).toBe(false)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !menu(), 2000)
        expect(editor.isFocused).toBe(true)
        expect([editor.state.selection.from, editor.state.selection.to]).toEqual([WORLD.from, WORLD.to])
        expect(getMarkdownContent(editor)).toBe(PARA)
        // The button is still there for the selection.
        expect(btnOpacity(container)).toBe('1')
        // Typing goes over the selection, as it would have.
        await userEvent.keyboard('there')
        expect(getMarkdownContent(editor)).toBe('Hello there paragraph.')
    })

    it('Tab from the note focuses the button for a non-list selection, and Enter on it opens the menu', async () => {
        const { editor, container } = await make(PARA)
        await select(editor, container, WORLD.from, WORLD.to)
        await userEvent.keyboard('{Tab}')
        expect(document.activeElement).toBe(button(container))
        // The button holding the focus, the selection and the button stay.
        expect([editor.state.selection.from, editor.state.selection.to]).toEqual([WORLD.from, WORLD.to])
        expect(btnOpacity(container)).toBe('1')
        expect(editor.state.doc.textContent).toBe(PARA)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => !!menu(), 2000)
        await waitFor(() => focused() === 'Bold', 2000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !menu(), 2000)
        expect(editor.isFocused).toBe(true)

        // In a list, Tab is the list's: it indents the item and the button
        // keeps out of the way.
        const list = await make('* one\n* two')
        let from = -1
        list.editor.state.doc.descendants((node, pos) => {
            if (from < 0 && node.isText && node.text === 'two') from = pos
        })
        await select(list.editor, list.container, from, from + 3)
        await userEvent.keyboard('{Tab}')
        expect(document.activeElement).not.toBe(button(list.container))
        expect(list.editor.isFocused).toBe(true)
        expect(getMarkdownContent(list.editor)).toBe('* one\n  * two')
    })

    it('anchors at the end of the text on select-all (not the editor corner)', async () => {
        // The doc ends with a horizontal rule, so the document's very end (what
        // the button used to track on select-all) sits below/after the last
        // text — dropping the menu away from the content.
        const { editor, container } = await make('# Title\n\nThe last line of text.\n\n---')
        editor.view.focus()
        editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
        await tick(60)

        const btn = container.querySelector('.ezco-mde-selection-menu-btn') as HTMLElement
        expect(btn?.style.opacity).toBe('1')

        let lastTextEnd = -1
        editor.state.doc.descendants((node, pos) => {
            if (node.isText) lastTextEnd = pos + node.nodeSize
            return true
        })
        // The trailing rule really is past the last text.
        expect(lastTextEnd).toBeGreaterThan(0)
        expect(lastTextEnd).toBeLessThan(editor.state.doc.content.size)

        // The button is anchored just below the end of the last *text* line,
        // not down at the rule / editor bottom-right.
        const wrapper = (editor.view.dom.parentElement as HTMLElement).getBoundingClientRect()
        const textCoords = editor.view.coordsAtPos(lastTextEnd, -1)
        const expectedTop = textCoords.bottom - wrapper.top + 3
        expect(Math.abs(parseFloat(btn.style.top) - expectedTop)).toBeLessThan(8)
    })
})
