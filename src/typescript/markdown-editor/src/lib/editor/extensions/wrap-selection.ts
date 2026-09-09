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
                        // Only act on a real (non-collapsed) selection; a
                        // collapsed caret falls through to normal typing /
                        // input rules.
                        if (from === to) return false

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
