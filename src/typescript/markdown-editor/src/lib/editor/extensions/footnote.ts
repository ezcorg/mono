/**
 * Footnotes: a reference `[^label]` in the text and its definition
 * `[^label]: …` as a block, where it was written (footnote plugins usually
 * move every definition to the end of the document, which would rewrite the
 * file). A definition holds any blocks; its continuation lines are indented
 * four spaces, as Pandoc, GitHub and Obsidian read them. Footnotes are also
 * where comment threads will live (RFC §4).
 *
 * References number themselves in order of first use; a reference whose
 * label has no definition, or a definition nothing refers to, is marked.
 * Clicking a reference goes to its definition, and a definition's label back
 * to its first reference.
 */
import { Editor, InputRule, Node, mergeAttributes } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { MarkdownNodeSpec } from 'tiptap-markdown'

const isSpace = (c: number) => c === 0x20 || c === 0x09

/** `[^label]: …` and the lines indented under it (after markdown-it-footnote,
 *  but leaving the definition where it is). */
export function footnoteDefinitionRule(state: any, startLine: number, endLine: number, silent: boolean): boolean {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    if (start + 4 > max) return false
    if (state.src.charCodeAt(start) !== 0x5b || state.src.charCodeAt(start + 1) !== 0x5e) return false
    if (state.sCount[startLine] - state.blkIndent >= 4) return false
    let pos = start + 2
    for (; pos < max; pos++) {
        const c = state.src.charCodeAt(pos)
        if (c === 0x20 || c === 0x09) return false
        if (c === 0x5d) break
    }
    if (pos === start + 2 || pos + 1 >= max || state.src.charCodeAt(pos + 1) !== 0x3a) return false
    if (silent) return true
    const label = state.src.slice(start + 2, pos)
    pos += 2

    const open = state.push('ezco_footnote_def_open', 'section', 1)
    open.meta = { label }
    open.map = [startLine, 0]

    const oldBMark = state.bMarks[startLine]
    const oldTShift = state.tShift[startLine]
    const oldSCount = state.sCount[startLine]
    const oldParentType = state.parentType
    const afterColon = pos
    const initial = state.sCount[startLine] + pos - (state.bMarks[startLine] + state.tShift[startLine])
    let offset = initial
    for (; pos < max && isSpace(state.src.charCodeAt(pos)); pos++) {
        offset += state.src.charCodeAt(pos) === 0x09 ? 4 - (offset % 4) : 1
    }
    state.tShift[startLine] = pos - afterColon
    state.sCount[startLine] = offset - initial
    state.bMarks[startLine] = afterColon
    state.blkIndent += 4
    state.parentType = 'footnote'
    if (state.sCount[startLine] < state.blkIndent) state.sCount[startLine] += state.blkIndent

    state.md.block.tokenize(state, startLine, endLine)

    state.parentType = oldParentType
    state.blkIndent -= 4
    state.tShift[startLine] = oldTShift
    state.sCount[startLine] = oldSCount
    state.bMarks[startLine] = oldBMark
    open.map[1] = state.line

    state.push('ezco_footnote_def_close', 'section', -1)
    return true
}

/** `[^label]` in text. */
function footnoteReferenceRule(state: any, silent: boolean): boolean {
    const src: string = state.src
    const start: number = state.pos
    const max: number = state.posMax
    if (start + 3 > max || src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5e) return false
    let pos = start + 2
    for (; pos < max; pos++) {
        const c = src.charCodeAt(pos)
        if (c === 0x20 || c === 0x0a || c === 0x09) return false
        if (c === 0x5d) break
    }
    if (pos === start + 2 || pos >= max) return false
    if (!silent) state.push('ezco_footnote_ref', 'sup', 0).meta = { label: src.slice(start + 2, pos) }
    state.pos = pos + 1
    return true
}

function setupMarkdownIt(markdownit: any) {
    if (markdownit.__ezcoFootnotes) return
    markdownit.__ezcoFootnotes = true
    markdownit.block.ruler.before('reference', 'ezco_footnote_def', footnoteDefinitionRule, {
        alt: ['paragraph', 'reference'],
    })
    markdownit.inline.ruler.after('image', 'ezco_footnote_ref', footnoteReferenceRule)
    const esc = markdownit.utils.escapeHtml
    markdownit.renderer.rules.ezco_footnote_def_open = (tokens: any[], idx: number) =>
        `<section data-footnote-def="${esc(tokens[idx].meta.label)}">`
    markdownit.renderer.rules.ezco_footnote_def_close = () => '</section>'
    markdownit.renderer.rules.ezco_footnote_ref = (tokens: any[], idx: number) =>
        `<sup data-footnote-ref="${esc(tokens[idx].meta.label)}">${esc(tokens[idx].meta.label)}</sup>`
}

