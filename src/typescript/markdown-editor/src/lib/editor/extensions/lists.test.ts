import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import type { JSONContent } from '@tiptap/core'
import { createEditor, MarkdownEditor } from '../index'
import { actionsForNode } from './block-actions'
import { createTestContainer, cleanupEditor } from '../../../test/utils'

/**
 * Lists of every kind, and the ways between them: what is read and written
 * back as itself (markers, numbers, letters, delimiters), what a typed
 * marker makes of the item it is typed in, and how lists sit together.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

function open(content = '') {
    const container = createTestContainer(`lists-${created.length}`)
    const editor = createEditor({ element: container, content })
    created.push({ editor, container })
    return { editor, container }
}

const md = (editor: MarkdownEditor) => editor.storage.markdown.getMarkdown() as string
const frames = async (n = 2) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r))
}
/** The kinds of the top-level blocks, lists with their kind in brackets
 *  (the empty paragraph the editor keeps after a list left out). */
const shape = (editor: MarkdownEditor) => {
    const blocks = (editor.getJSON().content ?? []).map((b: JSONContent) => {
        if (b.type === 'orderedList') return `ol[${b.attrs?.type ?? '1'}${b.attrs?.delimiter ?? '.'}${b.attrs?.start && b.attrs.start !== 1 ? `@${b.attrs.start}` : ''}]`
        if (b.type === 'bulletList') return `ul[${b.attrs?.marker}]`
        return b.type
    })
    const last = editor.state.doc.lastChild
    if (blocks.length > 1 && last?.type.name === 'paragraph' && !last.content.size) blocks.pop()
    return blocks
}
/** An editor to type in: made, mounted (Tiptap mounts after a tick), focused. */
async function typing(content = '') {
    const made = open(content)
    await frames()
    made.editor.commands.focus()
    await frames()
    return made
}

describe('Lists as written', () => {
    it('reads and writes letters, numbers and either delimiter as they were', () => {
        for (const text of ['a. alpha\nb. beta', 'c) gamma\nd) delta', '1) one\n2) two', '3. three\n4. four', 'A.  Upper\nB.  Case', 'A) Upper\nB) Case']) {
            const { editor } = open(text)
            expect(md(editor), text).toBe(text)
        }
        const { editor } = open('c) gamma')
        expect(shape(editor)).toEqual(['ol[a)@3]'])
        expect(editor.view.dom.querySelector('ol')?.getAttribute('type')).toBe('a')
        expect(getComputedStyle(editor.view.dom.querySelector('ol > li')!, '::before').content).toContain('")"')
    })

    it('keeps a numbered list after a lettered one, and letters after numbers, as two lists', () => {
        const { editor } = open('c) gamma\nd) delta\n\n3) three\n4) four')
        expect(shape(editor)).toEqual(['ol[a)@3]', 'ol[1)@3]'])
        expect(md(editor)).toBe('c) gamma\nd) delta\n\n\n3) three\n4) four')
        const other = open('1. one\n2. two\n\na. alpha\nb. beta')
        expect(shape(other.editor)).toEqual(['ol[1.]', 'ol[a.]'])
        expect(md(other.editor)).toBe('1. one\n2. two\n\n\na. alpha\nb. beta')
    })

    it('takes a capital letter and a period for an initial, not a list, unless two spaces follow', () => {
        const { editor } = open('B. Russell wrote it.')
        expect(shape(editor)).toEqual(['paragraph'])
        expect(md(editor)).toBe('B. Russell wrote it.')
    })

    it('reads a list of tasks and plain items as a task list beside a bullet list, in order', () => {
        const { editor } = open('- [ ] task\n- plain\n- [x] done')
        expect(shape(editor)).toEqual(['taskList', 'ul[dash]', 'taskList'])
        const items = [...editor.view.dom.querySelectorAll('li')].map((li) => li.textContent)
        expect(items).toEqual(['task', 'plain', 'done'])
        // Written apart, read apart again.
        const again = open(md(editor))
        expect(shape(again.editor)).toEqual(['taskList', 'ul[dash]', 'taskList'])
    })

    it('nests lists of every kind in one another', () => {
        const { editor } = open('- a\n  1. b\n  2. c\n  a. d\n  - [ ] e\n    * f')
        const item: JSONContent = editor.getJSON().content![0].content![0]
        const kids = (n: JSONContent): JSONContent[] => n.content ?? []
        expect(kids(item).map((n) => n.type)).toEqual(['paragraph', 'orderedList', 'orderedList', 'taskList'])
        expect(kids(item)[2].attrs?.type).toBe('a')
        expect(kids(kids(kids(item)[3])[0]).map((n) => n.type)).toEqual(['paragraph', 'bulletList'])
        // The task list as written too: its dash, and tight.
        expect(md(editor)).toBe('- a\n  1. b\n  2. c\n\n\n  a. d\n  - [ ] e\n    * f')
    })

    it('sets two lists of different kinds no further apart than their items', async () => {
        const { editor } = open('* one\n* two\n\n1. first\n2. second\n\n- [ ] task')
        await frames()
        const [ul, ol, tasks] = [...editor.view.dom.children] as HTMLElement[]
        const between = (a: HTMLElement, b: HTMLElement) => b.getBoundingClientRect().top - a.getBoundingClientRect().bottom
        const items = ul.querySelectorAll(':scope > li')
        const inside = between(items[0] as HTMLElement, items[1] as HTMLElement)
        expect(Math.abs(between(ul, ol) - inside)).toBeLessThan(1)
        expect(Math.abs(between(ol, tasks) - inside)).toBeLessThan(1)
    })
})

