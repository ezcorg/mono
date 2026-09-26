import { describe, it, expect, afterEach } from 'vitest'
import { AllSelection, TextSelection } from '@tiptap/pm/state'
import { createEditor, MarkdownEditor } from './index'
import { createTestContainer, cleanupEditor } from '../../test/utils'

/**
 * Copying writes Markdown: the selection, serialized as the note would be,
 * goes on the clipboard as text. Through the `copy` event itself, since the
 * serializer is given a clipboard slice there (its top-level parent a
 * Fragment, not the document) and a failure in it leaves the browser to
 * copy the DOM's text instead: code blocks' gutters and all.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

function open(content: string) {
    const container = createTestContainer(`clip-${created.length}`)
    const editor = createEditor({ element: container, content })
    created.push({ editor, container })
    return editor
}

/** What a copy of the current selection puts on the clipboard as text. */
function copied(editor: MarkdownEditor): { handled: boolean; text: string } {
    const data = new DataTransfer()
    const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(event)
    return { handled: event.defaultPrevented, text: data.getData('text/plain') }
}

const posOf = (editor: MarkdownEditor, text: string) => {
    let at = -1
    editor.state.doc.descendants((node, pos) => {
        if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text)
        return at < 0
    })
    return at
}

describe('Copy', () => {
    it('copies a selection that ends at the start of the next paragraph as Markdown', () => {
        const editor = open('First **bold** para\n\nSecond para')
        const from = posOf(editor, 'First')
        const to = posOf(editor, 'Second')
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
        const { handled, text } = copied(editor)
        expect(handled).toBe(true)
        expect(text).toBe('First **bold** para')
    })

    it('copies everything, the empty paragraph the caret rests in included', () => {
        const editor = open('# Title\n\nA line.\n\n```js\nlet x = 1\n```')
        // Enter at the end leaves an empty paragraph after the code.
        editor.commands.focus('end')
        editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, editor.schema.nodes.paragraph.create()))
        editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
        const { handled, text } = copied(editor)
        expect(handled).toBe(true)
        expect(text).toBe('# Title\n\nA line.\n\n```js\nlet x = 1\n```')
    })

    it('keeps spacing paragraphs inside a selection', () => {
        const editor = open('A\n\n&nbsp;\n\nB')
        editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
        expect(copied(editor).text).toBe('A\n\n\u00A0\n\nB')
    })
})
