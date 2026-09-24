/**
 * Callouts: a blockquote whose first line names a kind, as Obsidian writes
 * them (GitHub's alerts are the same syntax):
 *
 *     > [!warning]- Mind the gap
 *     > The body, any blocks.
 *
 * The node keeps the kind as written (its case too), the fold marker (`+`
 * open, `-` collapsed, none: not foldable) and whether a blank `>` line
 * separated the title from the body, so a callout serializes to the text it
 * came from. The title is inline content, editable like a heading. Folding
 * is a view state: it does not edit the file. Clicking the icon cycles the
 * kind.
 */
import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { MarkdownNodeSpec } from 'tiptap-markdown'

/** Kinds by the name styles use, with the other names Obsidian accepts. */
const KIND_ALIASES: Record<string, string> = {
    note: 'note',
    abstract: 'abstract', summary: 'abstract', tldr: 'abstract',
    info: 'info',
    todo: 'todo',
    tip: 'tip', hint: 'tip', important: 'tip',
    success: 'success', check: 'success', done: 'success',
    question: 'question', help: 'question', faq: 'question',
    warning: 'warning', caution: 'warning', attention: 'warning',
    failure: 'failure', fail: 'failure', missing: 'failure',
    danger: 'danger', error: 'danger',
    bug: 'bug',
    example: 'example',
    quote: 'quote', cite: 'quote',
}

/** The kinds clicking the icon cycles through. */
const CYCLE = ['note', 'tip', 'info', 'warning', 'danger', 'example', 'quote']

/** The style a kind is drawn with (an unknown kind looks like a note). */
export function calloutType(kind: string): string {
    return KIND_ALIASES[kind.toLowerCase()] ?? 'note'
}

const HEADER = /^\[!([A-Za-z0-9_-]+)\]([+-]?)(?:[ \t]+([^\n]*))?[ \t]*(?:\n|$)/

/** Turn blockquotes that open with `[!kind]` into callout tokens (a core rule,
 *  before inline parsing, so the title's text is still source). */
function calloutCoreRule(state: any) {
    const tokens: any[] = state.tokens
    for (let i = 0; i < tokens.length; i++) {
        const open = tokens[i]
        if (open.type !== 'blockquote_open') continue
        const para = tokens[i + 1]
        const inline = tokens[i + 2]
        if (para?.type !== 'paragraph_open' || inline?.type !== 'inline') continue
        const m = HEADER.exec(inline.content)
        if (!m) continue
        let close = i + 1
        while (close < tokens.length && !(tokens[close].type === 'blockquote_close' && tokens[close].level === open.level)) close++
        if (close >= tokens.length) continue

        const rest = inline.content.slice(m[0].length)
        let spaced = false
        const titleTokens = makeTitle(state, m[3] ?? '', open)
        if (rest) {
            // The body began on the line after the title, in the same paragraph.
            inline.content = rest
        } else {
            // The title was the whole paragraph: drop it, and remember whether a
            // blank line came before the next block.
            const next = tokens[i + 4]
            spaced = !!next && next !== tokens[close] && !!next.map && !!para.map && next.map[0] > para.map[1]
            tokens.splice(i + 1, 3)
            close -= 3
        }
        open.type = 'ezco_callout_open'
        open.tag = 'div'
        open.meta = { kind: m[1], fold: m[2], spaced }
        tokens[close].type = 'ezco_callout_close'
        tokens[close].tag = 'div'
        tokens.splice(i + 1, 0, ...titleTokens)
    }
}

function makeTitle(state: any, title: string, open: any): any[] {
    const titleOpen = new state.Token('ezco_callout_title_open', 'div', 1)
    const inline = new state.Token('inline', '', 0)
    inline.content = title
    inline.children = []
    inline.map = open.map
    const titleClose = new state.Token('ezco_callout_title_close', 'div', -1)
    titleOpen.level = open.level + 1
    inline.level = open.level + 2
    titleClose.level = open.level + 1
    return [titleOpen, inline, titleClose]
}

