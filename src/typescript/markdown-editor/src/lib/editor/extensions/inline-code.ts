import { Extension } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'

/**
 * ArrowRight at the right edge of an inline-code mark at the end of
 * its paragraph inserts a plain space outside the code run and moves
 * the cursor onto it.
 *
 * Why: the Code mark is left at PM's default `inclusive: true` so the
 * user can extend a code run by typing at its right edge (e.g.,
 * append a trailing space *inside* the run). The flip side is that
 * the cursor's "side" at the right boundary is logically still inside
 * the mark, and when the code run is the last thing in the paragraph
 * there's no plaintext to navigate into — a single ArrowRight either
 * does nothing visible (still "in code") or skips to the next block.
 * Inserting a plain space gives the user an unambiguous, visible
 * landing spot outside the code mark on every press.
 *
 * Cases that *don't* trigger this behavior:
 *  - Cursor mid-code (a code-marked character sits to its right):
 *    plain navigation through the mark is correct.
 *  - Cursor at the right edge of code but with plaintext after it in
 *    the same paragraph: default ArrowRight already lands the cursor
 *    on the plaintext character, which carries no code mark.
 *  - Cursor not at a code-mark boundary at all.
 */
export const InlineCodeExit = Extension.create({
    name: 'inlineCodeExit',

    addKeyboardShortcuts() {
        return {
            ArrowRight: ({ editor }) => {
                const { state } = editor
                const codeType = state.schema.marks.code
                if (!codeType) return false

                const { $from, empty } = state.selection
                if (!empty) return false

                // Right boundary of a code run: marks at cursor include
                // `code`, but the character to the right is NOT code-marked
                // (i.e., we're at the mark's outer edge, not mid-run).
                const insideCode = codeType.isInSet($from.marks())
                if (!insideCode) return false
                const after = $from.nodeAfter
                if (after && codeType.isInSet(after.marks)) return false

                // Only intervene when the code run is at the *end of the
                // paragraph* — otherwise the default keymap will land
                // the cursor on the next plaintext character, which is
                // already outside the code mark and types plaintext.
                if ($from.parentOffset !== $from.parent.content.size) return false

                // Insert a plain (un-marked) text node, move the cursor
                // onto it, then explicitly drop the `code` mark from
                // `storedMarks`. Using `tr.insert(pos, schema.text(' '))`
                // (with no marks on the text node) is critical — TipTap's
                // `insertContentAt` runs the inserted text through a
                // content-merging step that *absorbs* it into the
                // adjacent code-marked text node, so the space ends up
                // inside the run and the bug actually gets WORSE.
                //
                // The `setStoredMarks([])` covers a separate failure
                // mode: PM's `setSelection` resets stored marks to null,
                // which makes the next keystroke derive its marks from
                // the cursor's position. Pinning them to an explicit
                // empty array makes the next *programmatic* insertion
                // (e.g., the `insertContent` calls in our tests) unmarked
                // regardless of the resolved-position derivation.
                //
                // NOTE: real keystrokes don't go through
                // `tr.insertText` — PM's DOM observer reads the marks
                // straight from the inserted DOM node. That's why the
                // CSS rule in `styles.ts` (forcing trailing whitespace
                // to render under `white-space: break-spaces`) is also
                // load-bearing for real-browser typing: it keeps the
                // visible caret unambiguously outside the `<code>`
                // element so the browser doesn't accidentally extend
                // the code element with the typed character.
                const pos = $from.pos
                const tr = state.tr.insert(pos, state.schema.text(' '))
                tr.setSelection(TextSelection.create(tr.doc, pos + 1))
                tr.setStoredMarks([])
                editor.view.dispatch(tr.scrollIntoView())
                return true
            },
        }
    },
})
