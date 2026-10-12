/**
 * Folding: a block, or the blocks a selection spans, folded to one line
 * (as a code editor folds a function), and opened again from it. What is
 * folded is only hidden, in the view: the note is written whole, and a
 * fold is forgotten when the note is closed. The caret moving into a fold
 * (arrowing down into it, say) opens it, as editing inside a fold does in
 * a code editor. The gutter (block-actions.ts) marks a fold with its own
 * glyph; "Fold" in a block's menu makes one, the line itself undoes it.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

export interface Fold {
    /** The start of the first folded block and the end of the last. */
    from: number
    to: number
}

export interface FoldingState {
    folds: Fold[]
}

export const foldingKey = new PluginKey<FoldingState>('folding')

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        folding: {
            /** Fold the top-level blocks between `from` and `to` to one line. */
            foldBlocks: (from: number, to: number) => ReturnType
            /** Fold the blocks the selection spans (the caret's block alone). */
            foldSelection: () => ReturnType
            /** Open the fold `pos` is in. */
            unfold: (pos: number) => ReturnType
        }
    }
}

/** The folds of `state`. */
export function foldsOf(state: EditorState): Fold[] {
    return foldingKey.getState(state)?.folds ?? []
}

/** The fold `pos` lies in, if any. */
export function foldAt(state: EditorState, pos: number): Fold | null {
    return foldsOf(state).find((f) => pos >= f.from && pos < f.to) ?? null
}

/** `from`..`to` widened to whole top-level blocks. */
function blockRange(doc: PMNode, from: number, to: number): Fold | null {
    const size = doc.content.size
    const $from = doc.resolve(Math.max(0, Math.min(from, size)))
    const $to = doc.resolve(Math.max(0, Math.min(to, size)))
    const start = $from.depth ? $from.before(1) : $from.pos
    let end = $to.depth ? $to.after(1) : $to.pos
    if (end <= start) {
        // A position between blocks: the block after it.
        const after = doc.resolve(start).nodeAfter
        if (!after) return null
        end = start + after.nodeSize
    }
    return { from: start, to: end }
}

/** The line a fold shows: the first words of its first block, and how
 *  many blocks are folded. */
function placeholder(doc: PMNode, fold: Fold, open: () => void): HTMLElement {
    const line = document.createElement('div')
    line.className = 'ezco-mde-fold'
    line.contentEditable = 'false'
    line.dataset.from = String(fold.from)
    line.setAttribute('role', 'button')
    line.title = 'Unfold'
    let blocks = 0
    let first: PMNode | null = null
    doc.nodesBetween(fold.from, fold.to, (node, pos) => {
        if (pos < fold.from || pos >= fold.to) return false
        blocks++
        first ??= node
        return false
    })
    const text = document.createElement('span')
    text.className = 'ezco-mde-fold-text'
    // The first line of text in the fold (a list's first item, not every item run together).
    let firstText: PMNode | null = null
    if (first) {
        const node = first as PMNode
        if (node.isTextblock) firstText = node
        else node.descendants((n) => {
            if (firstText) return false
            if (n.isTextblock) firstText = n
            return !firstText
        })
    }
    const words = (firstText ? (firstText as PMNode).textContent : '').replace(/\s+/g, ' ').trim()
    text.textContent = words || (first ? `(${(first as PMNode).type.name})` : '…')
    const count = document.createElement('span')
    count.className = 'ezco-mde-fold-count'
    count.textContent = `${blocks} ${blocks === 1 ? 'block' : 'blocks'}`
    line.append(text, count)
    line.addEventListener('mousedown', (e) => e.preventDefault())
    line.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        open()
    })
    return line
}

export const Folding = Extension.create({
    name: 'folding',

    addCommands() {
        return {
            foldBlocks:
                (from, to) =>
                ({ state, tr, dispatch }) => {
                    const fold = blockRange(state.doc, from, to)
                    // Nothing to fold, or everything: there would be nowhere to put the caret.
                    if (!fold || (fold.from === 0 && fold.to === state.doc.content.size)) return false
                    if (foldsOf(state).some((f) => f.from < fold.to && fold.from < f.to)) return false
                    if (dispatch) {
                        // The caret out of what is hidden: after it, else before.
                        const { from: sFrom, to: sTo } = state.selection
                        if (sFrom < fold.to && sTo > fold.from) {
                            const $after = tr.doc.resolve(fold.to)
                            const after = $after.nodeAfter ? Selection.near($after, 1) : null
                            tr.setSelection(after ?? Selection.near(tr.doc.resolve(fold.from), -1))
                        }
                        tr.setMeta(foldingKey, { add: fold })
                    }
                    return true
                },
            foldSelection:
                () =>
                ({ state, commands }) =>
                    commands.foldBlocks(state.selection.from, state.selection.to),
            unfold:
                (pos) =>
                ({ state, tr, dispatch }) => {
                    const fold = foldAt(state, pos)
                    if (!fold) return false
                    dispatch?.(tr.setMeta(foldingKey, { remove: fold }))
                    return true
                },
        }
    },

    addProseMirrorPlugins() {
        const editor = this.editor
        return [
            new Plugin<FoldingState>({
                key: foldingKey,
                state: {
                    init: () => ({ folds: [] }),
                    apply(tr: Transaction, value, _old, state) {
                        let folds = value.folds
                        if (tr.docChanged) {
                            folds = folds
                                .map((f) => blockRange(tr.doc, tr.mapping.map(f.from, 1), tr.mapping.map(f.to, -1)))
                                .filter((f): f is Fold => !!f && f.to > f.from)
                        }
                        const meta = tr.getMeta(foldingKey) as { add?: Fold; remove?: Fold } | undefined
                        if (meta?.add) folds = [...folds, meta.add].sort((a, b) => a.from - b.from)
                        if (meta?.remove) folds = folds.filter((f) => f.from !== meta.remove!.from)
                        // The caret in a fold opens it.
                        if (tr.selectionSet || tr.docChanged) {
                            const { from, to } = state.selection
                            folds = folds.filter((f) => !(from < f.to && to > f.from))
                        }
                        return folds === value.folds ? value : { folds }
                    },
                },
                props: {
                    decorations(state) {
                        const { folds } = foldingKey.getState(state) ?? { folds: [] }
                        if (!folds.length) return DecorationSet.empty
                        const decorations: Decoration[] = []
                        for (const fold of folds) {
                            state.doc.nodesBetween(fold.from, fold.to, (node, pos) => {
                                if (pos >= fold.from && pos < fold.to) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'ezco-mde-folded' }))
                                return false
                            })
                            decorations.push(
                                Decoration.widget(fold.from, () => placeholder(state.doc, fold, () => editor.commands.unfold(fold.from)), {
                                    side: -1,
                                    key: `fold:${fold.from}:${fold.to}`,
                                    ignoreSelection: true,
                                }),
                            )
                        }
                        return DecorationSet.create(state.doc, decorations)
                    },
                },
            }),
        ]
    },
})
