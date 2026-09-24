/**
 * Math: `$…$` inline and `$$…$$` as a block, typeset until the caret enters
 * it, then edited as TeX source (see `source-view.ts`).
 *
 * Typesetting is behind an interface, `MathRenderer`, so the renderer is not
 * a dependency of the editor's core: the default loads KaTeX (and its
 * stylesheet) the first time a formula is shown; a host may supply MathJax,
 * a server-side renderer, or a WASM component instead.
 *
 * The inline rule is Pandoc's, so prices stay prices: an opening `$` has a
 * non-space after it, a closing `$` a non-space before it and no digit after
 * it (`$5 and $10` is text). A `$` in text that would read back as math is
 * escaped when saved (see `text.ts`).
 */
import { Extension, InputRule, Node, mergeAttributes, textblockTypeInputRule } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import { sourceViewDOM, sourceViewSpec } from './source-view'

/** Typeset `tex` into `element`. May be asynchronous (load a renderer lazily). */
export type MathRenderer = (tex: string, element: HTMLElement, options: { displayMode: boolean }) => void | Promise<void>

let katex: Promise<typeof import('katex').default> | null = null

/** The default renderer: KaTeX, loaded (with its stylesheet) on first use. */
export const katexRenderer: MathRenderer = async (tex, element, { displayMode }) => {
    katex ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([mod]) => mod.default)
    ;(await katex).render(tex, element, { displayMode, throwOnError: false, output: 'htmlAndMathml' })
}

export interface MathOptions {
    renderer: MathRenderer
}

/** Render `tex` into a node view's preview, or a placeholder when empty. */
function typeset(preview: HTMLElement, tex: string, renderer: MathRenderer, displayMode: boolean): Promise<void> {
    if (!tex.trim()) {
        preview.replaceChildren()
        preview.classList.add('is-empty')
        preview.textContent = displayMode ? 'Math block' : 'math'
        return Promise.resolve()
    }
    preview.classList.remove('is-empty')
    const target = document.createElement(displayMode ? 'div' : 'span')
    return Promise.resolve(renderer(tex, target, { displayMode })).then(
        () => preview.replaceChildren(target),
        (e) => {
            preview.classList.add('is-invalid')
            preview.textContent = String((e as Error)?.message ?? e)
        },
    )
}

function mathNodeView(renderer: MathRenderer, block: boolean) {
    return ({ node, getPos, view }: { node: PMNode; getPos: () => number | undefined; view: any }) => {
        const { dom, preview, contentDOM } = sourceViewDOM(view, getPos, block ? { outer: 'div', source: 'pre' } : { outer: 'span', source: 'span' })
        dom.classList.add(block ? 'ezco-mde-math-block' : 'ezco-mde-math-inline')
        let current = node
        let token = 0
        const render = () => {
            const mine = ++token
            const staging = document.createElement(block ? 'div' : 'span')
            void typeset(staging, current.textContent, renderer, block || !!current.attrs.display).then(() => {
                if (mine !== token) return
                preview.className = `ezco-mde-source-preview ${staging.className}`.trim()
                preview.replaceChildren(...staging.childNodes)
            })
        }
        render()
        return {
            dom,
            contentDOM,
            update(next: PMNode) {
                if (next.type !== current.type) return false
                const changed = next.textContent !== current.textContent || next.attrs.display !== current.attrs.display
                current = next
                if (changed) render()
                return true
            },
            ignoreMutation: (m: MutationRecord | { type: 'selection'; target: globalThis.Node }) =>
                m.type !== 'selection' && !contentDOM.contains(m.target),
            destroy() {
                token++
            },
        }
    }
}

// ─── The markdown-it rules ───────────────────────────────────────────────────

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || Number.isNaN(c)
const isDigit = (c: number) => c >= 0x30 && c <= 0x39

function mathInlineRule(state: any, silent: boolean): boolean {
    const src: string = state.src
    const start: number = state.pos
    if (src.charCodeAt(start) !== 0x24) return false
    const display = src.charCodeAt(start + 1) === 0x24
    const fence = display ? 2 : 1
    const first = src.charCodeAt(start + fence)
    if (isSpace(first) || first === 0x24) return false
    for (let pos = start + fence; ; ) {
        const found = src.indexOf(display ? '$$' : '$', pos)
        if (found < 0 || found + fence > state.posMax) return false
        pos = found + 1
        const before = src.charCodeAt(found - 1)
        if (before === 0x5c /* \ */ || isSpace(before)) continue
        if (!display && isDigit(src.charCodeAt(found + 1))) continue
        if (!silent) {
            const token = state.push('ezco_math_inline', 'span', 0)
            token.content = src.slice(start + fence, found)
            token.meta = { display }
        }
        state.pos = found + fence
        return true
    }
}

