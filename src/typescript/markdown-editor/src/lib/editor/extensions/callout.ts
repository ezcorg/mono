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
 * is a view state: it does not edit the file.
 *
 * The kinds are one table (`CALLOUT_KINDS`: the name styles use, a label,
 * an icon), and one menu chooses among them (`CalloutKindMenu`): the icon
 * before the title opens it over the callout, the slash command and "Turn
 * into → Callout" open it at the caret. It lists every kind with its icon
 * in its colour, the current one selected, and typing filters it (by the
 * kind's name or any name Obsidian accepts for it), so `/callout`, `war`,
 * Enter writes a warning.
 */
import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { TextSelection, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import { setupOnce } from './markdown-it'
import { SuggestionMenu } from '../ui/suggestion-menu'
import { button, el, labelled } from '../ui/dom'

/** A kind of callout: the name styles use (`data-callout-type`), what the
 *  menus call it, and its icon. */
export interface CalloutKind {
    type: string
    label: string
    icon: string
    /** The menu's second line: what the kind is for, and its other names. */
    description: string
}

/** The kinds, in the order the menus list them. */
export const CALLOUT_KINDS: readonly CalloutKind[] = [
    { type: 'note', label: 'Note', icon: '✎', description: 'Something to remember' },
    { type: 'abstract', label: 'Abstract', icon: '☰', description: 'A summary; also summary, tldr' },
    { type: 'info', label: 'Info', icon: 'ℹ', description: 'Background' },
    { type: 'todo', label: 'Todo', icon: '☐', description: 'Still to be done' },
    { type: 'tip', label: 'Tip', icon: '✦', description: 'Advice; also hint, important' },
    { type: 'success', label: 'Success', icon: '✓', description: 'Done, or working; also check, done' },
    { type: 'question', label: 'Question', icon: '?', description: 'Open, or often asked; also help, faq' },
    { type: 'warning', label: 'Warning', icon: '⚠', description: 'Mind this; also caution, attention' },
    { type: 'failure', label: 'Failure', icon: '✗', description: 'What went wrong; also fail, missing' },
    { type: 'danger', label: 'Danger', icon: '⚡', description: 'Harm ahead; also error' },
    { type: 'bug', label: 'Bug', icon: '✱', description: 'A known defect' },
    { type: 'example', label: 'Example', icon: '☷', description: 'A worked case' },
    { type: 'quote', label: 'Quote', icon: '❝', description: 'Someone’s words; also cite' },
]

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

/** The style a kind is drawn with (an unknown kind looks like a note). */
export function calloutType(kind: string): string {
    return KIND_ALIASES[kind.toLowerCase()] ?? 'note'
}

/** The icon a kind is drawn with: before its title, in the gutter, in the menus. */
export function calloutIcon(kind: string): string {
    const type = calloutType(kind)
    return (CALLOUT_KINDS.find((k) => k.type === type) ?? CALLOUT_KINDS[0]).icon
}

/** The kinds whose name, or any name accepted for them, starts with `query`. */
export function calloutKindsMatching(query: string): CalloutKind[] {
    const q = query.trim().toLowerCase()
    if (!q) return [...CALLOUT_KINDS]
    const types = new Set(Object.entries(KIND_ALIASES).filter(([alias]) => alias.startsWith(q)).map(([, type]) => type))
    return CALLOUT_KINDS.filter((k) => types.has(k.type))
}

export interface CalloutKindMenuOptions {
    /** Where the menu opens: by a rect (the callout's icon), or else under a
     *  range of the text (the caret's). */
    rect?: () => DOMRect
    range?: () => { from: number; to: number } | null
    /** The kind selected when the menu opens (a callout's own). */
    current?: string
    /** A kind chosen; the menu is closed first. */
    onPick: (kind: string) => void
    /** Closed without a choice: Escape, Backspace on an empty filter, a press elsewhere. */
    onClose?: () => void
}

/**
 * The menu of kinds: the slash menu's rows, each kind's icon in its colour,
 * the current kind selected. Typing filters it (the keys are taken on the
 * document, ahead of the editor, so nothing is typed into the note while
 * it is open); Backspace shortens the filter, or closes an unfiltered menu.
 */
export class CalloutKindMenu {
    private menu: SuggestionMenu
    private query = ''
    private listening = false

    constructor(view: EditorView, private readonly opts: CalloutKindMenuOptions) {
        this.menu = new SuggestionMenu({
            view,
            range: () => opts.range?.() ?? null,
            rect: opts.rect,
            className: 'ezco-mde-slash-menu ezco-mde-callout-menu',
            label: 'Kind of callout',
            onClose: () => this.closed(),
        })
    }

    get isOpen(): boolean {
        return this.menu.isOpen
    }

    open(): void {
        this.query = ''
        this.refresh()
        if (!this.listening) {
            document.addEventListener('keydown', this.keydown, true)
            this.listening = true
        }
    }

    /** Closed and gone; nothing is told. */
    close(): void {
        this.stop()
        this.menu.hide()
    }

    private stop() {
        if (!this.listening) return
        document.removeEventListener('keydown', this.keydown, true)
        this.listening = false
    }

    private closed() {
        this.stop()
        this.opts.onClose?.()
    }

    private refresh() {
        const kinds = calloutKindsMatching(this.query)
        const items = kinds.map((kind) => ({
            icon: kind.icon,
            title: kind.label,
            description: kind.description,
            data: { calloutType: kind.type },
            onSelect: () => {
                this.stop()
                this.opts.onPick(kind.type)
            },
        }))
        // The callout's own kind is selected until the filter is typed, when
        // the best match (the first) is.
        const current = this.opts.current ? calloutType(this.opts.current) : null
        const selected = this.query ? 0 : Math.max(0, kinds.findIndex((k) => k.type === current))
        this.menu.show(items, `No kind called “${this.query}”`, selected)
    }

    private readonly keydown = (event: KeyboardEvent) => {
        if (!this.menu.isOpen) return
        if (this.menu.handleKeyDown(event)) {
            event.stopPropagation()
            return
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return
        if (event.key === 'Backspace') {
            event.preventDefault()
            event.stopPropagation()
            if (!this.query) {
                this.menu.hide()
                this.closed()
                return
            }
            this.query = this.query.slice(0, -1)
            this.refresh()
        } else if (event.key.length === 1) {
            event.preventDefault()
            event.stopPropagation()
            this.query += event.key
            this.refresh()
        }
    }
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

const setupMarkdownIt = (markdownit: any) => setupOnce(markdownit, 'callout', () => {
    markdownit.core.ruler.before('inline', 'ezco_callout', calloutCoreRule)
    const esc = markdownit.utils.escapeHtml
    markdownit.renderer.rules.ezco_callout_open = (tokens: any[], idx: number) => {
        const { kind, fold, spaced } = tokens[idx].meta
        return `<div data-callout="${esc(kind)}" data-fold="${esc(fold)}"${spaced ? ' data-spaced=""' : ''}>`
    }
    markdownit.renderer.rules.ezco_callout_close = () => '</div>'
    markdownit.renderer.rules.ezco_callout_title_open = () => '<div data-callout-title="">'
    markdownit.renderer.rules.ezco_callout_title_close = () => '</div>'
})

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

/** Whether `block`, written on the line after the title, would be read as
 *  the title's setext underline: a rule (written `---`), or a paragraph whose
 *  first line is only `=` or `-`. Such a body is set off by a blank line. */
function underlinesTitle(block: PMNode): boolean {
    if (block.type.name === 'horizontalRule') return true
    return block.type.name === 'paragraph' && /^(?:=+|-+)[ \t]*$/.test(block.textContent.split('\n')[0])
}

/** The callout at `pos` (its own position), else the one `$pos` is inside. */
function calloutAt(state: EditorState, pos?: number, $pos: ResolvedPos = state.selection.$from): { node: PMNode; pos: number } | null {
    if (pos !== undefined) {
        const node = state.doc.nodeAt(pos)
        return node?.type.name === 'callout' ? { node, pos } : null
    }
    for (let depth = $pos.depth; depth > 0; depth--) {
        const node = $pos.node(depth)
        if (node.type.name === 'callout') return { node, pos: $pos.before(depth) }
    }
    return null
}

/** A callout's blocks without it: its body, with its title (when it has
 *  words) a paragraph before them. */
function unwrapped(callout: PMNode): PMNode[] {
    const { schema } = callout.type
    const blocks: PMNode[] = []
    const title = callout.firstChild
    if (title && title.content.size) blocks.push(schema.nodes.paragraph.create(null, title.content))
    for (let i = 1; i < callout.childCount; i++) blocks.push(callout.child(i))
    if (!blocks.length) blocks.push(schema.nodes.paragraph.create())
    return blocks
}

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
                        if (node.attrs.spaced || underlinesTitle(node.child(1))) state.closeBlock(title)
                        else state.ensureNewLine()
                        for (let i = 1; i < node.childCount; i++) state.render(node.child(i), node, i)
                    })
                },
                parse: { setup: setupMarkdownIt },
            } as MarkdownNodeSpec,
            /** The kind menu opened at the caret (`chooseCalloutKind`), while it stands. */
            menu: null as CalloutKindMenu | null,
        }
    },

    onDestroy() {
        this.storage.menu?.close()
        this.storage.menu = null
    },

    addNodeView() {
        return ({ node, getPos, editor }) => {
            let current = node
            // The kind's icon, the title and body, and (when foldable) the
            // fold's chevron: three columns of a grid, so the icon and the
            // chevron stand on the title's first line without being placed
            // by hand (styles.ts, `.ezco-mde-callout`).
            const dom = el('div', 'ezco-mde-callout')
            const icon = button('ezco-mde-callout-icon')
            icon.contentEditable = 'false'
            icon.setAttribute('aria-haspopup', 'listbox')
            const fold = button('ezco-mde-callout-fold')
            fold.contentEditable = 'false'
            fold.setAttribute('aria-label', 'Fold')
            const contentDOM = el('div', 'ezco-mde-callout-content')
            dom.append(icon, contentDOM, fold)

            let collapsed = node.attrs.fold === '-'
            let menu: CalloutKindMenu | null = null
            const apply = () => {
                const type = calloutType(current.attrs.kind)
                const name = current.attrs.kind.charAt(0).toUpperCase() + current.attrs.kind.slice(1).toLowerCase()
                dom.setAttribute('data-callout-type', type)
                dom.setAttribute('data-callout', current.attrs.kind)
                // An empty title shows the kind's name, as Obsidian does.
                dom.style.setProperty('--ezco-mde-callout-default-title', JSON.stringify(name))
                icon.textContent = calloutIcon(current.attrs.kind)
                labelled(icon, `${name} callout: change the kind`)
                fold.hidden = !current.attrs.fold
                dom.classList.toggle('is-collapsed', !!current.attrs.fold && collapsed)
                fold.setAttribute('aria-expanded', String(!collapsed))
            }
            apply()

            // The icon opens the menu of kinds over itself; a kind chosen is
            // set on this callout. The press is not the editor's (the
            // selection stays), and a second press closes the menu.
            icon.addEventListener('mousedown', (e) => e.preventDefault())
            icon.addEventListener('click', () => {
                if (menu?.isOpen) {
                    menu.close()
                    icon.setAttribute('aria-expanded', 'false')
                    return
                }
                menu = new CalloutKindMenu(editor.view, {
                    rect: () => icon.getBoundingClientRect(),
                    current: current.attrs.kind,
                    onPick: (kind) => {
                        icon.setAttribute('aria-expanded', 'false')
                        const pos = getPos()
                        if (pos === undefined) return
                        editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'kind', kind))
                    },
                    onClose: () => icon.setAttribute('aria-expanded', 'false'),
                })
                menu.open()
                icon.setAttribute('aria-expanded', 'true')
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
                destroy() {
                    menu?.close()
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
        const storage = this.storage
        return {
            /** Wrap the selected blocks in a callout of `kind` (default note),
             *  with the caret in its title. A quote becomes the callout, its
             *  blocks the body. */
            setCallout:
                (kind = 'note') =>
                ({ state, dispatch }) => {
                    const { $from, $to } = state.selection
                    const { schema } = state
                    const wrap = (from: number, to: number, blocks: PMNode[]) => {
                        if (!dispatch) return true
                        const callout = this.type.create({ kind }, [schema.nodes.calloutTitle.create(), ...blocks])
                        const tr = state.tr.replaceWith(from, to, callout)
                        tr.setSelection(TextSelection.create(tr.doc, from + 2)).scrollIntoView()
                        dispatch(tr)
                        return true
                    }
                    // A quote the caret is in becomes the callout, whole.
                    for (let depth = $from.depth; depth > 0; depth--) {
                        const node = $from.node(depth)
                        if (node.type.name !== 'blockquote') continue
                        const pos = $from.before(depth)
                        const blocks: PMNode[] = []
                        node.forEach((child) => blocks.push(child))
                        return wrap(pos, pos + node.nodeSize, blocks)
                    }
                    const range = $from.blockRange($to)
                    if (!range) return false
                    const blocks: PMNode[] = []
                    for (let i = range.startIndex; i < range.endIndex; i++) {
                        const child = range.parent.child(i)
                        if (!(child.type.name === 'paragraph' && child.content.size === 0)) blocks.push(child)
                    }
                    return wrap(range.start, range.end, blocks)
                },
            /** The kind of the callout at `pos` (else the one the caret is in). */
            setCalloutKind:
                (kind, pos) =>
                ({ state, tr, dispatch }) => {
                    const target = calloutAt(state, pos)
                    if (!target) return false
                    if (dispatch) tr.setNodeAttribute(target.pos, 'kind', kind)
                    return true
                },
            /** Whether the callout at `pos` (else the caret's) can be folded:
             *  the `+` after its kind, or none. A collapsed one (`-`) is left as
             *  written. */
            toggleCalloutFold:
                (pos) =>
                ({ state, tr, dispatch }) => {
                    const target = calloutAt(state, pos)
                    if (!target) return false
                    if (dispatch) tr.setNodeAttribute(target.pos, 'fold', target.node.attrs.fold ? '' : '+')
                    return true
                },
            /** The callout at `pos` (else the caret's) replaced by its blocks:
             *  the title's words a paragraph, then the body. */
            unsetCallout:
                (pos) =>
                ({ state, tr, dispatch }) => {
                    const target = calloutAt(state, pos)
                    if (!target) return false
                    if (dispatch) {
                        const blocks = unwrapped(target.node)
                        tr.replaceWith(target.pos, target.pos + target.node.nodeSize, blocks)
                        tr.setSelection(TextSelection.near(tr.doc.resolve(target.pos + 1)))
                    }
                    return true
                },
            /** The callout at `pos` (else the caret's) made a plain quote of the
             *  same blocks. */
            calloutToQuote:
                (pos) =>
                ({ state, tr, dispatch }) => {
                    const target = calloutAt(state, pos)
                    if (!target) return false
                    if (dispatch) {
                        const quote = state.schema.nodes.blockquote.create(null, unwrapped(target.node))
                        tr.replaceWith(target.pos, target.pos + target.node.nodeSize, quote)
                        tr.setSelection(TextSelection.near(tr.doc.resolve(target.pos + 1)))
                    }
                    return true
                },
            /** The menu of kinds, under the caret (or the title of the callout
             *  at `pos`): the kind chosen is set on the callout the caret is
             *  in, or the caret's blocks are made a callout of it. */
            chooseCalloutKind:
                (pos) =>
                ({ state, view, dispatch, editor }) => {
                    if (!dispatch) return true
                    const target = calloutAt(state, pos)
                    storage.menu?.close()
                    const menu = new CalloutKindMenu(view, {
                        range: () => {
                            const { doc, selection } = editor.state
                            const at = target ? Math.min(target.pos + 2, doc.content.size) : selection.from
                            return { from: at, to: at }
                        },
                        current: target?.node.attrs.kind,
                        onPick: (kind) => {
                            storage.menu = null
                            if (target) editor.commands.setCalloutKind(kind, target.pos)
                            else editor.commands.setCallout(kind)
                            editor.view.focus()
                        },
                        onClose: () => {
                            storage.menu = null
                        },
                    })
                    storage.menu = menu
                    menu.open()
                    return true
                },
        }
    },
})

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        callout: {
            setCallout: (kind?: string) => ReturnType
            setCalloutKind: (kind: string, pos?: number) => ReturnType
            toggleCalloutFold: (pos?: number) => ReturnType
            unsetCallout: (pos?: number) => ReturnType
            calloutToQuote: (pos?: number) => ReturnType
            chooseCalloutKind: (pos?: number) => ReturnType
        }
    }
}
