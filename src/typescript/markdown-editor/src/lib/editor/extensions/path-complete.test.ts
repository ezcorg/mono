import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { memoryVfs } from '@joinezco/storage'
import { completions, resolveDir } from './path-complete'
import { getMarkdownContent, trackEditors, waitFor } from '../../../test/utils'

/**
 * Paths completed as they are typed: after a backtick (inline code naming
 * a file) and as a link's destination, from the vault's files, the menu
 * drawn as the toolbar's browser is; what each choice leaves in the note.
 */
const { openVault } = trackEditors()

const FILES = {
    'notes/a.md': '# A',
    'notes/sub/b.md': '# B',
    'notes/sub/deeper/c.md': '# C',
    'notes/.hidden.md': 'hidden',
    'src/lib.ts': 'export const x = 1',
    'src/main.ts': 'export const y = 2',
    'README.md': '# Read me',
}

const menu = () => document.querySelector<HTMLElement>('.ezco-mde-path-menu')
const titles = () => [...document.querySelectorAll<HTMLElement>('.ezco-mde-path-menu .ezco-mde-slash-item-title')].map((t) => t.textContent)

describe('Where a typed path leads', () => {
    it('resolves `/` and `~/` to the vault’s root, `./` to the note’s folder, `../` to its parent', () => {
        expect(resolveDir('/', [])).toBe('/')
        expect(resolveDir('~/', ['notes'])).toBe('/')
        expect(resolveDir('/src/', ['notes'])).toBe('src')
        expect(resolveDir('./', ['notes'])).toBe('notes')
        expect(resolveDir('./sub/', ['notes'])).toBe('notes/sub')
        expect(resolveDir('../', ['notes', 'sub'])).toBe('notes')
        expect(resolveDir('../src/', ['notes'])).toBe('src')
        expect(resolveDir('./', [])).toBe('/')
        // A bare name: from the note's folder.
        expect(resolveDir('sub/', ['notes'])).toBe('notes/sub')
        expect(resolveDir('', ['notes'])).toBe('notes')
        // Above the root there is nothing.
        expect(resolveDir('../', [])).toBeNull()
        expect(resolveDir('../../', ['notes'])).toBeNull()
    })

    it('looks a bare name up in the note’s folder, and in the root when the folder has nothing of it', async () => {
        const fs = memoryVfs(FILES)
        expect((await completions(fs, 'sub', ['notes'])).map((c) => c.path)).toEqual(['sub/'])
        expect((await completions(fs, 'sub/b', ['notes'])).map((c) => c.path)).toEqual(['sub/b.md'])
        expect((await completions(fs, 'src', ['notes'])).map((c) => c.path)).toEqual(['src/'])
        expect((await completions(fs, 'src/ma', ['notes'])).map((c) => c.path)).toEqual(['src/main.ts'])
        expect((await completions(fs, 'REA', ['notes', 'sub'])).map((c) => c.path)).toEqual(['README.md'])
        expect(await completions(fs, 'xyz', ['notes'])).toEqual([])
    })

    it('lists the entries whose names start with what was typed, folders first, hidden ones only when asked for', async () => {
        const fs = memoryVfs(FILES)
        expect(await completions(fs, './s', ['notes'])).toEqual([{ name: 'sub/', directory: true, path: './sub/' }])
        expect((await completions(fs, '/', [])).map((c) => c.name)).toEqual(['notes/', 'src/', 'README.md'])
        expect((await completions(fs, '~/sr', [])).map((c) => c.path)).toEqual(['~/src/'])
        expect((await completions(fs, '../src/', ['notes'])).map((c) => c.path)).toEqual(['../src/lib.ts', '../src/main.ts'])
        expect((await completions(fs, './', ['notes'])).map((c) => c.name)).toEqual(['sub/', 'a.md'])
        expect((await completions(fs, './.h', ['notes'])).map((c) => c.name)).toEqual(['.hidden.md'])
        // Case does not matter; a folder that is not there has nothing.
        expect((await completions(fs, '/read', [])).map((c) => c.name)).toEqual(['README.md'])
        expect(await completions(fs, '/nowhere/', [])).toEqual([])
    })
})

