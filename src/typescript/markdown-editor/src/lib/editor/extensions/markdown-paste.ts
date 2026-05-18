import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { DOMParser } from '@tiptap/pm/model'

/**
 * Block-level markdown paste.
 *
 * The bundled `tiptap-markdown` clipboard handler calls
 * `parser.parse(text, { inline: true })` — which is hardcoded in
 * tiptap-markdown@0.9.0 and only recognises *inline* markdown (bold,
 * italic, inline code, links). Block-level patterns like `* item`,
 * `# heading`, `> quote`, or fenced code blocks pasted as plain text
 * land in the document as literal characters.
 *
 * We intervene at `handlePaste` rather than `clipboardTextParser`
 * because real-browser paste events almost always carry both
 * `text/html` and `text/plain` payloads (browsers/OS auto-generate a
 * minimal HTML wrapper for plain text copies). PM routes paste through
 * its HTML branch when HTML is present, so a `clipboardTextParser`
 * never sees the data. `handlePaste` runs before that branch is taken
 * and gets the raw `ClipboardEvent` — letting us inspect the plain
 * text, decide whether it contains block markdown worth re-parsing,
 * and replace the selection with the block-parsed slice when it does.
 *
 *  - Pasted "* test"  → becomes a bullet list item
 *  - Pasted "# Hello" → becomes an h1
 *  - Pasted "> quote" → becomes a blockquote
 *  - Pasted "**bold**" into a paragraph → inline bold (the single-
 *    paragraph block slice is auto-opened by `parseSlice` via context)
 *  - Pasted rich HTML (e.g. a styled selection from a web page) →
 *    falls through to PM's HTML branch; we only handle paste when
 *    the HTML is the browser's plain-text wrapper.
 */

/** Recognise block-level markdown constructs at the start of any line. */
const BLOCK_MARKDOWN_RE =
    /^(?:\s{0,3})(?:[*\-+]\s|\d+\.\s|#{1,6}\s|>\s?|```|~~~|---|===)/m

/**
 * Detect HTML that is just the browser's wrapper around plain text
 * (vs. real rich-HTML from a web page or another editor). Browser
 * wrappers are typically a single `<meta>` and one or more `<p>` /
 * `<br>` / text nodes — no semantic tags like `<h1>`, `<ul>`, `<a>`.
 */
function isPlainTextWrapperHTML(html: string): boolean {
    if (!html) return true
    const RICH_TAGS = /<(h[1-6]|ul|ol|li|a |table|tr|td|th|blockquote|pre|code|strong|em|b\s|i\s)/i
    return !RICH_TAGS.test(html)
}

export const MarkdownBlockPaste = Extension.create({
    name: 'markdownBlockPaste',

    addProseMirrorPlugins() {
        const editor = this.editor

        return [
            new Plugin({
                key: new PluginKey('markdownBlockPaste'),
                props: {
                    handlePaste(view, event) {
                        const cd = (event as ClipboardEvent).clipboardData
                        if (!cd) return false

                        const text = cd.getData('text/plain')
                        if (!text) return false

                        // Bail on rich HTML — only re-parse when the
                        // HTML side is the browser's plain-text wrapper.
                        const html = cd.getData('text/html')
                        if (html && !isPlainTextWrapperHTML(html)) return false

                        // Only re-parse when the plain text contains
                        // block-level markdown. Inline-only pastes
                        // (single line of prose, "**bold**", a URL, etc.)
                        // are better served by PM's default behaviour —
                        // tiptap-markdown's inline parser still picks up
                        // bold/italic/etc. via its own paste rules.
                        if (!BLOCK_MARKDOWN_RE.test(text)) return false

                        const parser = (editor.storage as any).markdown?.parser
                        if (!parser) return false

                        const parsedHtml = parser.parse(text)
                        const container = document.createElement('div')
                        container.innerHTML = parsedHtml

                        const slice = DOMParser.fromSchema(view.state.schema).parseSlice(
                            container,
                            {
                                preserveWhitespace: true,
                                context: view.state.selection.$from,
                            },
                        )
                        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
                        return true
                    },
                },
            }),
        ]
    },
})