function setupMarkdownIt(markdownit: any) {
    if (markdownit.__ezcoCallouts) return
    markdownit.__ezcoCallouts = true
    markdownit.core.ruler.before('inline', 'ezco_callout', calloutCoreRule)
    const esc = markdownit.utils.escapeHtml
    markdownit.renderer.rules.ezco_callout_open = (tokens: any[], idx: number) => {
        const { kind, fold, spaced } = tokens[idx].meta
        return `<div data-callout="${esc(kind)}" data-fold="${esc(fold)}"${spaced ? ' data-spaced=""' : ''}>`
    }
    markdownit.renderer.rules.ezco_callout_close = () => '</div>'
    markdownit.renderer.rules.ezco_callout_title_open = () => '<div data-callout-title="">'
    markdownit.renderer.rules.ezco_callout_title_close = () => '</div>'
}

export const CalloutTitle = Node.create({
    name: 'calloutTitle',
    content: 'inline*',
    defining: true,

    parseHTML() {
        return [{ tag: 'div[data-callout-title]' }]
    },

    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes, { 'data-callout-title': '', class: 'ezco-mde-callout-title' }), 0]
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: PMNode) {
                    state.renderInline(node, false)
                },
                parse: {},
            } as MarkdownNodeSpec,
        }
    },

    addKeyboardShortcuts() {
        return {
            // Enter in the title goes to the body (a title is one line).
            Enter: ({ editor }) => {
                const { $from } = editor.state.selection
                if ($from.parent.type !== this.type) return false
                const callout = $from.node($from.depth - 1)
                const afterTitle = $from.after()
                const next = editor.state.doc.resolve(afterTitle).nodeAfter
                if (next && next.isTextblock) {
                    return editor.commands.setTextSelection(afterTitle + 1)
                }
                const paragraph = editor.schema.nodes.paragraph.create()
                if (!callout) return false
                return editor
                    .chain()
                    .insertContentAt(afterTitle, paragraph.toJSON())
                    .setTextSelection(afterTitle + 1)
                    .run()
            },
        }
    },
})

