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
 *  - Pasted paragraphs (text with a blank line in it) → paragraphs, and
 *    the blank lines past the one between two paragraphs are kept, each
 *    an empty paragraph (Markdown alone would fold the run into one
 *    break, and the spacing someone typed in would be gone).
 */

/** Recognise block-level markdown constructs at the start of any line. */
const BLOCK_MARKDOWN_RE =
    /^(?:\s{0,3})(?:[*\-+]\s|\d+\.\s|#{1,6}\s|>\s?|```|~~~|---|===)/m
/** A blank line: what parts two paragraphs. */
const PARAGRAPH_BREAK_RE = /\n[ \t]*\n/

/**
 * `text` with its blank lines past the first of a run each made an empty
 * paragraph, written as the paragraph node writes one (a non-breaking
 * space, which the parser reads back as an empty paragraph). The lines of
 * a fence are the code's and are left alone; blank lines before the first
 * paragraph and after the last are nothing.
 */
export function spaced(text: string): string {
    const out: string[] = []
    let fence: RegExp | null = null
    let blank = 0
    const part = () => {
        if (blank && out.length) {
            for (let i = 1; i < blank; i++) out.push('', '\u00A0')
            out.push('')
        }
        blank = 0
    }
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        if (fence) {
            out.push(line)
            if (fence.test(line)) fence = null
            continue
        }
        if (!line.trim()) {
            blank++
            continue
        }
        part()
        out.push(line)
        const open = /^ {0,3}(`{3,}|~{3,})/.exec(line)
        if (open) fence = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}[ \\t]*$`)
    }
    return out.join('\n')
}

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
                        // block-level markdown or more than one paragraph.
                        // Inline-only pastes (single line of prose,
                        // "**bold**", a URL, etc.) are better served by
                        // PM's default behaviour — tiptap-markdown's inline
                        // parser still picks up bold/italic/etc. via its
                        // own paste rules.
                        if (!BLOCK_MARKDOWN_RE.test(text) && !PARAGRAPH_BREAK_RE.test(text)) return false

                        const parser = (editor.storage as any).markdown?.parser
                        if (!parser) return false

                        const parsedHtml = parser.parse(spaced(text))
                        const container = document.createElement('div')
                        container.innerHTML = parsedHtml

                        // Whitespace as HTML reads it: markdown-it puts a
                        // newline between a list item's text and its nested
                        // list, and preserving it would make it a hard break
                        // (the schema's hard break stands in for line breaks
                        // when whitespace is kept). Code keeps its whitespace
                        // anyway: the parser keeps all of it in a `code` node.
                        const slice = DOMParser.fromSchema(view.state.schema).parseSlice(
                            container,
                            { context: view.state.selection.$from },
                        )
                        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
                        return true
                    },
                },
            }),
        ]
    },
})
