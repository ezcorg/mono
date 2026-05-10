import { Extension } from '@tiptap/core'

/**
 * Releases the cursor from an inline `code` mark when the user navigates past
 * its boundary. StarterKit's Code mark keeps `code` in stored marks even after
 * ArrowRight has moved the cursor outside the run, so the next keystroke keeps
 * the inline-code styling.
 */
export const InlineCodeExit = Extension.create({
    name: 'inlineCodeExit',

    addKeyboardShortcuts() {
        const dropStoredCodeMark = () => {
            const { editor } = this
            const { state } = editor
            const codeType = state.schema.marks.code
            if (!codeType) return false

            const { $from, empty } = state.selection
            if (!empty) return false

            const isInCode = codeType.isInSet($from.marks())
            const stored = state.storedMarks ?? $from.marks()
            const hasStored = codeType.isInSet(stored)
            if (!isInCode && !hasStored) return false

            const after = $from.nodeAfter
            const atMarkEnd = !after || !codeType.isInSet(after.marks)
            if (!atMarkEnd) return false

            editor.view.dispatch(state.tr.removeStoredMark(codeType))
            return false
        }

        return {
            ArrowRight: dropStoredCodeMark,
            End: dropStoredCodeMark,
        }
    },
})