describe('Typing list markers', () => {
    it('starts a lettered list on `a) `, numbered on `1. `, and goes on from the letter typed', async () => {
        const { editor } = await typing()
        await userEvent.keyboard('c) gamma')
        expect(shape(editor)).toEqual(['ol[a)@3]'])
        expect(md(editor)).toBe('c) gamma')
        await userEvent.keyboard('{Enter}delta')
        expect(md(editor)).toBe('c) gamma\nd) delta')
    })

    it('makes the item a marker is typed in one of that kind, in a list of its own', async () => {
        const { editor } = await typing()
        await userEvent.keyboard('- one{Enter}1. two{Enter}three')
        expect(shape(editor)).toEqual(['ul[dash]', 'ol[1.]'])
        expect(md(editor)).toBe('- one\n\n1. two\n2. three')
        // A task out of a numbered item, a bullet out of a task.
        await userEvent.keyboard('{Enter}[[ ] four{Enter}* five')
        expect(shape(editor)).toEqual(['ul[dash]', 'ol[1.]', 'taskList', 'ul[bullet]'])
        expect(md(editor)).toBe('- one\n\n1. two\n2. three\n\n* [ ] four\n\n* five')
    })

    it('makes an item in the middle of a list one of another kind, the list split around it', async () => {
        const { editor } = await typing('* one\n* two\n* three')
        // The caret at the start of "two"; a letter marker typed there.
        let at = -1
        editor.state.doc.descendants((node, pos) => {
            if (at < 0 && node.isText && node.text === 'two') at = pos
        })
        editor.commands.setTextSelection(at)
        await userEvent.keyboard('a. ')
        expect(shape(editor)).toEqual(['ul[bullet]', 'ol[a.]', 'ul[bullet]'])
        expect(md(editor)).toBe('* one\n\na. two\n\n* three')
        expect(editor.state.selection.$from.parent.textContent).toBe('two')
        expect(editor.state.selection.$from.parentOffset).toBe(0)
    })

    it('nests a list of another kind in an item: Tab, then its marker', async () => {
        const { editor } = await typing()
        await userEvent.keyboard('- outer{Enter}{Tab}1. inner{Enter}{Tab}- [[ ] deeper')
        expect(md(editor)).toBe('- outer\n  1. inner\n     * [ ] deeper')
        const outer: JSONContent = editor.getJSON().content![0].content![0]
        expect(outer.content!.map((n: JSONContent) => n.type)).toEqual(['paragraph', 'orderedList'])
        const inner: JSONContent = outer.content![1].content![0]
        expect(inner.content!.map((n: JSONContent) => n.type)).toEqual(['paragraph', 'taskList'])
    })
})