/** Where each label is referenced first and defined, in document order. */
function footnoteMap(doc: PMNode) {
    const numbers = new Map<string, number>()
    const firstRef = new Map<string, number>()
    const defs = new Map<string, number>()
    doc.descendants((node, pos) => {
        if (node.type.name === 'footnoteReference') {
            const label = node.attrs.label as string
            if (!numbers.has(label)) {
                numbers.set(label, numbers.size + 1)
                firstRef.set(label, pos)
            }
        } else if (node.type.name === 'footnoteDefinition' && !defs.has(node.attrs.label)) {
            defs.set(node.attrs.label, pos)
        }
        return true
    })
    return { numbers, firstRef, defs }
}

const footnotesKey = new PluginKey('footnotes')

/** The number a footnote's decoration carries (see the plugin below). */
function numberIn(decorations: readonly { spec: Record<string, unknown> }[]): string {
    for (const d of decorations) if (typeof d.spec.footnoteNumber === 'string') return d.spec.footnoteNumber
    return ''
}

export const FootnoteReference = Node.create({
    name: 'footnoteReference',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
        return {
            label: {
                default: '',
                parseHTML: (el) => el.getAttribute('data-footnote-ref') ?? '',
                renderHTML: (attrs) => ({ 'data-footnote-ref': attrs.label }),
            },
        }
    },

    parseHTML() {
        return [{ tag: 'sup[data-footnote-ref]' }]
    },

    renderHTML({ HTMLAttributes, node }) {
        return ['sup', mergeAttributes(HTMLAttributes, { class: 'ezco-mde-footnote-ref' }), node.attrs.label]
    },

    renderText({ node }) {
        return `[^${node.attrs.label}]`
    },

    // Input rules read the text before the caret; a reference reads as its
    // source there, so `[^1]: ` typed at a line start still makes a definition.
    extendNodeSchema(extension) {
        return extension.name === 'footnoteReference'
            ? { toText: ({ node }: { node: PMNode }) => `[^${node.attrs.label}]` }
            : {}
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: PMNode) {
                    state.write(`[^${node.attrs.label}]`)
                },
                parse: { setup: setupMarkdownIt },
            } as MarkdownNodeSpec,
        }
    },

    addNodeView() {
        const editor = this.editor
        return ({ node, decorations }) => {
            let current = node
            const dom = document.createElement('sup')
            dom.className = 'ezco-mde-footnote-ref'
            dom.contentEditable = 'false'
            dom.setAttribute('role', 'link')
            dom.title = `Footnote [^${node.attrs.label}]`
            dom.textContent = numberIn(decorations) || node.attrs.label
            dom.addEventListener('mousedown', (e) => e.preventDefault())
            dom.addEventListener('click', (e) => {
                e.preventDefault()
                goToDefinition(editor, current.attrs.label)
            })
            return {
                dom,
                update(next, nextDecorations) {
                    if (next.type !== current.type) return false
                    current = next
                    dom.title = `Footnote [^${next.attrs.label}]`
                    dom.textContent = numberIn(nextDecorations) || next.attrs.label
                    return true
                },
                stopEvent: (event) => event.type === 'mousedown' || event.type === 'click',
                ignoreMutation: () => true,
            }
        }
    },

    addInputRules() {
        return [
            new InputRule({
                find: /(?<!\\)\[\^([^\s\]]+)\]$/,
                handler: ({ state, range, match }) => {
                    state.tr.replaceWith(range.from, range.to, this.type.create({ label: match[1] }))
                },
            }),
        ]
    },

    addProseMirrorPlugins() {
        // The decorations follow the document, not the selection: computed
        // once per document, and the same set given back while it is the
        // same document (every caret move asks again).
        let last: { doc: PMNode; decorations: DecorationSet } | null = null
        return [
            new Plugin({
                key: footnotesKey,
                props: {
                    // Numbers, and what is missing, as attributes the styles show.
                    decorations(state) {
                        if (last && last.doc === state.doc) return last.decorations
                        const { numbers, defs } = footnoteMap(state.doc)
                        const decorations: Decoration[] = []
                        state.doc.descendants((node, pos) => {
                            const label = node.attrs?.label as string | undefined
                            const footnoteNumber = String(numbers.get(label!) ?? '')
                            if (node.type.name === 'footnoteReference') {
                                decorations.push(
                                    Decoration.node(
                                        pos,
                                        pos + node.nodeSize,
                                        { 'data-number': footnoteNumber, class: defs.has(label!) ? '' : 'is-missing' },
                                        { footnoteNumber },
                                    ),
                                )
                            } else if (node.type.name === 'footnoteDefinition') {
                                decorations.push(
                                    Decoration.node(
                                        pos,
                                        pos + node.nodeSize,
                                        { 'data-number': footnoteNumber, class: numbers.has(label!) ? '' : 'is-unreferenced' },
                                        { footnoteNumber },
                                    ),
                                )
                            }
                            return true
                        })
                        last = { doc: state.doc, decorations: DecorationSet.create(state.doc, decorations) }
                        return last.decorations
                    },
                },
            }),
        ]
    },
})

