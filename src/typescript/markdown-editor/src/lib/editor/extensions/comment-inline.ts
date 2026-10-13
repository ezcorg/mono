/**
 * A comment opened within the note (`comments.inline`, the default where
 * nothing beside the note shows the comments): its card stands in the
 * note's flow under the text it is about, as a widget after that text's
 * block, so what follows moves down and nothing is covered. The margin
 * (comment-margin.ts) makes the card and puts it in the box this plugin
 * draws for it; the box is the same element across redraws (keyed), so
 * the card stays in it, and the margin takes it in and out with the mark
 * it came from in view.
 */
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { commentsKey } from './comments'

export const inlineKey = new PluginKey<DecorationSet>('commentInline')

/** The margin's side of it, on `editor.storage.commentMargin`. */
export interface InlineHost {
    /** Whether open comments stand within the note now. */
    inline(): boolean
    /** The box for comment `id`: the same element each time. */
    inlineBox(id: string): HTMLElement
}

function host(editor: Editor): InlineHost | null {
    const m = (editor.storage as Record<string, any>).commentMargin as Partial<InlineHost> | undefined
    return m && typeof m.inline === 'function' && typeof m.inlineBox === 'function' ? (m as InlineHost) : null
}

function decorate(editor: Editor, state: EditorState): DecorationSet {
    const h = host(editor)
    const comments = commentsKey.getState(state)
    if (!h || !comments || !h.inline()) return DecorationSet.empty
    const decorations: Decoration[] = []
    for (const id of comments.open) {
        const c = comments.comments.find((x) => x.id === id)
        const range = c?.target.range
        if (!c || !range || c.target.whole) continue
        // After the block the text ends in (in a list item, after its paragraph).
        const $to = state.doc.resolve(Math.min(range.to, state.doc.content.size))
        if ($to.depth < 1) continue
        decorations.push(
            Decoration.widget($to.after($to.depth), () => h.inlineBox(id), {
                key: `comment-inline:${id}`,
                side: 1,
                stopEvent: () => true,
                ignoreSelection: true,
            }),
        )
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