describe('Backspace in an empty item', () => {
    /** The caret at the end of the text node `text`. */
    const endOf = (editor: MarkdownEditor, text: string) => {
        let at = -1
        editor.state.doc.descendants((n, pos) => {
            if (at < 0 && n.isText && n.text === text) at = pos + n.nodeSize
        })
        return at
    }
    /** The Markdown as lines, an empty item's trailing space left off. */
    const lines = (editor: MarkdownEditor) => md(editor).split('\n').map((l) => l.replace(/\s+$/, ''))

    it('takes the item away and leaves the items after it where they are, the caret at the end of the one before', async () => {
        const { editor } = await typing('- A\n  - A1\n  - A2\n- B\n')
        editor.commands.focus(endOf(editor, 'A1'))
        await userEvent.keyboard('{Enter}')
        expect(lines(editor)).toEqual(['- A', '  - A1', '  -', '  - A2', '- B'])
        await userEvent.keyboard('{Backspace}')
        // A2 is still A's, at its depth; the caret is after A1.
        expect(lines(editor)).toEqual(['- A', '  - A1', '  - A2', '- B'])
        expect(editor.state.selection.from).toBe(endOf(editor, 'A1'))
        // Typed into, then emptied: the same.
        await userEvent.keyboard('{Enter}X{Backspace}{Backspace}')
        expect(lines(editor)).toEqual(['- A', '  - A1', '  - A2', '- B'])
        // At the top level too.
        editor.commands.focus(endOf(editor, 'B'))
        await userEvent.keyboard('{Enter}')
        expect(lines(editor)).toEqual(['- A', '  - A1', '  - A2', '- B', '-'])
        await userEvent.keyboard('{Backspace}')
        expect(lines(editor)).toEqual(['- A', '  - A1', '  - A2', '- B'])
        expect(editor.state.selection.from).toBe(endOf(editor, 'B'))
    })

    it('gives an item its list back when Enter at its end had moved the list into a new item', async () => {
        const { editor } = await typing('- A\n  - A1\n  - A2\n- B\n')
        editor.commands.focus(endOf(editor, 'A'))
        await userEvent.keyboard('{Enter}')
        expect(lines(editor)).toEqual(['- A', '-', '  - A1', '  - A2', '- B'])
        await userEvent.keyboard('{Backspace}')
        expect(lines(editor)).toEqual(['- A', '  - A1', '  - A2', '- B'])
        expect(editor.state.selection.from).toBe(endOf(editor, 'A'))
    })

    it('takes away the first item of a nested list, or the list when it is the only one; the first item of a top-level list is lifted', async () => {
        const { editor } = await typing('- A\n- B\n')
        editor.commands.focus(endOf(editor, 'A'))
        // Tab after Enter: an empty first item in a new nested list, the
        // only one; Backspace takes the list away, the caret after A.
        await userEvent.keyboard('{Enter}{Tab}')
        expect(lines(editor)).toEqual(['- A', '  -', '- B'])
        await userEvent.keyboard('{Backspace}')
        expect(lines(editor)).toEqual(['- A', '- B'])
        expect(editor.state.selection.from).toBe(endOf(editor, 'A'))
        // An empty first item before others in a nested list (Enter at the
        // start of the first): the item goes, the others stay nested.
        const nested = await typing('- A\n  - A1\n  - A2\n- B\n')
        nested.editor.commands.focus(endOf(nested.editor, 'A1') - 2)
        await userEvent.keyboard('{Enter}')
        expect(lines(nested.editor)).toEqual(['- A', '  -', '  - A1', '  - A2', '- B'])
        let emptyAt = -1
        nested.editor.state.doc.descendants((n, pos) => {
            if (emptyAt < 0 && n.type.name === 'paragraph' && !n.content.size) emptyAt = pos + 1
        })
        nested.editor.commands.focus(emptyAt)
        expect(nested.editor.state.selection.$from.parent.content.size).toBe(0)
        await userEvent.keyboard('{Backspace}')
        expect(lines(nested.editor)).toEqual(['- A', '  - A1', '  - A2', '- B'])
        expect(nested.editor.state.selection.from).toBe(endOf(nested.editor, 'A'))
        // The first item of the top-level list, emptied: lifted to a
        // paragraph, the rest of the list as it was.
        const lone = await typing('- \n- B\n- C\n')
        lone.editor.commands.focus(3)
        await userEvent.keyboard('{Backspace}')
        expect(shape(lone.editor)).toEqual(['paragraph', 'ul[dash]'])
        expect(lines(lone.editor).filter(Boolean)).toEqual(['- B', '- C'])
    })
})

describe('The block menu', () => {
    it('offers letters for numbers and numbers for letters', () => {
        const { editor } = open('1. one\n2. two')
        const list = { node: editor.state.doc.firstChild!, pos: 0 }
        const labels = actionsForNode(list.node, editor).map((a) => a.label)
        expect(labels).toContain('Lettered list')
        expect(labels).not.toContain('Numbered list')
        actionsForNode(list.node, editor).find((a) => a.label === 'Lettered list')!.run({ editor, pos: 0, node: list.node })
        expect(md(editor)).toBe('a. one\nb. two')
        const lettered = { node: editor.state.doc.firstChild!, pos: 0 }
        expect(actionsForNode(lettered.node, editor).map((a) => a.label)).toContain('Numbered list')
        actionsForNode(lettered.node, editor).find((a) => a.label === 'Numbered list')!.run({ editor, pos: 0, node: lettered.node })
        expect(md(editor)).toBe('1. one\n2. two')
    })
})
