import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, posOf } from '../../../test/utils'

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
    let container: HTMLElement

    beforeEach(async () => {
        container = createTestContainer('md-paste')
        editor = createEditor({ element: container, content: '' })
        // Tiptap mounts after a tick.
        await new Promise((resolve) => requestAnimationFrame(resolve))
        editor.commands.focus('end')
    })

    afterEach(() => {
        cleanupEditor(editor, container)
    })

    /**
     * Drive the actual `paste` event path — the same route as a real
     * keyboard paste, through every plugin's `handlePaste` in order and
     * PM's own branches after them. We hand-construct a `ClipboardEvent`
     * with both `text/plain` and `text/html` payloads (mirroring how
     * OS/browser clipboards usually deliver paste data) so the test
     * exercises the HTML+text branch that broke the previous
     * `clipboardTextParser` approach. Returns whether the editor took
     * the paste (something called `preventDefault`).
     */
    function pasteText(text: string, htmlWrapper?: string): boolean {
        const html = htmlWrapper ?? `<meta charset="utf-8">${text}`
        const dt = new DataTransfer()
        dt.setData('text/plain', text)
        dt.setData('text/html', html)
        const ev = new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true,
        })
        editor.view.dom.dispatchEvent(ev)
        return ev.defaultPrevented
    }

    const kinds = () => editor.state.doc.content.content.map((node) => node.type.name)

    it('transforms a pasted "* item" into a bullet list', () => {
        expect(pasteText('* test')).toBe(true)
        const md = getMarkdownContent(editor)
        expect(md).toMatch(/^\*\s+test/)

        const firstChild = editor.state.doc.firstChild!
        expect(firstChild.type.name).toBe('bulletList')
    })

    it('keeps a pasted nested list tight, with no hard break before the sublist', () => {
        expect(pasteText('* Parent:\n    * child\n    * other\n* Next')).toBe(true)
        let hardBreaks = 0
        editor.state.doc.descendants((node) => {
            if (node.type.name === 'hardBreak') hardBreaks++
        })
        expect(hardBreaks).toBe(0)
        expect(getMarkdownContent(editor)).toBe('* Parent:\n  * child\n  * other\n* Next')
    })

    it('keeps the lines of a pasted code fence', () => {
        expect(pasteText('```js\nline one\n  line two\n```')).toBe(true)
        const code = editor.state.doc.firstChild
        expect(code?.type.name).toBe('ezcodeBlock')
        expect(code?.attrs.language).toBe('js')
        expect(code?.textContent).toBe('line one\n  line two')
    })

    it('pastes paragraphs as paragraphs, keeping the blank lines between them: each past the first an empty paragraph', () => {
        expect(pasteText('One.\n\n\n\nTwo.\n\nThree.\n\n\n')).toBe(true)
        expect(editor.state.doc.content.childCount).toBe(5)
        expect([...Array(5)].map((_, i) => [editor.state.doc.child(i).type.name, editor.state.doc.child(i).textContent])).toEqual([
            ['paragraph', 'One.'],
            ['paragraph', ''],
            ['paragraph', ''],
            ['paragraph', 'Two.'],
            ['paragraph', 'Three.'],
        ])
        expect(getMarkdownContent(editor)).toBe('One.\n\n \n\n \n\nTwo.\n\nThree.')
    })

    it('leaves the blank lines inside a pasted fence to the code', () => {
        expect(pasteText('Intro\n\n\n```\na\n\n\nb\n```')).toBe(true)
        expect(kinds().slice(0, 3)).toEqual(['paragraph', 'paragraph', 'ezcodeBlock'])
        expect(editor.state.doc.child(2).textContent).toBe('a\n\n\nb')
    })

    it('transforms a pasted "# Heading" into an h1', () => {
        expect(pasteText('# Hello')).toBe(true)
        expect(editor.state.doc.firstChild!.type.name).toBe('heading')
        expect(editor.state.doc.firstChild!.attrs.level).toBe(1)
        expect(getMarkdownContent(editor)).toBe('# Hello')
    })

    it('transforms a pasted "> quote" into a blockquote', () => {
        expect(pasteText('> wisdom')).toBe(true)
        expect(editor.state.doc.firstChild!.type.name).toBe('blockquote')
        expect(getMarkdownContent(editor)).toBe('> wisdom')
    })

    // Bug: `spaced` drops the paste's trailing blank line, so a slice ending in a
    // list stays open three deep; the text after the caret joins the last item
    // ("twoend.") and an empty paragraph is left behind.
    it('pastes block Markdown into the middle of a paragraph: the first line joins it, the rest follow as blocks, the text after the caret a paragraph of its own', () => {
        editor.commands.setContent('Start end.')
        editor.commands.setTextSelection(posOf(editor, 'end'))
        expect(pasteText('here\n\n* one\n* two\n\n')).toBe(true)
        expect(kinds()).toEqual(['paragraph', 'bulletList', 'paragraph'])
        expect(editor.state.doc.lastChild!.textContent).toBe('end.')
        expect(getMarkdownContent(editor)).toBe('Start here\n\n* one\n* two\n\nend.')
    })

    it('pastes Windows line endings as the same blocks', () => {
        expect(pasteText('# Title\r\n\r\nOne.\r\n\r\nTwo.')).toBe(true)
        expect(kinds()).toEqual(['heading', 'paragraph', 'paragraph'])
        expect(getMarkdownContent(editor)).toBe('# Title\n\nOne.\n\nTwo.')
    })

    it('defers to PM defaults when pasted text has no block markdown markers', () => {
        // "**bold**" is inline-only — our handler returns false and PM's
        // own paste (the HTML branch here, the wrapper being HTML) takes
        // it; the Bold mark's paste rule then reads the stars.
        expect(pasteText('**bold**')).toBe(true)
        // We're verifying *non-interception*: our handler shouldn't
        // have re-parsed this and produced extra blocks.
        expect(editor.state.doc.childCount).toBe(1)
        expect(editor.state.doc.firstChild!.type.name).toBe('paragraph')
        expect(getMarkdownContent(editor)).toBe('**bold**')
    })

    it('pastes rich HTML through PM’s HTML branch, the text payload’s Markdown unread', () => {
        // Real rich HTML (e.g. a styled selection from a web page) makes
        // our handler abstain so PM's normal HTML paste path preserves the
        // source formatting; the text side is not re-parsed as Markdown.
        expect(pasteText('# Real heading\n\n- Body text', '<h1>Real heading</h1><p>Body <em>text</em></p>')).toBe(true)
        expect(kinds().slice(0, 2)).toEqual(['heading', 'paragraph'])
        expect(getMarkdownContent(editor)).toBe('# Real heading\n\nBody *text*')
    })

    it('returns false from handlePaste when the HTML payload carries rich semantic tags', () => {
        // The handler itself, called as PM would: it abstains on rich HTML.
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
