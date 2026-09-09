import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { MarkdownEditor } from '../index'
import { createTestContainer, createTestEditor, cleanupEditor, waitFor } from '../../../test/utils'

/**
 * The emoji dataset is aliased to a small local fixture during tests (see
 * vitest.config.ts) — the real `emojibase-data` package is ~550KB and, being a
 * lazily dynamically-imported node_modules dep, would otherwise trip Vite's
 * browser-mode optimizer into a mid-run reload. The fixture mirrors the dataset
 * shape so the picker behaves identically.
 */
describe('Emoji picker', () => {
    let container: HTMLElement
    let editor: MarkdownEditor

    beforeEach(async () => {
        container = createTestContainer()
        editor = await createTestEditor(container)
    })

    afterEach(() => {
        cleanupEditor(editor, container)
    })

    const cells = () => Array.from(document.querySelectorAll('.ezco-mde-emoji-cell')) as HTMLElement[]
    const footerName = () => document.querySelector('.ezco-mde-emoji-footer-name')?.textContent ?? ''

    /** Type `:<query>` at the end of the doc via real keystrokes. The leading
     *  space guarantees the colon starts a word (a trigger boundary), and the
     *  genuine `:` keydown is what arms the picker. */
    async function typeColonQuery(query: string) {
        await userEvent.click(editor.view.dom)
        editor.commands.focus('end')
        await userEvent.keyboard(` :${query}`)
    }

    it('opens a searchable grid when ":" is followed by 2+ characters', async () => {
        await typeColonQuery('smi')
        await waitFor(() => cells().length > 0, 4000)
        // "smi" matches the smile-family entries in the fixture.
        expect(cells().length).toBeGreaterThanOrEqual(3)
        expect(footerName().length).toBeGreaterThan(0)
    })

    it('does not open for a single character after ":" (minChars = 2)', async () => {
        await typeColonQuery('s')
        await new Promise((r) => setTimeout(r, 300))
        expect(cells().length).toBe(0)
    })

    it('does not open when the colon is mid-word (not a boundary)', async () => {
        await userEvent.click(editor.view.dom)
        editor.commands.focus('end')
        // No leading space → the colon follows a word char (like `http://`).
        await userEvent.keyboard('abc:smi')
        await new Promise((r) => setTimeout(r, 300))
        expect(cells().length).toBe(0)
    })

    it('moves the focused emoji with arrow keys', async () => {
        await typeColonQuery('smi')
        await waitFor(() => cells().length > 0, 4000)
        const first = footerName()
        await userEvent.keyboard('{ArrowRight}')
        await waitFor(() => footerName() !== first, 2000)
        expect(footerName()).not.toBe(first)
    })

    it('inserts the focused emoji in place of the ":query"', async () => {
        await typeColonQuery('smi')
        await waitFor(() => cells().length > 0, 4000)
        const chosen = cells()[0].textContent ?? ''
        expect(chosen.length).toBeGreaterThan(0)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => !editor.state.doc.textContent.includes(':smi'), 2000)
        const text = editor.state.doc.textContent
        expect(text).not.toContain(':smi')
        expect(text).toContain(chosen)
        // The grid closes after a selection.
        expect(cells().length).toBe(0)
    })

    it('closes on Escape without inserting anything', async () => {
        await typeColonQuery('smi')
        await waitFor(() => cells().length > 0, 4000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => cells().length === 0, 2000)
        // The literal ":smi" stays in the doc since nothing was selected.
        expect(editor.state.doc.textContent).toContain(':smi')
    })
})
