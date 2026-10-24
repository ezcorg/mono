import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { toggleMark } from '@tiptap/pm/commands'

/**
 * Smart "wrap the selection" on punctuation.
 *
 * With a non-empty prose selection, typing a wrapping character surrounds the
 * selected text instead of replacing it:
 *  - `` ` `` → toggles the inline-`code` mark on the selection (so it round-trips
 *    to markdown as `` `text` ``). Pressing it again on an already-code run
 *    removes the mark.
 *  - `[` → encloses the selection in literal brackets, `[text]`, and re-selects
 *    the inner text so it can be wrapped/edited further.
 *
 * With the caret alone, a backtick typed *before* text that a lone backtick
 * already follows closes the pair the other way round: the text between
 * becomes inline code and both backticks go (Tiptap's own input rule only
 * knows the pair typed in order, the closing one last). The caret stays
 * where the backtick was typed, before the code.
 *
 * Implemented via `handleTextInput`, the standard hook for transforming typed
 * input: it receives the resolved character (layout / dead-key independent) and
 * the range being replaced, and returning `true` preempts both the default
 * insertion and the markdown input rules. Embedded codeblocks consume their own
 * key events (`stopEvent`), so code editing is unaffected.
 */
export const WrapSelection = Extension.create({
    name: 'wrapSelection',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('wrapSelection'),
                props: {
                    handleTextInput(view, from, to, text) {
                        if (from === to) return text === '`' && closeCodeBackwards(view, from)

                        if (text === '`') {
                            const code = view.state.schema.marks.code
                            if (!code) return false
                            // toggleMark acts on the current selection, which
                            // (at text-input time) is exactly [from, to].
                            return toggleMark(code)(view.state, view.dispatch)
                        }

                        if (text === '[') {
                            const tr = view.state.tr
                            // Insert the closing bracket first so `from` stays a
                            // valid, unshifted position for the opening one.
                            tr.insertText(']', to)
                            tr.insertText('[', from)
                            // Keep the original text selected, now between the
                            // brackets.
                            tr.setSelection(TextSelection.create(tr.doc, from + 1, to + 1))
                            view.dispatch(tr.scrollIntoView())
                            return true
                        }

                        return false
                    },
                },
            }),
        ]
    },
})

/** A leaf that is not text, in a textblock's text as read here. */
const LEAF = '￼'

/**
 * A backtick typed at `pos` with a lone backtick later in the same textblock
 * (and an even number before, so this one opens a pair): the text between
 * made inline code, the later backtick removed, the caret left at `pos`.
 */
function closeCodeBackwards(view: import('@tiptap/pm/view').EditorView, pos: number): boolean {
    const { state } = view
    const code = state.schema.marks.code
    if (!code) return false
    const $pos = state.doc.resolve(pos)
    const parent = $pos.parent
    if (!parent.isTextblock || parent.type.spec.code || !parent.type.allowsMarkType(code)) return false
    const before = parent.textBetween(0, $pos.parentOffset, undefined, LEAF)
    // An odd number of backticks before: this one closes a pair the usual
    // way round, which the code input rule handles.
    if ((before.match(/`/g)?.length ?? 0) % 2) return false
    const after = parent.textBetween($pos.parentOffset, parent.content.size, undefined, LEAF)
    const at = after.indexOf('`')
    if (at < 1) return false
    const inside = after.slice(0, at)
    if (!inside.trim() || inside.includes(LEAF)) return false
    const close = pos + at
    const tr = state.tr.delete(close, close + 1).addMark(pos, close, code.create())
    tr.setSelection(TextSelection.create(tr.doc, pos)).setStoredMarks([])
    view.dispatch(tr.scrollIntoView())
    return true
}
