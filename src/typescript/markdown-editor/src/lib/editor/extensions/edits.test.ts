import { describe, it, expect, afterEach } from 'vitest'
import { memoryVfs } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
import { createEditor, openDocuments, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const NOTE = '# Title\n\nFirst paragraph.\n\nSecond paragraph.'

async function open(files: Record<string, string>, filepath: string) {
    const vault = await Vault.open(memoryVfs(files), { watch: false })
    const container = createTestContainer(`edits-${created.length}`)
    const editor = createEditor({ element: container, fs: { fs: vault.fs, filepath, autoSave: true }, versions: vault.versions })
    created.push({ editor, container })
    const persistence = (editor.storage as any).persistence
    await waitFor(() => persistence.options.filepath === filepath && editor.getText().length > 0, 3000)
    return { editor, vault, persistence, docs: openDocuments(editor), markdown: () => (editor.storage as any).markdown.getMarkdown() as string }
}

/** The caret, as the text just before it. */
const beforeCaret = (editor: MarkdownEditor, n: number) => {
    const { from } = editor.state.selection
    return editor.state.doc.textBetween(Math.max(0, from - n), from)
}

describe('Edits into an open document', () => {
    it('applies an edit to the open note as one change, keeping the caret, and saves it as a version', async () => {
        const { editor, vault, docs, markdown } = await open({ 'a.md': NOTE }, 'a.md')
        // The user's caret, after "Second".
        let at = 0
        editor.state.doc.descendants((node, pos) => {
            if (node.isText && node.text!.startsWith('Second')) at = pos + 'Second'.length
        })
        editor.commands.setTextSelection(at)

        const doc = (await docs.read('a.md'))!
        expect(doc.text).toBe(NOTE)
        const from = doc.text.indexOf('First')
        const result = await docs.edit('a.md', doc.version, [{ range: { from, to: from + 'First'.length }, text: 'Opening' }])
        expect(result.ok).toBe(true)
        expect(markdown()).toBe('# Title\n\nOpening paragraph.\n\nSecond paragraph.')
        expect(beforeCaret(editor, 6)).toBe('Second')
        // Saved, as a version on the one loaded.
        expect(await vault.fs.readFile('a.md')).toBe('# Title\n\nOpening paragraph.\n\nSecond paragraph.')
        expect(await vault.versions.history('a.md')).toHaveLength(2)
        // One step to undo, like any edit.
        editor.commands.undo()
        expect(markdown()).toBe(NOTE)
    })

    it('refuses an edit made on an older version: the document changed since it was read', async () => {
        const { editor, docs, markdown } = await open({ 'a.md': NOTE }, 'a.md')
        const doc = (await docs.read('a.md'))!
        editor.commands.focus('end')
        editor.commands.insertContent(' Typed.')
        const result = await docs.edit('a.md', doc.version, [{ range: { from: 0, to: 0 }, text: 'x' }])
        expect(result).toMatchObject({ ok: false, reason: 'stale' })
        expect(markdown()).toBe(`${NOTE} Typed.`)
        // Read again, and it applies.
        const fresh = (await docs.read('a.md'))!
        expect(fresh.version).not.toBe(doc.version)
        expect((await docs.edit('a.md', fresh.version, [{ range: { from: fresh.text.length, to: fresh.text.length }, text: '!' }])).ok).toBe(true)
        expect(markdown()).toBe(`${NOTE} Typed.!`)
    })

    it('takes positions as lines and characters (LSP’s), and several edits at once', async () => {
        const { docs, markdown } = await open({ 'a.md': NOTE }, 'a.md')
        const doc = (await docs.read('a.md'))!
        const result = await docs.edit('a.md', doc.version, [
            { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 6 } }, text: 'Last' },
            { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 7 } }, text: 'Heading' },
        ])
        expect(result.ok).toBe(true)
        expect(markdown()).toBe('# Heading\n\nFirst paragraph.\n\nLast paragraph.')
    })

    it('refuses edits that overlap or fall outside the text', async () => {
        const { docs, markdown } = await open({ 'a.md': NOTE }, 'a.md')
        const doc = (await docs.read('a.md'))!
        expect(
            await docs.edit('a.md', doc.version, [
                { range: { from: 0, to: 5 }, text: 'a' },
                { range: { from: 3, to: 8 }, text: 'b' },
            ]),
        ).toMatchObject({ ok: false, reason: 'invalid' })
        expect(await docs.edit('a.md', doc.version, [{ range: { from: 0, to: 10_000 }, text: '' }])).toMatchObject({ ok: false, reason: 'invalid' })
        expect(markdown()).toBe(NOTE)
    })

    it('edits a code file in the code view, keeping its caret', async () => {
        const { vault, persistence, docs } = await open({ 'a.md': NOTE, 'main.ts': 'export const a = 1\nexport const b = 2\n' }, 'a.md')
        await persistence.loadFile('main.ts')
        const code = persistence.codeView
        code.dispatch({ selection: { anchor: code.state.doc.line(2).from + 6 } })
        const doc = (await docs.read('main.ts'))!
        expect(doc.text).toBe('export const a = 1\nexport const b = 2\n')
        const result = await docs.edit('main.ts', doc.version, [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: '// added\n' }])
        expect(result.ok).toBe(true)
        expect(code.state.doc.toString()).toBe('// added\nexport const a = 1\nexport const b = 2\n')
        // Still after "export" on the line that was second.
        const head = code.state.selection.main.head
        expect(code.state.doc.sliceString(head - 6, head)).toBe('export')
        expect(code.state.doc.lineAt(head).number).toBe(3)
        expect(await vault.fs.readFile('main.ts')).toBe('// added\nexport const a = 1\nexport const b = 2\n')
    })

    it('says a file is not open', async () => {
        const { docs } = await open({ 'a.md': NOTE, 'b.md': '# B' }, 'a.md')
        expect(await docs.read('b.md')).toBeNull()
        expect(await docs.edit('b.md', 0, [{ range: { from: 0, to: 0 }, text: 'x' }])).toMatchObject({ ok: false, reason: 'not-open' })
    })
})