export const FootnoteDefinition = Node.create({
    name: 'footnoteDefinition',
    group: 'block',
    content: 'block+',
    defining: true,

    addAttributes() {
        return {
            label: {
                default: '',
                parseHTML: (el) => el.getAttribute('data-footnote-def') ?? '',
                renderHTML: (attrs) => ({ 'data-footnote-def': attrs.label }),
            },
        }
    },

    parseHTML() {
        return [{ tag: 'section[data-footnote-def]' }]
    },

    renderHTML({ HTMLAttributes }) {
        return ['section', mergeAttributes(HTMLAttributes, { class: 'ezco-mde-footnote-def' }), 0]
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: PMNode) {
                    state.wrapBlock('    ', `[^${node.attrs.label}]: `, node, () => state.renderContent(node))
                },
                parse: { setup: setupMarkdownIt },
            } as MarkdownNodeSpec,
        }
    },

    addNodeView() {
        const editor = this.editor
        return ({ node, decorations }) => {
            let current = node
            const dom = document.createElement('section')
            dom.className = 'ezco-mde-footnote-def'
            const label = document.createElement('span')
            label.className = 'ezco-mde-footnote-label'
            label.contentEditable = 'false'
            label.textContent = numberIn(decorations) || node.attrs.label
            label.title = 'Back to the reference'
            label.addEventListener('mousedown', (e) => e.preventDefault())
            label.addEventListener('click', () => goToReference(editor, current.attrs.label))
            const contentDOM = document.createElement('div')
            contentDOM.className = 'ezco-mde-footnote-body'
            dom.append(label, contentDOM)
            return {
                dom,
                contentDOM,
                update(next, nextDecorations) {
                    if (next.type !== current.type) return false
                    current = next
                    label.textContent = numberIn(nextDecorations) || next.attrs.label
                    return true
                },
                ignoreMutation: (m) => m.type !== 'selection' && label.contains(m.target),
            }
        }
    },

    addProseMirrorPlugins() {
        const type = this.type
        return [
            new Plugin({
                key: new PluginKey('footnoteDefinitionInput'),
                props: {
                    // A space after `[^label]:` at the start of a paragraph makes
                    // the paragraph a definition. Not an input rule: the marker is
                    // usually a reference node by then, and input rules do not
                    // match across nodes.
                    handleTextInput(view, from, to, text) {
                        if (text !== ' ' || from !== to) return false
                        const { state } = view
                        const $from = state.doc.resolve(from)
                        const paragraph = $from.parent
                        if (paragraph.type.name !== 'paragraph' || $from.depth === 0 || $from.parentOffset !== paragraph.content.size) {
                            return false
                        }
                        let label: string | null = null
                        const first = paragraph.firstChild
                        if (paragraph.childCount === 2 && first?.type.name === 'footnoteReference' && paragraph.child(1).text === ':') {
                            label = first.attrs.label
                        } else if (paragraph.childCount === 1 && first?.isText) {
                            label = /^\[\^([^\s\]]+)\]:$/.exec(first.text ?? '')?.[1] ?? null
                        }
                        if (!label) return false
                        const start = $from.start()
                        const tr = state.tr.delete(start, from)
                        const range = tr.doc.resolve(start).blockRange()
                        if (!range) return false
                        view.dispatch(tr.wrap(range, [{ type, attrs: { label } }]))
                        return true
                    },
                },
            }),
        ]
    },

    addCommands() {
        return {
            /** A new numbered footnote: a reference at the caret and an empty
             *  definition at the end of the note, with the caret in it. */
            insertFootnote:
                () =>
                ({ state, dispatch }) => {
                    const { numbers, defs } = footnoteMap(state.doc)
                    let n = 1
                    while (numbers.has(String(n)) || defs.has(String(n))) n++
                    const label = String(n)
                    const { schema } = state
                    const ref = schema.nodes.footnoteReference.create({ label })
                    const def = this.type.create({ label }, schema.nodes.paragraph.create())
                    if (!dispatch) return true
                    const tr = state.tr.replaceSelectionWith(ref, false)
                    // After the last definition, else after the last block with
                    // content (not after the empty paragraph that trails the
                    // document).
                    let at = tr.doc.content.size
                    let lastDef = -1
                    tr.doc.forEach((child, offset) => {
                        if (child.type === this.type) lastDef = offset + child.nodeSize
                    })
                    if (lastDef >= 0) at = lastDef
                    else {
                        for (let i = tr.doc.childCount - 1; i >= 0; i--) {
                            const child = tr.doc.child(i)
                            if (!(child.type.name === 'paragraph' && child.content.size === 0)) break
                            at -= child.nodeSize
                        }
                    }
                    tr.insert(at, def)
                    tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView()
                    dispatch(tr)
                    return true
                },
        }
    },
})

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        footnoteDefinition: {
            insertFootnote: () => ReturnType
        }
    }
}

function goToDefinition(editor: Editor, label: string) {
    const pos = footnoteMap(editor.state.doc).defs.get(label)
    if (pos === undefined) return
    const tr = editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 1)))
    editor.view.dispatch(tr.scrollIntoView())
    editor.view.focus()
}

function goToReference(editor: Editor, label: string) {
    const pos = footnoteMap(editor.state.doc).firstRef.get(label)
    if (pos === undefined) return
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)).scrollIntoView())
    editor.view.focus()
}
