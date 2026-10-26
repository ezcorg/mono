/**
 * Folding: a block, or the blocks a selection spans, folded as a code
 * editor folds a function. The first block (the fold's head) stays, cut to
 * its first line, with an ellipsis at the line's end; the rest is hidden.
 * The gutter (block-actions.ts) marks the head with a chevron. The ellipsis
 * and the chevron open the fold again. A heading folds its section: itself
 * and what follows up to the next heading of its level or above.
 *
 * What is folded is only hidden, in the view: the note is written whole,
 * and a fold is forgotten when the note is closed. The head stays the
 * note's: the caret in it edits it, as a fold's first line is edited in a
 * code editor. The caret moving into what is hidden (arrowing down into it,
 * say) opens the fold.
 *
 * The ellipsis is a widget between the head and what follows, placed by
 * script at the end of the head's first line (`FoldMarks`): the line's end
 * is only known once the text is laid out, and a mark inside the head
 * would be cut off with the head's second line.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, Selection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { button, el, labelled, pressable } from '../ui/dom'
import { observeResize, rafThrottle } from '../ui/layout'
import { CODE_BLOCK, codeRunAt } from './code-runs'

export interface Fold {
    /** The start of the first folded block (the head) and the end of the last. */
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
            /** Fold the top-level blocks between `from` and `to` behind the first. */
            foldBlocks: (from: number, to: number) => ReturnType
            /** Fold the blocks the selection spans (the caret's block alone). */
            foldSelection: () => ReturnType
            /** Fold the block at `pos`: a heading with its section. */
            foldBlock: (pos: number) => ReturnType
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

/** Where a fold's head (its first block) ends: what follows, to `to`, is hidden. */
export function foldHeadEnd(doc: PMNode, fold: Fold): number {
    const head = doc.nodeAt(fold.from)
    return head ? Math.min(fold.from + head.nodeSize, fold.to) : fold.to
}

/** What "Fold" folds for the top-level block at `pos`: a heading with its
 *  section (to the next heading of its level or above, else the end of the
 *  note); a code block with the group it stands in (code-runs.ts); any
 *  other block, itself. */
export function foldRangeFor(doc: PMNode, pos: number): Fold | null {
    const node = doc.nodeAt(pos)
    if (!node) return null
    if (node.type.name === CODE_BLOCK) {
        const run = codeRunAt(doc, pos)
        if (run) return { from: run.from, to: run.to }
    }
    let to = pos + node.nodeSize
    if (node.type.name === 'heading') {
        const level = (node.attrs as { level?: number }).level ?? 1
        to = doc.content.size
        doc.forEach((child, offset) => {
            if (offset <= pos || to !== doc.content.size) return
            if (child.type.name === 'heading' && ((child.attrs as { level?: number }).level ?? 1) <= level) to = offset
        })
    }
    return { from: pos, to }
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

/** How many blocks `fold` hides (those after its head). */
function hiddenBlocks(doc: PMNode, fold: Fold): number {
    let blocks = 0
    doc.nodesBetween(foldHeadEnd(doc, fold), fold.to, (_node, pos) => {
        if (pos >= fold.from && pos < fold.to) blocks++
        return false
    })
    return blocks
}

/** The ellipsis after a fold's first line, which opens the fold. */
function mark(doc: PMNode, fold: Fold, open: () => void): HTMLElement {
    const wrap = el('span', 'ezco-mde-fold-mark')
    wrap.contentEditable = 'false'
    wrap.dataset.from = String(fold.from)
    const hidden = hiddenBlocks(doc, fold)
    const ellipsis = button('ezco-mde-fold-ellipsis', '⋯')
    labelled(ellipsis, hidden ? `Unfold: ${hidden} ${hidden === 1 ? 'block' : 'blocks'} hidden` : 'Unfold')
    pressable(ellipsis, (_b, e) => {
        e.preventDefault()
        e.stopPropagation()
        open()
    })
    wrap.append(ellipsis)
    return wrap
}

/** Where the first line of `head` ends: the right edge of the last text on
 *  it, and the line's top and bottom. For a code block, whose first line
 *  is its toolbar, the toolbar's right end. Null for a block without text. */
function firstLineEnd(head: HTMLElement): { right: number; top: number; bottom: number; alignRight: boolean } | null {
    if (head.matches('.cm-editor')) {
        const bar = head.querySelector<HTMLElement>('.cm-toolbar-panel') ?? head
        const r = bar.getBoundingClientRect()
        return { right: r.right - 10, top: r.top, bottom: r.bottom, alignRight: true }
    }
    const walker = document.createTreeWalker(head, NodeFilter.SHOW_TEXT)
    const range = document.createRange()
    let line: { right: number; top: number; bottom: number; alignRight: boolean } | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        range.selectNodeContents(node)
        for (const rect of range.getClientRects()) {
            if (!rect.width && !rect.height) continue
            if (!line) line = { right: rect.right, top: rect.top, bottom: rect.bottom, alignRight: false }
            else if (rect.top < line.bottom - 1) {
                // On the first line still (overlapping it in height).
                line.right = Math.max(line.right, rect.right)
                line.top = Math.min(line.top, rect.top)
                line.bottom = Math.max(line.bottom, rect.bottom)
            } else return line
        }
    }
    return line
}

