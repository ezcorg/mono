import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { EditorView } from '@codemirror/view'
import { foldRangeFor } from './folding'
import { codeRuns } from './code-runs'
import type { MarkdownEditor } from '../index'
import { getMarkdownContent, posOf, trackEditors, waitFor } from '../../../test/utils'

/**
 * Fences standing next to each other are one window with tabs
 * (code-tabs.ts): one shown, the others hidden; a tab shows its block, its
 * × deletes it, "+" adds one with its field open; the caret never lands in
 * a hidden block; a fence typed after a group stands apart from it.
 */
const { make } = trackEditors()

const GROUP = '# Tabs\n\nBefore.\n\n```ts\nconst a = 1\n```\n\n```css\n.card { display: flex; }\n```\n\n```json\n{ "a": 1 }\n```\n\nAfter.'

const blocks = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.ezco-mde-body > .cm-editor')]
const shown = (c: HTMLElement) => blocks(c).filter((b) => b.getAttribute('data-tab-hidden') !== 'true')
const tabs = (b: HTMLElement) => [...b.querySelectorAll<HTMLElement>('.cm-toolbar-tab')].map((t) => (t.classList.contains('cm-toolbar-tab-add') ? '+' : t.querySelector('.cm-toolbar-tab-label')!.textContent))
const field = (b: HTMLElement) => b.querySelector<HTMLInputElement>('.cm-toolbar-input')!
const kinds = (editor: MarkdownEditor) => editor.state.doc.content.content.map((n) => n.type.name)

async function open(content = GROUP) {
    const made = make({ content, size: { width: 900, height: 600, scroll: true } })
    await waitFor(() => blocks(made.container).length === 3 && blocks(made.container).every((b) => !!b.querySelector('.cm-toolbar-input')), 5000)
    await waitFor(() => shown(made.container).length === 1, 2000)
    return made
}

