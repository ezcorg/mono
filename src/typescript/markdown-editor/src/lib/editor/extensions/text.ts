import { Text } from '@tiptap/extension-text'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { MarkdownNodeSpec } from 'tiptap-markdown'

/**
 * The indices of the `$`s in `text` that would open inline math on the next
 * load, `after` being what follows `text` in its paragraph as it will be
 * written. The test is the parser's (Pandoc's rule, `math.ts`): a `$` with a
 * non-space after it opens when a later `$` has a non-space before it and no
 * digit after it. Prices (`$5 and $10`) are left alone. A `$` that is itself
 * escaped later is still counted as a closer: escaping one opener too many
 * costs nothing, one too few turns text into math.
 */
export function mathDollars(text: string, after: string): number[] {
    const source = text + after
    const out: number[] = []
    for (let i = text.indexOf('$'); i >= 0; i = text.indexOf('$', i + 1)) {
        const next = source[i + 1]
        if (next === undefined || /\s/.test(next)) continue
        for (let j = source.indexOf('$', i + 1); j >= 0; j = source.indexOf('$', j + 1)) {
            const before = source[j - 1]
            if (before === '\\' || /\s/.test(before) || /\d/.test(source[j + 1] ?? '')) continue
            out.push(i)
            break
        }
    }
    return out
}

/**
 * What follows child `index` of the textblock `parent`, as the serializer
 * will write it, near enough for `mathDollars`: text as it is (code as
 * non-space), inline math as `$tex$`, a hard break as a newline, any other
 * inline node, and a mark delimiter wherever marks change, as a non-space.
 */
function sourceAfter(parent: PMNode, index: number): string {
    let out = ''
    let marks = parent.child(index).marks
    for (let k = index + 1; k < parent.childCount; k++) {
        const child = parent.child(k)
        if (child.marks.length !== marks.length || child.marks.some((m, n) => !m.eq(marks[n]))) out += '*'
        marks = child.marks
        if (child.isText) out += child.marks.some((m) => m.type.spec.code) ? 'x'.repeat(child.text!.length) : child.text
        else if (child.type.name === 'mathInline') out += `$${child.textContent}$`
        else if (child.type.name === 'hardBreak') out += '\n'
        else out += 'x'
    }
    if (marks.length) out += '*'
    return out
}

/**
 * The text node, serialized so that text stays text: `<`/`>` as
 * tiptap-markdown writes them, and, when the schema parses math, a `$` that
 * would read back as math escaped, judged against the rest of its paragraph
 * (the `$` that would close it may be past bold text or a wikilink).
 */
export const MarkdownText = Text.extend({
    addStorage() {
        return {
            markdown: {
                serialize(
                    this: { editor?: { schema: { nodes: Record<string, unknown> } } },
                    state: any,
                    node: PMNode,
                    parent?: PMNode,
                    index?: number,
                ) {
                    const text = (node.text ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    if (!this.editor?.schema.nodes.mathInline) {
                        state.text(text)
                        return
                    }
                    const after = parent && index !== undefined && parent.isTextblock ? sourceAfter(parent, index) : ''
                    let from = 0
                    for (const at of mathDollars(text, after)) {
                        if (at > from) state.text(text.slice(from, at))
                        state.write('\\$')
                        from = at + 1
                    }
                    if (from < text.length) state.text(text.slice(from))
                },
                parse: {},
            } as MarkdownNodeSpec,
        }
    },
})