/** Places each fold's ellipsis at the end of its head's first line, again
 *  whenever the view updates or changes size (and once the fonts are in,
 *  which moves every line's end). */
class FoldMarks {
    private readonly pass = rafThrottle(() => this.place())
    private readonly unobserve: () => void
    private readonly onFonts = () => this.pass.schedule()

    constructor(private readonly view: EditorView) {
        this.unobserve = observeResize(view.dom, () => this.pass.schedule())
        document.fonts?.addEventListener('loadingdone', this.onFonts)
        this.pass.schedule()
    }

    update() {
        this.pass.schedule()
    }

    destroy() {
        this.pass.cancel()
        this.unobserve()
        document.fonts?.removeEventListener('loadingdone', this.onFonts)
    }

    private place() {
        if (!this.view.dom.isConnected) return
        for (const wrap of this.view.dom.querySelectorAll<HTMLElement>('.ezco-mde-fold-mark')) {
            const head = this.view.nodeDOM(Number(wrap.dataset.from)) as HTMLElement | null
            if (!head || typeof head.getBoundingClientRect !== 'function') continue
            // Against whatever the mark is positioned in (the note, or a
            // scroller around it), scrolled as it is.
            const parent = (wrap.offsetParent as HTMLElement | null) ?? this.view.dom
            const origin = parent.getBoundingClientRect()
            const headRect = head.getBoundingClientRect()
            const line = firstLineEnd(head)
            const top = (line?.top ?? headRect.top) - origin.top + parent.scrollTop
            const height = line ? line.bottom - line.top : Math.min(headRect.height, 28)
            const width = wrap.offsetWidth
            let left = (line?.right ?? headRect.left) - origin.left + parent.scrollLeft
            if (line?.alignRight) left -= width
            // Never past the block's right edge: a line that runs the full
            // measure has the mark over its last word rather than outside the note.
            const rightmost = headRect.right - origin.left + parent.scrollLeft - width
            if (left > rightmost) left = Math.max(headRect.left - origin.left + parent.scrollLeft, rightmost)
            const style = { top: `${top.toFixed(2)}px`, left: `${left.toFixed(2)}px`, height: `${height.toFixed(2)}px` }
            for (const [key, value] of Object.entries(style)) if (wrap.style.getPropertyValue(key) !== value) wrap.style.setProperty(key, value)
        }
    }
}

export const Folding = Extension.create({
    name: 'folding',

    addCommands() {
        return {
            foldBlocks:
                (from, to) =>
                ({ state, tr, dispatch }) => {
                    const fold = blockRange(state.doc, from, to)
                    if (!fold) return false
                    if (foldsOf(state).some((f) => f.from < fold.to && fold.from < f.to)) return false
                    if (dispatch) {
                        // The caret out of what is hidden: after it, else into the head.
                        const hidden = foldHeadEnd(state.doc, fold)
                        const { from: sFrom, to: sTo } = state.selection
                        if (sFrom < fold.to && sTo > hidden) {
                            const $after = tr.doc.resolve(fold.to)
                            const after = $after.nodeAfter ? Selection.near($after, 1) : null
                            tr.setSelection(after ?? Selection.near(tr.doc.resolve(fold.from), 1))
                        }
                        tr.setMeta(foldingKey, { add: fold })
                    }
                    return true
                },
            foldSelection:
                () =>
                ({ state, commands }) =>
                    commands.foldBlocks(state.selection.from, state.selection.to),
            foldBlock:
                (pos) =>
                ({ state, commands }) => {
                    const range = foldRangeFor(state.doc, pos)
                    return !!range && commands.foldBlocks(range.from, range.to)
                },
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
                        // The caret in what a fold hides opens it (the head is
                        // the note's own: the caret there is left alone).
                        if (tr.selectionSet || tr.docChanged) {
                            const { from, to } = state.selection
                            folds = folds.filter((f) => !(from < f.to && to > foldHeadEnd(state.doc, f)))
                        }
                        return folds === value.folds ? value : { folds }
                    },
                },
                view: (view) => new FoldMarks(view),
                props: {
                    decorations(state) {
                        const { folds } = foldingKey.getState(state) ?? { folds: [] }
                        if (!folds.length) return DecorationSet.empty
                        const decorations: Decoration[] = []
                        for (const fold of folds) {
                            const headEnd = foldHeadEnd(state.doc, fold)
                            state.doc.nodesBetween(fold.from, fold.to, (node, pos) => {
                                if (pos >= fold.from && pos < fold.to) {
                                    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: pos === fold.from ? 'ezco-mde-fold-head' : 'ezco-mde-folded' }))
                                }
                                return false
                            })
                            decorations.push(
                                Decoration.widget(headEnd, () => mark(state.doc, fold, () => editor.commands.unfold(fold.from)), {
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