describe('The path menu', () => {
    /** An editor on `notes/a.md`, the caret in a new paragraph at the end. */
    async function writing() {
        const opened = await openVault(FILES, { path: 'notes/a.md' })
        await userEvent.click(opened.editor.view.dom)
        opened.editor.commands.focus('end')
        await userEvent.keyboard('{Enter}')
        return opened
    }

    it('opens after a backtick and three characters of a path, goes into a chosen folder, and a chosen file finishes the code', async () => {
        const { editor } = await writing()
        await userEvent.keyboard('See `./s')
        await waitFor(() => !!menu(), 2000)
        expect(titles()).toEqual(['sub/'])
        // The rows are drawn as the toolbar's browser draws them: an icon
        // chip (the folder's glyph, a file's in its colour) and the path.
        expect(document.querySelector('.ezco-mde-path-menu .ezco-mde-slash-item-desc')?.textContent).toBe('./sub/')
        // Tab chooses as Enter does: the folder filled in, the menu on inside it.
        await userEvent.keyboard('{Tab}')
        await waitFor(() => titles().join() === 'deeper/,b.md', 2000)
        expect(editor.state.doc.lastChild?.textContent).toBe('See `./sub/')
        await userEvent.keyboard('{ArrowDown}{Enter}')
        await waitFor(() => !menu(), 2000)
        // The backtick and the path became code naming the file, nothing more.
        expect(getMarkdownContent(editor).endsWith('See `./sub/b.md`')).toBe(true)
        expect(editor.state.doc.lastChild?.lastChild?.marks.map((m) => m.type.name)).toEqual(['code'])
        // What is typed next is text.
        await userEvent.keyboard(' now')
        await waitFor(() => getMarkdownContent(editor).endsWith('See `./sub/b.md` now'), 2000)
    })

    it('knows `/`, `~/` and `../`, needs three characters, and is left alone by Escape until typed on', async () => {
        const { editor } = await writing()
        await userEvent.keyboard('`/sr')
        await waitFor(() => !!menu(), 2000)
        expect(titles()).toEqual(['src/'])
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !menu(), 2000)
        expect(editor.state.doc.lastChild?.textContent).toBe('`/sr')
        // Typed on, it asks again.
        await userEvent.keyboard('c')
        await waitFor(() => !!menu(), 2000)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => titles().join() === 'lib.ts,main.ts', 2000)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => getMarkdownContent(editor).endsWith('`/src/lib.ts`'), 2000)
        await waitFor(() => !menu(), 2000)

        await userEvent.keyboard('{Enter}`~/R')
        await waitFor(() => titles().join() === 'README.md', 2000)
        await userEvent.keyboard('{Escape}{Enter}`../s')
        await waitFor(() => titles().join() === 'src/', 2000)
        await userEvent.keyboard('{Escape}')
        // Two characters say nothing yet.
        await userEvent.keyboard('{Enter}`/s')
        await new Promise((r) => setTimeout(r, 150))
        expect(menu()).toBeNull()
    })

    it('completes a bare name too: the note’s folder first, else the root', async () => {
        const { editor } = await writing()
        await userEvent.keyboard('`src')
        await waitFor(() => titles().join() === 'src/', 2000)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => titles().join() === 'lib.ts,main.ts', 2000)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => getMarkdownContent(editor).endsWith('`src/lib.ts`'), 2000)
        await userEvent.keyboard('{Enter}`sub')
        await waitFor(() => titles().join() === 'sub/', 2000)
        expect(document.querySelector('.ezco-mde-path-menu .ezco-mde-slash-item-desc')?.textContent).toBe('sub/')
        await userEvent.keyboard('{Escape}')
    })

    it('completes a link’s destination, and a chosen file makes the link', async () => {
        const { editor } = await writing()
        // (`[[` types a bracket: `[` opens a key's name to user-event.)
        await userEvent.keyboard('[[the lib](/src/l')
        await waitFor(() => !!menu(), 2000)
        expect(titles()).toEqual(['lib.ts'])
        await userEvent.keyboard('{Enter}')
        await waitFor(() => !menu(), 2000)
        expect(getMarkdownContent(editor).endsWith('[the lib](/src/lib.ts)')).toBe(true)
        const text = editor.state.doc.lastChild!.firstChild!
        expect(text.marks.map((m) => [m.type.name, m.attrs.href])).toEqual([['link', '/src/lib.ts']])
    })

    it('completes a path inside code already made, in place', async () => {
        const { editor } = await writing()
        editor.commands.setContent('# A\n\n`./su`')
        // Into the code, at its end.
        editor.commands.focus('end')
        expect(editor.state.doc.lastChild?.textContent).toBe('./su')
        expect(editor.state.selection.$from.marks().map((m) => m.type.name)).toEqual(['code'])
        await userEvent.keyboard('b')
        await waitFor(() => !!menu(), 2000)
        expect(titles()).toEqual(['sub/'])
        await userEvent.keyboard('{Enter}')
        await waitFor(() => titles().join() === 'deeper/,b.md', 2000)
        await userEvent.keyboard('{ArrowDown}{Enter}')
        await waitFor(() => getMarkdownContent(editor) === '# A\n\n`./sub/b.md`', 2000)
    })
})
