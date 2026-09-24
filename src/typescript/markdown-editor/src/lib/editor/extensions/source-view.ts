/**
 * Source on focus: nodes shown rendered (math typeset, front matter as a
 * table of properties) until the caret is in them, then as the source they
 * are written in, edited as ordinary text.
 *
 * Such a node holds its source as text content (`content: 'text*'`,
 * `code: true`) and renders through a node view with two parts: a rendered
 * preview the reader sees, and the `contentDOM` holding the source. This
 * plugin marks the node the selection is in with `is-editing` (the styles
 * swap the two parts on that class), and moves the caret into such a node
 * from the keyboard: arrowing onto hidden text would otherwise step over it,
 * since a browser cannot put a caret in text it does not display.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

export const sourceViewKey = new PluginKey('sourceView')

/** A node shows its source on focus when its schema says so: the node's
 *  extension returns `{ sourceView: true }` from `extendNodeSchema`. */
export const sourceViewSpec = { sourceView: true } as const

function isSource(node: PMNode | null | undefined): node is PMNode {
    return !!node && (node.type.spec as { sourceView?: boolean }).sourceView === true
}

/** Put the caret inside `node` (at `pos`), at its start or end. */
function enter(view: EditorView, pos: number, node: PMNode, atEnd: boolean): boolean {
    const inside = atEnd ? pos + node.nodeSize - 1 : pos + 1
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, inside))
    view.dispatch(tr.setMeta(sourceViewKey, 'enter').scrollIntoView())
    return true
}

export const SourceView = Extension.create({
    name: 'sourceView',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: sourceViewKey,
                props: {
                    decorations(state) {
                        const { $head } = state.selection
                        for (let depth = $head.depth; depth > 0; depth--) {
                            const node = $head.node(depth)
                            if (isSource(node)) {
                                const pos = $head.before(depth)
                                return DecorationSet.create(state.doc, [
                                    Decoration.node(pos, pos + node.nodeSize, { class: 'is-editing' }),
                                ])
                            }
                        }
                        return DecorationSet.empty
                    },
                    handleKeyDown(view, event) {
                        if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
                        const { selection } = view.state
                        if (!selection.empty) return false
                        const { $from } = selection
                        const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
                        const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                        if (!forward && !backward) return false
                        const horizontal = event.key === 'ArrowRight' || event.key === 'ArrowLeft'

                        // An inline source node beside the caret.
                        if (horizontal) {
                            if (forward && isSource($from.nodeAfter)) return enter(view, $from.pos, $from.nodeAfter, false)
                            if (backward && isSource($from.nodeBefore)) {
                                return enter(view, $from.pos - $from.nodeBefore.nodeSize, $from.nodeBefore, true)
                            }
                        }
                        // A block source node after or before this textblock.
                        if ($from.depth === 0 || isSource($from.parent)) return false
                        if (!view.endOfTextblock(forward ? (horizontal ? 'right' : 'down') : horizontal ? 'left' : 'up')) {
                            return false
                        }
                        if (forward) {
                            const after = $from.after()
                            const next = view.state.doc.resolve(after).nodeAfter
                            if (isSource(next)) return enter(view, after, next, false)
                        } else {
                            const before = $from.before()
                            const prev = view.state.doc.resolve(before).nodeBefore
                            if (isSource(prev)) return enter(view, before - prev.nodeSize, prev, true)
                        }
                        return false
                    },
                },
            }),
        ]
    },
})

/**
 * The two-part DOM of a source-on-focus node view: `dom` holds a rendered
 * `preview` (not editable; a click on it puts the caret in the source) and
 * the `contentDOM` where the source text lives.
 */
export function sourceViewDOM(
    view: EditorView,
    getPos: () => number | undefined,
    tags: { outer: 'div' | 'span'; source: 'pre' | 'span' | 'div' },
): { dom: HTMLElement; preview: HTMLElement; contentDOM: HTMLElement } {
    const dom = document.createElement(tags.outer)
    dom.classList.add('ezco-mde-source-view')
    const preview: HTMLElement = document.createElement(tags.outer === 'span' ? 'span' : 'div')
    preview.className = 'ezco-mde-source-preview'
    preview.contentEditable = 'false'
    const contentDOM = document.createElement(tags.source)
    contentDOM.className = 'ezco-mde-source-text'
    contentDOM.spellcheck = false
    dom.append(preview, contentDOM)
    preview.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0) return
        // Links and other controls in the preview keep their own clicks.
        if ((e.target as HTMLElement).closest('a, button, input')) return
        e.preventDefault()
        const pos = getPos()
        if (pos === undefined) return
        const node = view.state.doc.nodeAt(pos)
        if (!node) return
        enter(view, pos, node, true)
        view.focus()
    })
    return { dom, preview, contentDOM }
}
