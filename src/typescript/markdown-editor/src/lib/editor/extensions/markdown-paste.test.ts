import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEditor, MarkdownEditor } from '../index'

/**
 * Block-level markdown paste. tiptap-markdown's bundled clipboard
 * handler is hardcoded to `inline: true`, so block constructs like
 * lists, headings, and blockquotes pasted as plain text used to land
 * as literal characters. `MarkdownBlockPaste` intercepts `handlePaste`
 * before PM commits to either its HTML or plain-text branch, inspects
 * the raw clipboard data, and re-parses block-level patterns through
 * the markdown parser.
 */
describe('Markdown block-level paste', () => {
    let editor: MarkdownEditor

    beforeEach(() => {
        editor = createEditor({ content: '' })
    })

    afterEach(() => {
        try { editor.destroy() } catch {}
    })

    /**
     * Drive the actual `paste` event path — same route as a real
     * keyboard paste. We hand-construct a `ClipboardEvent` with both
     * `text/plain` and `text/html` payloads (mirroring how OS/browser
     * clipboards usually deliver paste data) so the test exercises
     * the HTML+text branch that broke the previous `clipboardTextParser`
     * approach.
     */
    function pasteText(text: string, htmlWrapper?: string): void {
        const html = htmlWrapper ?? `<meta charset="utf-8">${text}`
        const dt = new DataTransfer()
        dt.setData('text/plain', text)
        dt.setData('text/html', html)
        const ev = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
        })

        // Walk the registered plugins and find the first `handlePaste`
        // that returns true. This replicates PM's own dispatch order
        // without needing the contenteditable mounted in the document.
        for (const plugin of editor.state.plugins) {
            const handle = (plugin.props as any).handlePaste
            if (typeof handle === 'function' && handle.call(plugin, editor.view, ev)) {
                return
            }
        }
        // Nothing handled the paste — fall back to inserting the text
        // verbatim (matches PM's default plaintext path).
        editor.commands.insertContent(text)
    }

    it('transforms a pasted "* item" into a bullet list', () => {
        pasteText('* test')
        const md = editor.storage.markdown.getMarkdown()
        expect(md).toMatch(/^\*\s+test/)

        const firstChild = editor.state.doc.firstChild!
        expect(firstChild.type.name).toBe('bulletList')
    })

    it('transforms a pasted "# Heading" into an h1', () => {
        pasteText('# Hello')
        expect(editor.state.doc.firstChild!.type.name).toBe('heading')
        expect(editor.state.doc.firstChild!.attrs.level).toBe(1)
    })

    it('transforms a pasted "> quote" into a blockquote', () => {
        pasteText('> wisdom')
        expect(editor.state.doc.firstChild!.type.name).toBe('blockquote')
    })

    it('defers to PM defaults when pasted text has no block markdown markers', () => {
        // "**bold**" is inline-only — our handler should return false
        // and let PM (and tiptap-markdown's inline paste rules) handle
        // it. With our `insertContent` fallback in `pasteText`, the
        // raw text lands as the editor body's content.
        pasteText('**bold**')
        // We're verifying *non-interception*: our handler shouldn't
        // have re-parsed this and produced extra blocks.
        expect(editor.state.doc.childCount).toBe(1)
    })

    it('returns false from handlePaste when the HTML payload carries rich semantic tags', () => {
        // Real rich HTML (e.g. styled selection from a web page)
        // should make our handler abstain so PM's normal HTML paste
        // path can preserve the source formatting.
        const dt = new DataTransfer()
        dt.setData('text/plain', '# Real heading\n\nBody text')
        dt.setData('text/html', '<h1>Real heading</h1><p>Body text</p>')
        const ev = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
        })

        let ourHandlerReturn: any = undefined
        for (const plugin of editor.state.plugins) {
            const handle = (plugin.props as any).handlePaste
            // Identify our own plugin by the key it registered under.
            if ((plugin as any).key?.startsWith?.('markdownBlockPaste') && typeof handle === 'function') {
                ourHandlerReturn = handle.call(plugin, editor.view, ev)
                break
            }
        }
        expect(ourHandlerReturn).toBe(false)
    })
})
