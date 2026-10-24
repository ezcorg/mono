/**
 * A comment opened within the note (`comments.inline`, the default where
 * nothing beside the note shows the comments): its card stands beside the
 * text it is about, that text's block narrowed into a column with the
 * card in the other (`comments.beside`, the default), or, where the block
 * cannot be narrowed (code, a table's cell) or the reader asked, under the
 * block in the note's flow; either way what is there moves aside and
 * nothing is covered. The margin (comment-margin.ts) makes the card and
 * puts it in the box this plugin draws for it: beside, a widget at the
 * block's start, the block classed `ezco-mde-beside` (the margin measures
 * the card and gives the block its right padding and height, through the
 * decoration: set on the block itself they would be a change for the view
 * to read, and it would draw the block again); under, a widget after the
 * block. The box is the same element across redraws (keyed), so
 * the card stays in it, and the margin takes it in and out from under the
 * mark it came from.
 */
import { Extension, type Editor } from '@tiptap/core'
import type { ResolvedPos } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { commentsKey } from './comments'

export const inlineKey = new PluginKey<DecorationSet>('commentInline')

/** The margin's side of it, on `editor.storage.commentMargin`. */
export interface InlineHost {
    /** Whether open comments stand within the note now. */
    inline(): boolean
    /** Whether a comment stands beside its text (its block narrowed into
     *  a column) rather than under its block. */
    beside(): boolean
    /** The box for comment `id`: the same element each time. */
    inlineBox(id: string): HTMLElement
    /** The style of the block at `block` as a row (its column's padding,
     *  the height that holds its cards), the row known by `key`: the first
     *  of its comments. */
    rowStyle(block: number, key: string): string
}

function host(editor: Editor): InlineHost | null {
    const m = (editor.storage as Record<string, any>).commentMargin as Partial<InlineHost> | undefined
    return m && typeof m.inline === 'function' && typeof m.inlineBox === 'function' ? (m as InlineHost) : null
}

/** Whether the textblock at `$pos` can be narrowed into a column with a
 *  card beside it: a paragraph or heading, not code, and not in a table
 *  (whose cell is a column already). */
export function besideable($pos: ResolvedPos): boolean {
    const block = $pos.parent
    if (!block.isTextblock || block.type.spec.code || !['paragraph', 'heading'].includes(block.type.name)) return false
    for (let d = $pos.depth - 1; d > 0; d--) if ($pos.node(d).type.spec.tableRole) return false
    return true
}

function decorate(editor: Editor, state: EditorState): DecorationSet {
    const h = host(editor)
    const comments = commentsKey.getState(state)
    if (!h || !comments || !h.inline()) return DecorationSet.empty
    const beside = h.beside()
    const size = state.doc.content.size
    const decorations: Decoration[] = []
    const rows = new Map<number, { end: number; cards: { id: string; from: number }[] }>()
    const box = (pos: number, id: string, side: -1 | 1) =>
        Decoration.widget(pos, () => h.inlineBox(id), { key: `comment-inline:${id}`, side, stopEvent: () => true, ignoreSelection: true })
    for (const id of comments.open) {
        const c = comments.comments.find((x) => x.id === id)
        const range = c?.target.range
        if (!c || !range || c.target.whole) continue
        if (beside) {
            // Beside: at the start of the block the text starts in, which is a row.
            const $from = state.doc.resolve(Math.min(range.from, size))
            if ($from.depth >= 1 && besideable($from)) {
                const block = $from.before($from.depth)
                let row = rows.get(block)
                if (!row) rows.set(block, (row = { end: $from.after($from.depth), cards: [] }))
                row.cards.push({ id, from: range.from })
                continue
            }
        }
        // Under: after the block the text ends in (in a list item, after its paragraph).
        const $to = state.doc.resolve(Math.min(range.to, size))
        if ($to.depth < 1) continue
        decorations.push(box($to.after($to.depth), id, 1))
    }
    for (const [block, { end, cards }] of rows) {
        cards.sort((a, b) => a.from - b.from)
        decorations.push(Decoration.node(block, end, { class: 'ezco-mde-beside', style: h.rowStyle(block, cards[0].id) }))
        for (const { id } of cards) decorations.push(box(block + 1, id, -1))
    }
    return DecorationSet.create(state.doc, decorations)
}

export const CommentInline = Extension.create({
    name: 'commentInline',

    // After the comments plugin in the state's order (Tiptap puts a later
    // extension of the same priority first): a transaction's new comments
    // state is in by the time this plugin reads it.
    priority: 90,

    addProseMirrorPlugins() {
        const editor = this.editor
        return [
            new Plugin<DecorationSet>({
                key: inlineKey,
                state: {
                    init: (_, state) => decorate(editor, state),
                    apply(tr, old, before, state) {
                        if (!tr.docChanged && !tr.getMeta(inlineKey) && commentsKey.getState(state) === commentsKey.getState(before)) return old
                        return decorate(editor, state)
                    },
                },
                props: { decorations: (state) => inlineKey.getState(state) },
            }),
        ]
    },
})