describe('Code tabs', () => {
    it('draws adjacent fences as one window: the first shown with every tab, the rest hidden; a tab shows its block', async () => {
        const { editor, container } = await open()
        expect(shown(container)).toEqual([blocks(container)[0]])
        expect(tabs(shown(container)[0])).toEqual(['css', 'json', '+'])
        expect(field(shown(container)[0]).value).toBe('ts')
        expect(shown(container)[0].querySelector('.cm-toolbar-input-container .cm-toolbar-tab-close')?.hasAttribute('hidden')).toBe(false)
        // The note is written as it was: fences, one after another.
        expect(getMarkdownContent(editor)).toBe(GROUP)
        // The second tab pressed: its block shown, the first a tab before it.
        ;(shown(container)[0].querySelector('.cm-toolbar-tabs-after .cm-toolbar-tab') as HTMLElement).click()
        await waitFor(() => shown(container)[0] === blocks(container)[1], 2000)
        expect(field(shown(container)[0]).value).toBe('css')
        expect(tabs(shown(container)[0])).toEqual(['ts', 'json', '+'])
        expect(shown(container)[0].querySelectorAll('.cm-toolbar-tabs-before .cm-toolbar-tab')).toHaveLength(1)
        expect(getMarkdownContent(editor)).toBe(GROUP)
    })

    it('keeps the caret out of hidden blocks: down out of the shown block leaves the group, up into the group enters the shown block', async () => {
        const { editor, container } = await open()
        await userEvent.click(shown(container)[0].querySelector('.cm-content') as HTMLElement)
        const view = EditorView.findFromDOM(shown(container)[0])!
        await waitFor(() => view.hasFocus, 2000)
        await userEvent.keyboard('{End}{ArrowDown}')
        await waitFor(() => editor.state.selection.$from.parent.textContent === 'After.', 2000)
        expect(document.activeElement).toBe(editor.view.dom)
        // Up from the paragraph after: into the shown block (the first), not the hidden last one.
        await userEvent.keyboard('{ArrowUp}')
        await waitFor(() => EditorView.findFromDOM(blocks(container)[0])!.hasFocus, 2000)
        expect(shown(container)).toEqual([blocks(container)[0]])
        // A tab chosen while the caret is in the group: the caret goes to the block shown.
        ;(shown(container)[0].querySelector('.cm-toolbar-tabs-after .cm-toolbar-tab') as HTMLElement).click()
        await waitFor(() => shown(container)[0] === blocks(container)[1], 2000)
        const $from = editor.state.selection.$from
        expect($from.depth >= 1 ? $from.node(1).attrs.language : null).toBe('css')
    })

    it('adds a block to the group from "+", shown, its field open; × deletes a block, the tab beside it shown', async () => {
        const { editor, container } = await open()
        ;(shown(container)[0].querySelector('.cm-toolbar-tab-add') as HTMLElement).click()
        await waitFor(() => blocks(container).length === 4, 3000)
        await waitFor(() => blocks(container).map((b) => b.getAttribute('data-tab-hidden')).join() === 'true,true,true,false', 3000)
        expect(kinds(editor).slice(0, 7)).toEqual(['heading', 'paragraph', 'ezcodeBlock', 'ezcodeBlock', 'ezcodeBlock', 'ezcodeBlock', 'paragraph'])
        expect(tabs(shown(container)[0])).toEqual(['ts', 'css', 'json', '+'])
        // The new block's field is focused with its dropdown open, as a typed fence's is.
        await waitFor(() => document.activeElement === field(shown(container)[0]), 3000)
        await waitFor(() => shown(container)[0].querySelectorAll('.cm-search-result').length > 0, 3000)
        // × on the shown (new, last) block: gone, the one before it shown.
        ;(shown(container)[0].querySelector('.cm-toolbar-input-container .cm-toolbar-tab-close') as HTMLElement).click()
        await waitFor(() => blocks(container).length === 3, 3000)
        await waitFor(() => shown(container)[0] === blocks(container)[2], 2000)
        expect(field(shown(container)[0]).value).toBe('json')
        expect(tabs(shown(container)[0])).toEqual(['ts', 'css', '+'])
        // × on another tab: that block gone, the shown one kept.
        ;(shown(container)[0].querySelector('.cm-toolbar-tabs-before .cm-toolbar-tab .cm-toolbar-tab-close') as HTMLElement).click()
        await waitFor(() => blocks(container).length === 2, 3000)
        await waitFor(() => tabs(shown(container)[0]).join() === 'css,+', 2000)
        expect(field(shown(container)[0]).value).toBe('json')
        expect(getMarkdownContent(editor)).toBe('# Tabs\n\nBefore.\n\n```css\n.card { display: flex; }\n```\n\n```json\n{ "a": 1 }\n```\n\nAfter.')
        // Escape in a new, empty block's field gives the block up, as for a typed fence.
        ;(shown(container)[0].querySelector('.cm-toolbar-tab-add') as HTMLElement).click()
        await waitFor(() => blocks(container).length === 3, 3000)
        await waitFor(() => document.activeElement === field(shown(container)[0]), 3000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => blocks(container).length === 2, 3000)
    })

    it('keeps a fence typed right after a group apart from it, and one the slash command makes; a group folds as one', async () => {
        const { editor, container } = await open()
        // The paragraph after the group made a fence by typing: the
        // group's "+" is the way in, so an empty paragraph keeps it apart.
        editor.commands.focus(posOf(editor, 'After.'))
        await userEvent.keyboard('```')
        await waitFor(() => blocks(container).length === 4, 3000)
        // (A paragraph follows the last block: the note's trailing one.)
        expect(kinds(editor).slice(0, 7).join()).toBe('heading,paragraph,ezcodeBlock,ezcodeBlock,ezcodeBlock,paragraph,ezcodeBlock')
        expect(codeRuns(editor.state.doc).map((r) => r.blocks.length)).toEqual([3, 1])
        await waitFor(() => shown(container).length === 2, 2000)
        expect(getMarkdownContent(editor)).toContain('```\n\n \n\n```')
        // The group folds as one block: its three fences.
        const run = codeRuns(editor.state.doc)[0]
        expect(foldRangeFor(editor.state.doc, run.blocks[1].pos)).toEqual({ from: run.from, to: run.to })
    })

    it('keeps the slash command’s fence apart from a group too', async () => {
        // Asked for in the empty paragraph right after the group, the fence
        // goes after that paragraph, which stays between.
        const { editor, container } = await open(GROUP.replace(/\n\nAfter\.$/, '\n\n\u00A0'))
        expect(kinds(editor).slice(2)).toEqual(['ezcodeBlock', 'ezcodeBlock', 'ezcodeBlock', 'paragraph'])
        editor.commands.focus('end')
        await userEvent.keyboard('/code')
        await waitFor(() => !!document.querySelector('.ezco-mde-slash-menu .ezco-mde-slash-item'), 2000)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => blocks(container).length === 4, 3000)
        expect(codeRuns(editor.state.doc).map((r) => r.blocks.length)).toEqual([3, 1])
        expect(kinds(editor).slice(2, 7)).toEqual(['ezcodeBlock', 'ezcodeBlock', 'ezcodeBlock', 'paragraph', 'ezcodeBlock'])
    })
})