function mathBlockRule(state: any, startLine: number, endLine: number, silent: boolean): boolean {
    const lineText = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n])
    if (state.sCount[startLine] - state.blkIndent >= 4) return false
    const first = lineText(startLine)
    if (!first.startsWith('$$')) return false
    const rest = first.slice(2)
    // `$$ … $$` on one line.
    if (rest.trimEnd().endsWith('$$') && rest.trimEnd().length > 2) {
        if (silent) return true
        const token = state.push('ezco_math_block', 'div', 0)
        token.content = rest.trimEnd().slice(0, -2)
        token.meta = { oneLine: true }
        token.map = [startLine, startLine + 1]
        state.line = startLine + 1
        return true
    }
    let close = -1
    for (let n = startLine + 1; n < endLine; n++) {
        if (state.sCount[n] < state.blkIndent) break
        if (lineText(n).trimEnd().endsWith('$$')) {
            close = n
            break
        }
    }
    if (close < 0) return false
    if (silent) return true
    const lines: string[] = []
    if (rest.trim()) lines.push(rest)
    for (let n = startLine + 1; n < close; n++) {
        lines.push(state.src.slice(state.bMarks[n] + Math.min(state.tShift[n], state.blkIndent), state.eMarks[n]))
    }
    const last = lineText(close).trimEnd().slice(0, -2)
    if (last.trim()) lines.push(last)
    const token = state.push('ezco_math_block', 'div', 0)
    token.content = lines.join('\n')
    token.meta = { oneLine: false }
    token.map = [startLine, close + 1]
    state.line = close + 1
    return true
}

function setupMarkdownIt(markdownit: any) {
    if (markdownit.__ezcoMath) return
    markdownit.__ezcoMath = true
    markdownit.inline.ruler.after('escape', 'ezco_math_inline', mathInlineRule)
    markdownit.block.ruler.before('fence', 'ezco_math_block', mathBlockRule, {
        alt: ['paragraph', 'reference', 'blockquote', 'list'],
    })
    const esc = markdownit.utils.escapeHtml
    markdownit.renderer.rules.ezco_math_inline = (tokens: any[], idx: number) =>
        `<span data-math-inline=""${tokens[idx].meta.display ? ' data-display=""' : ''}>${esc(tokens[idx].content)}</span>`
    markdownit.renderer.rules.ezco_math_block = (tokens: any[], idx: number) =>
        `<div data-math-block=""${tokens[idx].meta.oneLine ? ' data-one-line=""' : ''}>${esc(tokens[idx].content)}</div>`
}

// ─── The nodes ───────────────────────────────────────────────────────────────

export const MathInline = Node.create<MathOptions>({
    name: 'mathInline',
    group: 'inline',
    inline: true,
    content: 'text*',
    marks: '',
    code: true,

    addOptions() {
        return { renderer: katexRenderer }
    },

    addAttributes() {
        return {
            // `$$…$$` written inside a paragraph: typeset as display math.
            display: {
                default: false,
                parseHTML: (el) => el.hasAttribute('data-display'),
                renderHTML: (attrs) => (attrs.display ? { 'data-display': '' } : {}),
            },
        }
    },

    parseHTML() {
        return [{ tag: 'span[data-math-inline]', preserveWhitespace: 'full' }]
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { 'data-math-inline': '' }), 0]
    },

    extendNodeSchema(extension) {
        return extension.name === 'mathInline' ? sourceViewSpec : {}
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: PMNode) {
                    const fence = node.attrs.display ? '$$' : '$'
                    state.write(fence)
                    state.text(node.textContent, false)
                    state.write(fence)
                },
                parse: { setup: setupMarkdownIt },
            } as MarkdownNodeSpec,
        }
    },

    addNodeView() {
        return mathNodeView(this.options.renderer, false)
    },

    addInputRules() {
        return [
            new InputRule({
                // `$tex$` just closed (Pandoc's rule; not `$$`, not escaped).
                find: /(?<![\\$])\$([^\s$](?:[^$]*?[^\s$\\])?)\$$/,
                handler: ({ state, range, match }) => {
                    state.tr.replaceWith(range.from, range.to, this.type.create(null, state.schema.text(match[1])))
                },
            }),
        ]
    },
})

export const MathBlock = Node.create<MathOptions>({
    name: 'mathBlock',
    group: 'block',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,

    addOptions() {
        return { renderer: katexRenderer }
    },

    addAttributes() {
        return {
            // Written `$$tex$$` on one line (else `$$`, the TeX, `$$` on lines of their own).
            oneLine: {
                default: false,
                parseHTML: (el) => el.hasAttribute('data-one-line'),
                renderHTML: (attrs) => (attrs.oneLine ? { 'data-one-line': '' } : {}),
            },
        }
    },

    parseHTML() {
        return [{ tag: 'div[data-math-block]', preserveWhitespace: 'full' }]
    },

    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes, { 'data-math-block': '' }), 0]
    },

    extendNodeSchema(extension) {
        return extension.name === 'mathBlock' ? sourceViewSpec : {}
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: PMNode) {
                    const tex = node.textContent
                    if (node.attrs.oneLine && !tex.includes('\n')) {
                        state.write(`$$${tex}$$`)
                    } else {
                        state.write('$$\n')
                        if (tex) {
                            state.text(tex, false)
                            state.ensureNewLine()
                        }
                        state.write('$$')
                    }
                    state.closeBlock(node)
                },
                parse: { setup: setupMarkdownIt },
            } as MarkdownNodeSpec,
        }
    },

    addNodeView() {
        return mathNodeView(this.options.renderer, true)
    },

    addInputRules() {
        // `$$` then a space or Enter at the start of an empty paragraph.
        return [textblockTypeInputRule({ find: /^\$\$\s$/, type: this.type })]
    },
})

/** Inline and block math, sharing one renderer. */
export const Mathematics = Extension.create<Partial<MathOptions>>({
    name: 'mathematics',

    addOptions() {
        return { renderer: undefined }
    },

    addExtensions() {
        const renderer = this.options.renderer ?? katexRenderer
        return [MathInline.configure({ renderer }), MathBlock.configure({ renderer })]
    },
})
