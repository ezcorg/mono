import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import type { JSONContent } from '@tiptap/core'
import { createEditor, MarkdownEditor } from '../index'
import { md, startOf, trackEditors } from '../../../test/utils'

/**
 * Tasks as a person makes them: `- [ ] ` typed on a line, `[ ] ` at the
 * start of an item, a checkbox clicked, and a list of tasks and plain items
 * typed together, which the editor keeps as lists of each kind, in order.
 */

const { typing } = trackEditors()
/** The kinds of the top-level blocks, lists with their kind in brackets
 *  (the empty paragraph the editor keeps after a list left out). */
const shape = (editor: MarkdownEditor) => {
    const blocks = (editor.getJSON().content ?? []).map((b: JSONContent) => {
        if (b.type === 'orderedList') return `ol[${b.attrs?.type ?? '1'}${b.attrs?.delimiter ?? '.'}]`
        if (b.type === 'bulletList') return `ul[${b.attrs?.marker}]`
        return b.type
    })
    const last = editor.state.doc.lastChild
    if (blocks.length > 1 && last?.type.name === 'paragraph' && !last.content.size) blocks.pop()
    return blocks
}
const items = (editor: MarkdownEditor) => [...editor.view.dom.querySelectorAll('li')].map((li) => li.textContent)
const checked = (editor: MarkdownEditor) => [...editor.view.dom.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].map((box) => box.checked)
/** What `written` reads back as: its shape, and what that writes again. */
const reread = (written: string) => {
    const again = createEditor({ content: written }) as MarkdownEditor
    const result = { shape: shape(again), written: md(again) }
    again.destroy()
    return result
}

describe('Typing a task', () => {
    it('makes a task of `- [ ] ` typed on a line, unchecked', async () => {
        const { editor } = await typing()
        await userEvent.keyboard('- [[ ] Hello world')
        expect(shape(editor)).toEqual(['taskList'])
        const first: JSONContent = editor.getJSON().content![0].content![0]
        expect(first.type).toBe('taskItem')
        expect(first.attrs?.checked).toBe(false)
        expect(md(editor)).toMatch(/^[-*] \[ \] Hello world$/)
        expect(checked(editor)).toEqual([false])
        expect(items(editor)).toEqual(['Hello world'])
    })

    // Bug: `- [x] ` typed on a line (outside a list) makes an unchecked task:
    // `listRule` wraps the paragraph with the item type's default attrs and
    // applies the target's `itemAttrs` (`checked: true`) only when retyping an
    // item that is in a list already (where `- [x] ` does check it: see
    // "Tasks and plain items together").
    it('makes a done task of `- [x] ` typed on a line', async () => {
        const { editor } = await typing()
        await userEvent.keyboard('- [[x] Done already')
        expect(shape(editor)).toEqual(['taskList'])
        const item: JSONContent = editor.getJSON().content![0].content![0]
        expect(item.attrs?.checked).toBe(true)
        expect(md(editor)).toMatch(/^[-*] \[x\] Done already$/)
        expect(checked(editor)).toEqual([true])
    })

    it('makes a task of the item `[ ] ` is typed at the start of, in a task list of its own', async () => {
        const { editor } = await typing('- one\n- two\n- three')
        editor.commands.setTextSelection(startOf(editor, 'two'))
        await userEvent.keyboard('[[ ] ')
        expect(shape(editor)).toEqual(['ul[dash]', 'taskList', 'ul[dash]'])
        expect(items(editor)).toEqual(['one', 'two', 'three'])
        expect(checked(editor)).toEqual([false])
        // The caret stays at the start of the item's text.
        expect(editor.state.selection.$from.parent.textContent).toBe('two')
        expect(editor.state.selection.$from.parentOffset).toBe(0)
        // Written apart, read apart again, and written the same.
        const written = md(editor)
        expect(written).toMatch(/^- one\n\n[-*] \[ \] two\n\n- three$/)
        expect(reread(written)).toEqual({ shape: ['ul[dash]', 'taskList', 'ul[dash]'], written })
    })

    // Bug: a task list is written with `*` and a blank line between its items
    // whatever was read (`- [ ] a\n- [ ] b` comes back `* [ ] a\n\n* [ ] b`):
    // tiptap's TaskList keeps no marker or tightness, where BulletList keeps both.
    it('writes a task list back as it was written: its marker and its tightness', async () => {
        const { editor } = await typing('- [ ] Hello\n- [ ] World')
        expect(shape(editor)).toEqual(['taskList'])
        expect(md(editor)).toBe('- [ ] Hello\n- [ ] World')
    })
})

describe('A checkbox', () => {
    it('clicked, checks the task and writes `[x]`; clicked again, unchecks it', async () => {
        const { editor } = await typing('- [ ] Hello\n- [ ] World')
        const box = () => editor.view.dom.querySelector('input[type=checkbox]') as HTMLInputElement
        const before = md(editor)
        await userEvent.click(box())
        expect(md(editor)).toMatch(/^[-*] \[x\] Hello\n\n?[-*] \[ \] World$/)
        expect(checked(editor)).toEqual([true, false])
        expect(editor.view.dom.querySelector('li[data-type="taskItem"]')?.getAttribute('data-checked')).toBe('true')
        // The tick is the only change written.
        expect(md(editor).replace('[x]', '[ ]')).toBe(before)
        await userEvent.click(box())
        expect(md(editor)).toBe(before)
        expect(checked(editor)).toEqual([false, false])
        expect(editor.view.dom.querySelector('li[data-type="taskItem"]')?.getAttribute('data-checked')).toBe('false')
    })
})

describe('Tasks and plain items together', () => {
    it('typed in turn, are kept as a list of each kind, in order, and read back the same', async () => {
        const { editor } = await typing()
        await userEvent.keyboard('- [[ ] a{Enter}- b')
        expect(shape(editor)).toEqual(['taskList', 'ul[dash]'])
        expect(items(editor)).toEqual(['a', 'b'])
        await userEvent.keyboard('{Enter}- [[x] c')
        expect(shape(editor)).toEqual(['taskList', 'ul[dash]', 'taskList'])
        expect(items(editor)).toEqual(['a', 'b', 'c'])
        expect(checked(editor)).toEqual([false, true])
        // Three lists, a blank line between each; the plain item keeps its dash.
        const written = md(editor)
        expect(written).toMatch(/^[-*] \[ \] a\n\n- b\n\n[-*] \[x\] c$/)
        expect(reread(written)).toEqual({ shape: ['taskList', 'ul[dash]', 'taskList'], written })
    })
})
