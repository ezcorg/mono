import { describe, it, expect, afterEach } from 'vitest'
import { memoryVfs, type VfsInterface } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

/** Every write, in order, on top of a memory vault. */
function recorded(files: Record<string, string | Uint8Array>) {
    const fs = memoryVfs(files)
    const writes: string[] = []
    const spy: VfsInterface = {
        ...fs,
        writeFile: (path, data) => (writes.push(path), fs.writeFile(path, data)),
        writeBytes: (path, data) => (writes.push(path), fs.writeBytes(path, data)),
    }
    return { fs: spy, writes }
}

function open(fs: VfsInterface, filepath: string) {
    const container = createTestContainer(`code-${created.length}`)
    const editor = createEditor({ element: container, fs: { fs, filepath, autoSave: true } })
    created.push({ editor, container })
    return { editor, container, persistence: (editor.storage as any).persistence }
}

/** Past the 500 ms autosave debounce. */
const autosave = () => new Promise((r) => setTimeout(r, 700))

// A PDF's head: text, then bytes that are not UTF-8, and NULs.
const PDF = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), 0xe2, 0xe3, 0xcf, 0xd3, 0, 0, 10, 0xff])

describe('Files that are not Markdown', () => {
    it('shows a file that is not text, and never writes it', async () => {
        const { fs, writes } = recorded({ 'a.md': '# A', 'doc.pdf': PDF })
        const { container, persistence } = open(fs, 'a.md')
        await waitFor(() => !!container.querySelector('.ProseMirror')?.textContent?.includes('A'), 3000)
        await persistence.loadFile('doc.pdf')
        expect(container.querySelector('.cm-binary-preview')).not.toBeNull()
        await autosave()
        await persistence.loadFile('a.md')
        await autosave()
        expect([...(await fs.readBytes('doc.pdf'))]).toEqual([...PDF])
        expect(writes).toEqual([])
    })

    it('writes a code file’s edits, once, and nothing when it is only opened', async () => {
        const { fs, writes } = recorded({ 'a.md': '# A', 'main.ts': 'export const x = 1;\n' })
        const { container, persistence } = open(fs, 'a.md')
        await waitFor(() => !!container.querySelector('.ProseMirror')?.textContent?.includes('A'), 3000)
        const events: Array<{ type: string; path: string }> = []
        persistence.subscribe((event: { type: string; path: string }) => events.push({ type: event.type, path: event.path }))
        // Resolves with the file in the code view.
        await persistence.loadFile('main.ts')
        expect(persistence.codeView.state.doc.toString()).toBe('export const x = 1;\n')
        await autosave()
        expect(writes).toEqual([])
        persistence.codeView.dispatch({ changes: { from: 0, insert: '// edited\n' }, userEvent: 'input.type' })
        await autosave()
        expect(await fs.readFile('main.ts')).toBe('// edited\nexport const x = 1;\n')
        expect(writes).toEqual(['main.ts'])
        // The code view's lifecycle is the editor's.
        expect(events.filter((e) => e.path === 'main.ts')).toEqual([
            { type: 'load', path: 'main.ts' },
            { type: 'save', path: 'main.ts' },
        ])
    })

    it('rejects opening a file it cannot read', async () => {
        const store = memoryVfs({ 'a.md': '# A', 'locked.ts': 'x' })
        const fs: VfsInterface = { ...store, readBytes: () => Promise.reject(new Error('EACCES')) }
        const { container, persistence } = open(fs, 'a.md')
        await waitFor(() => !!container.querySelector('.ProseMirror')?.textContent?.includes('A'), 3000)
        await expect(persistence.loadFile('locked.ts')).rejects.toThrow('EACCES')
    })
})

describe('Opening files one after another', () => {
    it('shows the last file asked for, whichever read ends last', async () => {
        const store = memoryVfs({ 'a.md': '# A', 'b.md': '# B', 'main.ts': 'export {}\n' })
        const held: Array<() => void> = []
        const fs: VfsInterface = {
            ...store,
            // The first file's read is slow: it ends after the next open.
            readFile: (path) =>
                path === 'a.md' ? new Promise((resolve) => held.push(() => resolve(store.readFile(path)))) : store.readFile(path),
        }
        const { editor, persistence } = open(fs, 'a.md')
        await persistence.loadFile('b.md')
        held.forEach((release) => release())
        await new Promise((r) => setTimeout(r, 50))
        expect(persistence.options.filepath).toBe('b.md')
        expect((editor.storage as any).markdown.getMarkdown()).toBe('# B')

        // And a code file opened while a note is still being read.
        const slow = persistence.loadFile('a.md')
        await persistence.loadFile('main.ts')
        held.forEach((release) => release())
        await slow
        expect(persistence.options.filepath).toBe('main.ts')
        expect(persistence.codeView?.state.doc.toString()).toBe('export {}\n')
    })
})