export const Callout = Node.create({
    name: 'callout',
    group: 'block',
    content: 'calloutTitle block*',
    defining: true,

    addAttributes() {
        return {
            kind: {
                default: 'note',
                parseHTML: (el) => el.getAttribute('data-callout') || 'note',
                renderHTML: (attrs) => ({ 'data-callout': attrs.kind }),
            },
            fold: {
                default: '',
                parseHTML: (el) => el.getAttribute('data-fold') ?? '',
                renderHTML: (attrs) => ({ 'data-fold': attrs.fold }),
            },
            spaced: {
                default: false,
                parseHTML: (el) => el.hasAttribute('data-spaced'),
                renderHTML: (attrs) => (attrs.spaced ? { 'data-spaced': '' } : {}),
            },
        }
    },

    parseHTML() {
        return [{ tag: 'div[data-callout]' }]
    },

    renderHTML({ HTMLAttributes, node }) {
        return [
            'div',
            mergeAttributes(HTMLAttributes, { class: 'ezco-mde-callout', 'data-callout-type': calloutType(node.attrs.kind) }),
            0,
        ]
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: PMNode) {
                    state.wrapBlock('> ', null, node, () => {
                        const title = node.firstChild
                        state.write(`[!${node.attrs.kind}]${node.attrs.fold}`)
                        if (title && title.content.size) {
                            state.write(' ')
                            state.renderInline(title, false)
                        }
                        if (node.childCount < 2) return
                        if (node.attrs.spaced) state.closeBlock(title)
                        else state.ensureNewLine()
                        for (let i = 1; i < node.childCount; i++) state.render(node.child(i), node, i)
                    })
                },
                parse: { setup: setupMarkdownIt },
            } as MarkdownNodeSpec,
        }
    },

    addNodeView() {
        return ({ node, getPos, editor }) => {
            let current = node
            const dom = document.createElement('div')
            dom.className = 'ezco-mde-callout'
            const icon = document.createElement('button')
            icon.type = 'button'
            icon.className = 'ezco-mde-callout-icon'
            icon.contentEditable = 'false'
            icon.title = 'Change the kind'
            const fold = document.createElement('button')
            fold.type = 'button'
            fold.className = 'ezco-mde-callout-fold'
            fold.contentEditable = 'false'
            fold.setAttribute('aria-label', 'Fold')
            const contentDOM = document.createElement('div')
            contentDOM.className = 'ezco-mde-callout-content'
            dom.append(icon, fold, contentDOM)

            let collapsed = node.attrs.fold === '-'
            const apply = () => {
                const type = calloutType(current.attrs.kind)
                dom.setAttribute('data-callout-type', type)
                dom.setAttribute('data-callout', current.attrs.kind)
                // An empty title shows the kind's name, as Obsidian does.
                dom.style.setProperty('--ezco-mde-callout-default-title', JSON.stringify(current.attrs.kind.charAt(0).toUpperCase() + current.attrs.kind.slice(1).toLowerCase()))
                fold.hidden = !current.attrs.fold
                dom.classList.toggle('is-collapsed', !!current.attrs.fold && collapsed)
                fold.setAttribute('aria-expanded', String(!collapsed))
            }
            apply()

            icon.addEventListener('mousedown', (e) => e.preventDefault())
            icon.addEventListener('click', () => {
                const pos = getPos()
                if (pos === undefined) return
                const next = CYCLE[(CYCLE.indexOf(calloutType(current.attrs.kind)) + 1) % CYCLE.length]
                editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'kind', next))
            })
            fold.addEventListener('mousedown', (e) => e.preventDefault())
            fold.addEventListener('click', () => {
                collapsed = !collapsed
                apply()
            })

            return {
                dom,
                contentDOM,
                update(next) {
                    if (next.type !== current.type) return false
                    current = next
                    apply()
                    return true
                },
                ignoreMutation: (m) => m.type !== 'selection' && !contentDOM.contains(m.target),
                stopEvent: (e) => e.target instanceof HTMLElement && (e.target === icon || e.target === fold),
            }
        }
    },

    addInputRules() {
        return [
            new InputRule({
                // `[!kind] ` typed at the start of a quote's first paragraph.
                find: /^\[!([A-Za-z0-9_-]+)\]([+-]?)\s$/,
                handler: ({ state, range, match }) => {
                    const $to = state.doc.resolve(range.to)
                    const quoteDepth = $to.depth - 1
                    if (quoteDepth < 1 || $to.node(quoteDepth).type.name !== 'blockquote' || $to.index(quoteDepth) !== 0) return null
                    const quote = $to.node(quoteDepth)
                    const quotePos = $to.before(quoteDepth)
                    const { schema } = state
                    const first = quote.firstChild!
                    const rest = first.cut(range.to - $to.start() + 0)
                    const body: PMNode[] = []
                    if (rest.content.size) body.push(rest)
                    quote.forEach((child, _o, i) => {
                        if (i > 0) body.push(child)
                    })
                    const callout = this.type.create(
                        { kind: match[1], fold: match[2] ?? '' },
                        [schema.nodes.calloutTitle.create(), ...body],
                    )
                    state.tr.replaceWith(quotePos, quotePos + quote.nodeSize, callout)
                    state.tr.setSelection(TextSelection.create(state.tr.doc, quotePos + 2))
                },
            }),
        ]
    },

    addCommands() {
        return {
            /** Wrap the selected blocks in a callout of `kind` (default note),
             *  with the caret in its title. */
            setCallout:
                (kind = 'note') =>
                ({ state, dispatch }) => {
                    const { $from, $to } = state.selection
                    const range = $from.blockRange($to)
                    if (!range) return false
                    const { schema } = state
                    const blocks: PMNode[] = []
                    for (let i = range.startIndex; i < range.endIndex; i++) {
                        const child = range.parent.child(i)
                        if (!(child.type.name === 'paragraph' && child.content.size === 0)) blocks.push(child)
                    }
                    const callout = this.type.create({ kind }, [schema.nodes.calloutTitle.create(), ...blocks])
                    if (!dispatch) return true
                    const tr = state.tr.replaceWith(range.start, range.end, callout)
                    tr.setSelection(TextSelection.create(tr.doc, range.start + 2)).scrollIntoView()
                    dispatch(tr)
                    return true
                },
        }
    },
})

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        callout: {
            setCallout: (kind?: string) => ReturnType
        }
    }
}
