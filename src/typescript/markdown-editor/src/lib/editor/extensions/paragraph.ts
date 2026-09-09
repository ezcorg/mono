import { Node, mergeAttributes } from '@tiptap/core'
import type { MarkdownNodeSpec } from 'tiptap-markdown'

/**
 * Paragraph with empty-paragraph round-tripping.
 *
 * Drop-in replacement for StarterKit's paragraph (same name/schema/commands),
 * with one behaviour added: a run of *empty* paragraphs — deliberate vertical
 * spacing the user typed — survives a Markdown save+reload.
 *
 * The problem: an empty paragraph serializes to a bare blank line, and
 * CommonMark collapses consecutive blank lines into a single paragraph break.
 * So `A ⏎ ⏎ ⏎ ⏎ B` round-trips to just `A\n\nB` and the spacing is lost.
 *
 * The fix: serialize each empty paragraph as a single non-breaking space, so it
 * survives re-parsing as its own block; a markdown-it core rule then strips
 * that NBSP back out on load so the editor still sees a *truly* empty paragraph
 * (no stray whitespace to trip over when the user starts typing in it).
 */
export const Paragraph = Node.create({
    name: 'paragraph',
    priority: 1000,

    addOptions() {
        return {
            HTMLAttributes: {},
        }
    },

    group: 'block',
    content: 'inline*',

    parseHTML() {
        return [{ tag: 'p' }]
    },

    renderHTML({ HTMLAttributes }) {
        return ['p', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
    },

    addKeyboardShortcuts() {
        return {
            'Mod-Alt-0': () => this.editor.commands.setParagraph(),
        }
    },

    addCommands() {
        return {
            setParagraph:
                () =>
                ({ commands }) =>
                    commands.setNode(this.name),
        }
    },

    addStorage() {
        return {
            markdown: {
                serialize(state, node) {
                    if (node.content.size === 0) {
                        // NBSP keeps an otherwise-empty paragraph from
                        // collapsing into adjacent blank lines on re-parse.
                        state.write('\u00A0')
                        state.closeBlock(node)
                        return
                    }
                    // Same as prosemirror-markdown's default paragraph.
                    state.renderInline(node)
                    state.closeBlock(node)
                },
                parse: {
                    setup(markdownit: any) {
                        if (markdownit.__ezcoEmptyPara) return
                        markdownit.__ezcoEmptyPara = true
                        // Reverse of the serializer: a paragraph that is just
                        // our NBSP marker becomes a truly empty paragraph. The
                        // separate block token still survives, so the blank line
                        // (the user's spacing) is preserved.
                        markdownit.core.ruler.push('ezco_empty_paragraph', (state: any) => {
                            for (const token of state.tokens) {
                                if (token.type === 'inline' && token.content === '\u00A0') {
                                    token.content = ''
                                    token.children = []
                                }
                            }
                        })
                    },
                },
            } as MarkdownNodeSpec,
        }
    },
})
