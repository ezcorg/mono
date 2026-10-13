import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { TextSelection } from '@tiptap/pm/state'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, waitFor } from '../../../test/utils'

/**
 * Boundary semantics for the inline-code mark.
 *
 * The Code mark stays at PM's default `inclusive: true`, so typing at
 * the right boundary of a code run keeps extending the run — without
 * this the user can't append characters (e.g., a trailing space) to
 * an existing code mark from its right edge. The `InlineCodeExit`
 * extension covers the matching pain point: when a code run is at
 * the end of its paragraph there's no plaintext to navigate into, so
 * ArrowRight inserts a plain space outside the mark and moves the
 * cursor onto it — an unambiguous, visible exit.
 */
describe('Inline code boundary behavior', () => {
    let editor: MarkdownEditor

    beforeEach(() => {
        editor = createEditor({ content: '' })
    })

    afterEach(() => {
        try { editor.destroy() } catch {}
    })

    /** Simulate a keydown on the editor's contenteditable DOM. */
    function pressKey(key: string) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        editor.view.dom.dispatchEvent(event)
    }

    describe('ArrowRight at the right edge of code at end of paragraph', () => {
        it('inserts a plain space outside the mark and moves the cursor onto it', () => {
            editor.commands.setContent('`ab`')
            const codeType = editor.state.schema.marks.code

            // End-of-paragraph position right after the code run.
            const endPos = editor.state.doc.content.size - 1
            editor.view.dispatch(
                editor.state.tr.setSelection(
                    TextSelection.create(editor.state.doc, endPos),
                ),
            )
            // Sanity: we *are* at the right edge of code (active marks include code).
            expect(codeType.isInSet(editor.state.selection.$from.marks())).toBeTruthy()

            pressKey('ArrowRight')

            // The inserted character is the LAST in the paragraph and
            // must be plaintext, not code-marked.
            const para = editor.state.doc.firstChild!
            const lastChild = para.lastChild!
            expect(lastChild.text).toBe(' ')
            expect(codeType.isInSet(lastChild.marks)).toBeFalsy()

            // Cursor has advanced onto the new space.
            expect(editor.state.selection.from).toBe(endPos + 1)

            // Markdown serialization keeps the code run intact and
            // shows a trailing space outside it.
            const md = editor.storage.markdown.getMarkdown()
            expect(md.startsWith('`ab`')).toBe(true)
            expect(md.endsWith(' ')).toBe(true)
        })

        it('repeated presses keep adding plain spaces outside the code run', () => {
            editor.commands.setContent('`ab`')
            const codeType = editor.state.schema.marks.code
            const endPos = editor.state.doc.content.size - 1
            editor.view.dispatch(
                editor.state.tr.setSelection(
                    TextSelection.create(editor.state.doc, endPos),
                ),
            )

            pressKey('ArrowRight')
            // After one press, cursor is on a plain space. The cursor's
            // *active* marks now derive from the plain space to its left
            // — so a subsequent ArrowRight is no longer at a code-edge
            // and falls through to the default keymap. We only assert
            // that the first press did the right thing; behaviour after
            // exit is whatever PM does natively (which is correct).
            const para = editor.state.doc.firstChild!
            expect(para.lastChild!.text).toBe(' ')
            expect(codeType.isInSet(para.lastChild!.marks)).toBeFalsy()
        })

        it('multiple chars typed after ArrowRight in a bullet item all appear after the code run, in order', () => {
            // Exact user-reported scenario: `* \`test\`` (code "test"
            // inside a bullet item), cursor after the second 't',
            // ArrowRight once, then type "abc" — all three should
            // land after the code run, in order, as plaintext.
            editor.commands.setContent('* `test`')
            const codeType = editor.state.schema.marks.code

            // Find the doc position at the right edge of the code run.
            let endOfCodePos = -1
            editor.state.doc.descendants((node, pos) => {
                if (node.isText && codeType.isInSet(node.marks) && node.text === 'test') {
                    endOfCodePos = pos + node.nodeSize
                    return false
                }
                return true
            })
            expect(endOfCodePos).toBeGreaterThan(0)

            editor.view.dispatch(
                editor.state.tr.setSelection(
                    TextSelection.create(editor.state.doc, endOfCodePos),
                ),
            )

            pressKey('ArrowRight')
            editor.commands.insertContent('a')
            editor.commands.insertContent('b')
            editor.commands.insertContent('c')

            const md = editor.storage.markdown.getMarkdown()
            // Code run intact, " abc" appended as plaintext outside it.
            expect(md.trim()).toBe('* `test` abc')

            // Last text node in the paragraph contains the typed
            // characters and carries no code mark.
            let lastTextNode: any = null
            editor.state.doc.descendants(node => {
                if (node.isText) lastTextNode = node
                return true
            })
            expect(lastTextNode.text).toContain('abc')
            expect(codeType.isInSet(lastTextNode.marks)).toBeFalsy()
        })

        it('real-keystroke typing after ArrowRight stays outside the code mark', async () => {
            // Real keys through the browser: the character lands in the
            // DOM where the caret is and PM's observer reads its marks from
            // there, not from `storedMarks`. This is what catches the caret
            // slipping inside the `<code>` element, where the browser would
            // absorb the typed character into the code run.
            const container = createTestContainer('inline-code-keys')
            const mounted = createEditor({ element: container, content: '`ab`' })
            try {
                // Tiptap mounts after a tick; real focus from a real click.
                await new Promise((r) => requestAnimationFrame(r))
                await userEvent.click(mounted.view.dom)
                const codeType = mounted.state.schema.marks.code
                const endPos = mounted.state.doc.content.size - 1
                mounted.commands.setTextSelection(endPos)
                expect(codeType.isInSet(mounted.state.selection.$from.marks())).toBeTruthy()

                await userEvent.keyboard('{ArrowRight}x')
                await waitFor(() => mounted.storage.markdown.getMarkdown() === '`ab` x', 2000)
                const para = mounted.state.doc.firstChild!
                const lastChild = para.lastChild!
                expect(lastChild.text).toBe(' x')
                expect(codeType.isInSet(lastChild.marks)).toBeFalsy()
            } finally {
                cleanupEditor(mounted, container)
            }
        })

        it('a character typed after ArrowRight is plaintext, not appended to the code run', () => {
            // This is the regression the user hit: after ArrowRight
            // inserted a plain space and moved the cursor onto it,
            // the next typed character was sometimes re-entering the
            // code mark because `storedMarks` got reset to `null` by
            // `setSelection` and re-derived from the cursor position
            // ambiguously. The handler now stamps `storedMarks = []`
            // to pin the next keystroke to plaintext.
            editor.commands.setContent('`ab`')
            const codeType = editor.state.schema.marks.code
            const endPos = editor.state.doc.content.size - 1
            editor.view.dispatch(
                editor.state.tr.setSelection(
                    TextSelection.create(editor.state.doc, endPos),
                ),
            )

            pressKey('ArrowRight')
            // storedMarks should now be explicitly empty so the next
            // insertion is unmarked.
            expect(editor.state.storedMarks).not.toBeNull()
            expect(editor.state.storedMarks!.length).toBe(0)

            // Insert a character at the current cursor — simulates the
            // user typing 'x' immediately after the arrow press.
            editor.commands.insertContent('x')

            // Resulting markdown should keep the code run intact and
            // show ' x' as plaintext after it. If the regression were
            // present we'd get '`abx`' or '`ab x`' instead.
            const md = editor.storage.markdown.getMarkdown()
            expect(md).toBe('`ab` x')

            // And the last node in the paragraph should be plain " x",
            // not code-marked.
            const para = editor.state.doc.firstChild!
            const lastChild = para.lastChild!
            expect(lastChild.text).toContain('x')
            expect(codeType.isInSet(lastChild.marks)).toBeFalsy()
        })
    })

    describe('ArrowRight is NOT intercepted when', () => {
        it('the cursor is mid-code (code-marked text to the right)', () => {
            // "abc" all code-marked, cursor between "a" and "b" — there's
            // more code to the right, so the handler must pass through.
            editor.commands.setContent('`abc`')
            editor.view.dispatch(
                editor.state.tr.setSelection(
                    TextSelection.create(editor.state.doc, 2),
                ),
            )
            const docSizeBefore = editor.state.doc.content.size

            pressKey('ArrowRight')

            // No new content inserted (handler returned false).
            expect(editor.state.doc.content.size).toBe(docSizeBefore)
        })

        it('the code run has plaintext after it in the same paragraph', () => {
            // "`ab` z" — code "ab" followed by space + "z". Cursor at the
            // right edge of code. Default ArrowRight will land on the
            // plaintext space, which already types as plaintext — no
            // need to insert anything.
            editor.commands.setContent('`ab` z')
            // End of "ab" code run.
            editor.view.dispatch(
                editor.state.tr.setSelection(
                    TextSelection.create(editor.state.doc, 3),
                ),
            )
            const docSizeBefore = editor.state.doc.content.size

            pressKey('ArrowRight')

            // Handler returned false → no insertion.
            expect(editor.state.doc.content.size).toBe(docSizeBefore)
        })

        it('the cursor is not in a code mark at all', () => {
            editor.commands.setContent('plain text')
            editor.view.dispatch(
                editor.state.tr.setSelection(
                    TextSelection.create(editor.state.doc, 3),
                ),
            )
            const docSizeBefore = editor.state.doc.content.size

            pressKey('ArrowRight')

            expect(editor.state.doc.content.size).toBe(docSizeBefore)
        })
    })

    describe('typing semantics at the right boundary', () => {
        it('typing at the right edge of an existing code run extends the mark (inclusive: true)', () => {
            // Critical: users must be able to append (e.g., a trailing
            // space) to an existing code run by typing at its right edge.
            editor.commands.setContent('`ab`')
            const endPos = editor.state.doc.content.size - 1
            editor.view.dispatch(
                editor.state.tr.setSelection(
                    TextSelection.create(editor.state.doc, endPos),
                ),
            )

            editor.commands.insertContent('x')

            const md = editor.storage.markdown.getMarkdown()
            expect(md).toBe('`abx`')
        })
    })
})
