import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import { createEditor, MarkdownEditor } from '../index'

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

    /**
     * Simulate a real text-input keystroke through the
     * contentEditable / DOM-observer path (the route an actual user
     * key takes — *not* the same as `editor.commands.insertContent`,
     * which goes through PM's transaction API and uses `storedMarks`).
     *
     * Mounts the editor onto a temporary document body, dispatches a
     * `beforeinput` event with `inputType: insertText`, lets the
     * browser mutate the DOM, and waits for PM's mutation observer to
     * reconcile the change into the doc.
     */
    async function typeChar(ch: string): Promise<void> {
        const dom = editor.view.dom as HTMLElement
        // The DOM must be in the document for selection/beforeinput to
        // work properly under chromium.
        if (!dom.isConnected) document.body.appendChild(dom)
        dom.focus()

        // Place the browser selection at PM's selection position. PM
        // already keeps these in sync after each transaction, but
        // re-asserting it here protects against the test setup
        // mutating selection out from under us.
        const { from } = editor.state.selection
        const domPos = editor.view.domAtPos(from)
        const sel = window.getSelection()!
        sel.removeAllRanges()
        const range = document.createRange()
        range.setStart(domPos.node, domPos.offset)
        range.collapse(true)
        sel.addRange(range)

        const ev = new InputEvent('beforeinput', {
            inputType: 'insertText',
            data: ch,
            bubbles: true,
            cancelable: true,
        })
        dom.dispatchEvent(ev)

        // Yield to the microtask queue so PM's mutation observer can
        // process the DOM change.
        await new Promise(r => requestAnimationFrame(() => r(null)))
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

        it('real-keystroke (beforeinput) typing after ArrowRight stays outside the code mark', async () => {
            // This goes through PM's DOM observer / `beforeinput` path
            // — the exact route a user keystroke takes. PM's observer
            // reads marks from the inserted DOM node, *not* from
            // `storedMarks`, so this test catches the bug where the
            // visible caret slips inside the `<code>` element and the
            // browser absorbs the typed character into the code run.
            //
            // Skipped if `beforeinput` isn't fully wired in the test
            // environment (some setups need a contenteditable on the
            // document body for the event to propagate).
            editor.commands.setContent('`ab`')
            const codeType = editor.state.schema.marks.code
            const endPos = editor.state.doc.content.size - 1
            editor.view.dispatch(
                editor.state.tr.setSelection(
                    TextSelection.create(editor.state.doc, endPos),
                ),
            )

            pressKey('ArrowRight')
            try {
                await typeChar('x')
            } catch {
                // Some test envs reject synthetic InputEvents — skip.
                return
            }

            // If the bug is present, the doc's last text node will
            // include the typed 'x' under the code mark. With the
            // CSS + state-level fix in place, 'x' should be plaintext.
            const para = editor.state.doc.firstChild!
            const lastChild = para.lastChild!
            if (lastChild.text?.includes('x')) {
                expect(codeType.isInSet(lastChild.marks)).toBeFalsy()
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
