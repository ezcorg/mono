import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { MarkdownEditor } from '../index'
import {
    createTestContainer,
    createTestEditor,
    cleanupEditor,
    waitFor,
} from '../../../test/utils'

/**
 * Inline link popover + follow behaviour (browser provider — needs real
 * layout/rects for Tippy). Covers items: click places the caret (Link's
 * openOnClick is false), the popover shows when the caret is in a link, the
 * inline editor saves/removes, and — importantly — the popover survives a
 * selection change (a regression guard: slash-commands' cleanup used to wipe
 * every `[data-tippy-root]`, which nuked this popover the instant the caret
 * moved).
 */
describe('Inline link popover', () => {
    let container: HTMLElement
    let editor: MarkdownEditor

    const linkPos = (e: MarkdownEditor): number => {
        let pos = -1
        e.state.doc.descendants((node, p) => {
            if (pos < 0 && node.isText && node.marks.some((m) => m.type.name === 'link')) pos = p
        })
        return pos
    }

    const popoverEl = () => document.querySelector('.ezco-mde-link-popover')

    beforeEach(async () => {
        container = createTestContainer()
        editor = await createTestEditor(container, {
            content: 'Visit the [example site](https://example.com/path) now.',
        })
    })

    afterEach(() => {
        cleanupEditor(editor, container)
        document.querySelectorAll('.ezco-mde-link-popover, [data-tippy-root]').forEach((n) => n.remove())
    })

    it('configures the link mark to not navigate on plain click', () => {
        const link = editor.extensionManager.extensions.find((e) => e.name === 'link')
        expect(link?.options.openOnClick).toBe(false)
    })

    it('ends a link where its text ends: what is typed after a pasted URL is text, and the selection menu takes the link off a selection', async () => {
        editor.commands.setContent('- A\n- B\n')
        await new Promise((r) => requestAnimationFrame(r))
        // (The first item's text, "A", is at 3; after it is 4.)
        editor.commands.focus(4)
        await userEvent.keyboard('{Enter}')
        const data = new DataTransfer()
        data.setData('text/plain', 'https://github.com/jsonnext/codemirror-json-schema')
        editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        await waitFor(() => linkPos(editor) > 0)
        expect(editor.storage.markdown.getMarkdown()).toBe('- A\n- <https://github.com/jsonnext/codemirror-json-schema>\n- B')
        await userEvent.keyboard(' and more')
        expect(editor.storage.markdown.getMarkdown()).toBe('- A\n- <https://github.com/jsonnext/codemirror-json-schema> and more\n- B')
        // The link is not inclusive: typing at its end goes on outside it.
        const link = editor.extensionManager.extensions.find((e) => e.name === 'link')!
        expect(editor.schema.marks.link.spec.inclusive).toBe(false)
        expect(link.options.autolink).toBe(true)
        // Part of the link selected, "Link ✓" in the selection menu takes
        // the link off that part alone.
        const pos = linkPos(editor)
        editor.commands.setTextSelection({ from: pos + 'https://github.com/jsonnext/'.length, to: pos + 'https://github.com/jsonnext/codemirror-json-schema'.length })
        await waitFor(() => (container.querySelector('.ezco-mde-selection-menu-btn') as HTMLElement).style.opacity === '1')
        ;(container.querySelector('.ezco-mde-selection-menu-btn') as HTMLElement).click()
        await waitFor(() => !!document.querySelector('.ezco-mde-selection-menu'))
        const item = [...document.querySelectorAll<HTMLElement>('.ezco-mde-selection-menu .ezco-mde-context-menu-item')].find((i) => i.textContent?.trim().endsWith('Link ✓'))
        expect(item).toBeDefined()
        item!.click()
        await waitFor(() => !document.querySelector('.ezco-mde-selection-menu'))
        expect(editor.storage.markdown.getMarkdown()).toBe('- A\n- [https://github.com/jsonnext/](https://github.com/jsonnext/codemirror-json-schema)codemirror-json-schema and more\n- B')
    })

    it('shows an editable URL input with Save + Remove when the caret enters a link', async () => {
        const pos = linkPos(editor)
        expect(pos).toBeGreaterThanOrEqual(0)
        editor.commands.setTextSelection(pos + 1)

        await waitFor(() => !!popoverEl())
        const input = popoverEl()!.querySelector('.ezco-mde-link-popover-input') as HTMLInputElement | null
        expect(input?.value).toBe('https://example.com/path')
        const labels = Array.from(popoverEl()!.querySelectorAll('.ezco-mde-link-popover-btn')).map((b) => b.textContent)
        expect(labels).toEqual(['Save', 'Remove'])
    })

    it('survives a selection change (slash-commands no longer wipes foreign tippy roots)', async () => {
        const pos = linkPos(editor)
        editor.commands.setTextSelection(pos + 1)
        await waitFor(() => !!popoverEl())

        // Move the caret within the link, then back — each dispatch runs
        // slash-commands' selectionUpdate → hideSuggestions.
        editor.commands.setTextSelection(pos + 3)
        editor.commands.setTextSelection(pos + 1)
        // Give the update cycle a couple of frames.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))

        expect(popoverEl()).not.toBeNull()
    })

    it('hides the popover when the caret leaves the link', async () => {
        const pos = linkPos(editor)
        editor.commands.setTextSelection(pos + 1)
        await waitFor(() => !!popoverEl())

        editor.commands.setTextSelection(1) // start of the doc, outside the link
        await waitFor(() => {
            const el = popoverEl() as HTMLElement | null
            // hidden = removed from DOM, or display:none via tippy unmount
            return !el || el.offsetParent === null || getComputedStyle(el).display === 'none' || !el.isConnected
        })
        const el = popoverEl() as HTMLElement | null
        expect(!el || !el.isConnected || getComputedStyle(el).display === 'none').toBe(true)
    })

    it('does not show when the caret is right before the link', async () => {
        const pos = linkPos(editor)
        editor.commands.setTextSelection(pos) // left boundary — caret not inside the mark
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
        const el = popoverEl() as HTMLElement | null
        expect(!el || !el.isConnected || getComputedStyle(el).display === 'none').toBe(true)
    })

    it('saves an edited URL from the input and removes via the button', async () => {
        const pos = linkPos(editor)
        editor.commands.setTextSelection(pos + 1)
        await waitFor(() => !!document.querySelector('.ezco-mde-link-popover-input'))

        const input = document.querySelector('.ezco-mde-link-popover-input') as HTMLInputElement
        input.value = 'https://changed.example/x'
        ;(input.closest('form') as HTMLFormElement).dispatchEvent(
            new Event('submit', { cancelable: true, bubbles: true }),
        )

        await waitFor(() => editor.getAttributes('link').href === 'https://changed.example/x')
        expect(editor.getAttributes('link').href).toBe('https://changed.example/x')

        // Remove via the popover.
        editor.commands.setTextSelection(linkPos(editor) + 1)
        await waitFor(() => !!popoverEl())
        const removeBtn = Array.from(
            popoverEl()!.querySelectorAll('.ezco-mde-link-popover-btn'),
        ).find((b) => b.textContent === 'Remove') as HTMLButtonElement
        removeBtn.click()

        await waitFor(() => linkPos(editor) === -1)
        expect(linkPos(editor)).toBe(-1)
    })
})
