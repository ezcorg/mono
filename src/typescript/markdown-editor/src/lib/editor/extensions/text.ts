import { Text } from '@tiptap/extension-text'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { MarkdownNodeSpec } from 'tiptap-markdown'

/**
 * A literal `$` that would open inline math on the next load: one followed
 * by a non-space, with a later `$` that could close it (preceded by a
 * non-space, not followed by a digit). Prices (`$5 and $10`) are left alone.
 * Applied per line by the serializer's own escaping.
 */
const MATH_DOLLAR = /\$(?=\S)(?=.*?\S\$(?!\d))/g

/**
 * The text node, serialized so that text stays text: `<`/`>` as
 * tiptap-markdown writes them, and, when the schema parses math, a `$` that
 * would read back as math escaped.
 */
export const MarkdownText = Text.extend({
    addStorage() {
        return {
            markdown: {
                serialize(this: { editor?: { schema: { nodes: Record<string, unknown> } } }, state: any, node: PMNode) {
                    const text = (node.text ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    if (!this.editor?.schema.nodes.mathInline) {
                        state.text(text)
                        return
                    }
                    const previous = state.options.escapeExtraCharacters
                    state.options.escapeExtraCharacters = MATH_DOLLAR
                    try {
                        state.text(text)
                    } finally {
                        state.options.escapeExtraCharacters = previous
                    }
                },
                parse: {},
            } as MarkdownNodeSpec,
        }
    },
})
