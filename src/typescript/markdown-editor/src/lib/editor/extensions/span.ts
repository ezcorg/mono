/**
 * Bracketed spans, `[text]{#id .class key=value}` (Pandoc's and Djot's):
 * text with attributes and no look of its own. A comment pins its text with
 * one (`[lazy dog]{#c-01JAB3C4D5EFGHJK}`, comments RFC §1.2); any other use
 * (a class for an export, a key for a plugin) round-trips the same way.
 */
import { Mark, mergeAttributes } from '@tiptap/core'
import type { Mark as PMMark } from '@tiptap/pm/model'
import type { MarkdownMarkSpec } from 'tiptap-markdown'

export interface SpanAttributes {
    id: string | null
    /** Space-separated. */
    classes: string
    /** `key=value` pairs, in order. */
    attributes: Record<string, string>
}

const ATTRIBUTE = /\s*(?:#([^\s#.{}="]+)|\.([^\s#.{}="]+)|([A-Za-z_][\w-]*)=(?:"([^"]*)"|([^\s"{}]+)))/y

/** The text between `{` and `}`, or null when it is not an attribute list
 *  (it needs at least one attribute). */
export function parseSpanAttributes(text: string): SpanAttributes | null {
    const out: SpanAttributes = { id: null, classes: '', attributes: {} }
    const classes: string[] = []
    let count = 0
    ATTRIBUTE.lastIndex = 0
    while (ATTRIBUTE.lastIndex < text.length) {
        if (!text.slice(ATTRIBUTE.lastIndex).trim()) break
        const at = ATTRIBUTE.lastIndex
        const m = ATTRIBUTE.exec(text)
        if (!m || m.index !== at) return null
        if (m[1] !== undefined) {
            if (out.id !== null) return null
            out.id = m[1]
        } else if (m[2] !== undefined) classes.push(m[2])
        else out.attributes[m[3]] = m[4] ?? m[5]
        count++
    }
    if (!count) return null
    out.classes = classes.join(' ')
    return out
}

/** The same attributes: id, the classes in order, the pairs in order. */
function sameAttributes(a: SpanAttributes, b: SpanAttributes): boolean {
    return (
        (a.id ?? null) === (b.id ?? null) &&
        a.classes.split(/\s+/).filter(Boolean).join(' ') === b.classes.split(/\s+/).filter(Boolean).join(' ') &&
        JSON.stringify(Object.entries(a.attributes ?? {})) === JSON.stringify(Object.entries(b.attributes ?? {}))
    )
}

/** A mark's attribute list: as it was written, while the attributes are
 *  the ones that were read; in canonical form once they have changed. */
function spanAttributesOf(mark: PMMark): string {
    const attrs = mark.attrs as SpanAttributes & { raw: string | null }
    if (attrs.raw !== null) {
        const parsed = parseSpanAttributes(attrs.raw)
        if (parsed && sameAttributes(parsed, attrs)) return `{${attrs.raw}}`
    }
    return formatSpanAttributes(attrs)
}

export function formatSpanAttributes({ id, classes, attributes }: SpanAttributes): string {
    const parts: string[] = []
    if (id) parts.push(`#${id}`)
    for (const c of classes.split(/\s+/).filter(Boolean)) parts.push(`.${c}`)
    for (const [key, value] of Object.entries(attributes ?? {})) parts.push(`${key}=${/^[^\s"{}]+$/.test(value) ? value : `"${value}"`}`)
    return `{${parts.join(' ')}}`
}

/** `[…]{…}` in text, before markdown-it's link rule (a span is not a link
 *  even when its text names a reference). */
function spanRule(state: any, silent: boolean): boolean {
    const src: string = state.src
    const start: number = state.pos
    if (src.charCodeAt(start) !== 0x5b /* [ */) return false
    // `[[wikilink]]`, `[^footnote]`.
    const next = src.charCodeAt(start + 1)
    if (next === 0x5b || next === 0x5e) return false
    const labelEnd: number = state.md.helpers.parseLinkLabel(state, start, false)
    if (labelEnd < 0 || src.charCodeAt(labelEnd + 1) !== 0x7b /* { */) return false
    const close = src.indexOf('}', labelEnd + 2)
    if (close < 0 || close > state.posMax) return false
    const attrs = parseSpanAttributes(src.slice(labelEnd + 2, close))
    if (!attrs) return false
    if (!silent) {
        state.push('ezco_span_open', 'span', 1).meta = { ...attrs, raw: src.slice(labelEnd + 2, close) }
        const oldPos = state.pos
        const oldMax = state.posMax
        state.pos = start + 1
        state.posMax = labelEnd
        state.md.inline.tokenize(state)
        state.pos = oldPos
        state.posMax = oldMax
        state.push('ezco_span_close', 'span', -1)
    }
    state.pos = close + 1
    return true
}

function setupMarkdownIt(markdownit: any) {
    if (markdownit.__ezcoSpans) return
    markdownit.__ezcoSpans = true
    markdownit.inline.ruler.before('link', 'ezco_span', spanRule)
    const esc = markdownit.utils.escapeHtml
    markdownit.renderer.rules.ezco_span_open = (tokens: any[], idx: number) => {
        const { id, classes, attributes, raw } = tokens[idx].meta as SpanAttributes & { raw: string }
        const data = [
            id ? ` data-id="${esc(id)}"` : '',
            classes ? ` data-classes="${esc(classes)}"` : '',
            Object.keys(attributes).length ? ` data-attributes="${esc(JSON.stringify(attributes))}"` : '',
            ` data-raw="${esc(raw)}"`,
        ].join('')
        return `<span data-md-span${data}>`
    }
    markdownit.renderer.rules.ezco_span_close = () => '</span>'
}

export const Span = Mark.create({
    name: 'span',
    // Typing at its edge is not typing into it.
    inclusive: false,

    addAttributes() {
        return {
            id: {
                default: null,
                parseHTML: (el) => el.getAttribute('data-id'),
                renderHTML: (attrs) => (attrs.id ? { 'data-id': attrs.id } : {}),
            },
            classes: {
                default: '',
                parseHTML: (el) => el.getAttribute('data-classes') ?? '',
                renderHTML: (attrs) => (attrs.classes ? { 'data-classes': attrs.classes } : {}),
            },
            attributes: {
                default: {},
                parseHTML: (el) => {
                    try {
                        return JSON.parse(el.getAttribute('data-attributes') ?? '{}')
                    } catch {
                        return {}
                    }
                },
                renderHTML: (attrs) => (Object.keys(attrs.attributes ?? {}).length ? { 'data-attributes': JSON.stringify(attrs.attributes) } : {}),
            },
            /** The attribute list as written (`.note #n1 key="v"`), written
             *  back as long as it still says what the attributes say. */
            raw: {
                default: null,
                parseHTML: (el) => el.getAttribute('data-raw'),
                renderHTML: () => ({}),
            },
        }
    },

    parseHTML() {
        return [{ tag: 'span[data-md-span]' }]
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { 'data-md-span': '', class: 'ezco-mde-span' }), 0]
    },

    addStorage() {
        return {
            markdown: {
                serialize: {
                    open: '[',
                    close: (_state: unknown, mark: PMMark) => `]${spanAttributesOf(mark)}`,
                    expelEnclosingWhitespace: true,
                },
                parse: { setup: setupMarkdownIt },
            } as MarkdownMarkSpec,
        }
    },
})
