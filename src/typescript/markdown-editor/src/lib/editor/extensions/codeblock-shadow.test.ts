import { describe, it, expect, afterEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import { memoryVfs } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

/**
 * An unnamed fence (```` ```ts ````) gets a stand-in file for its language
 * services: hidden beside the note, written from the fence, never named in
 * the note.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const NOTE = ['# Code', '', '```ts', 'const a = 1', '```', '', 'Between.', '', '```ts', 'const b = 2', '```', '', '```sh', 'ls', '```', '', '```src/lib.ts', 'export {}', '```'].join('\n')

async function open() {
    const vault = await Vault.open(memoryVfs({ 'notes/plan.md': NOTE, 'src/lib.ts': 'export {}\n' }), { watch: false })
    const container = createTestContainer(`shadow-${created.length}`)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: 'notes/plan.md', autoSave: true },
        links: { resolver: vault.links, index: vault.links },
        search: vault.search,
        files: vault.files,
        codeblock: { standIns: true },
    })
    created.push({ editor, container })
    await waitFor(() => editor.getText().includes('Between'), 3000)
    return { editor, vault, container }
}

describe('An unnamed code fence', () => {
    it('is opened as a hidden stand-in file beside the note, one per fence, and stays unnamed', async () => {
        const { editor, vault, container } = await open()
        await waitFor(async () => (await vault.fs.exists('notes/.plan.1.ts')) && (await vault.fs.exists('notes/.plan.2.ts')), 5000)
        expect(await vault.fs.readFile('notes/.plan.1.ts')).toBe('const a = 1')
        expect(await vault.fs.readFile('notes/.plan.2.ts')).toBe('const b = 2')
        // A language without services, and a named fence, get none.
        expect(await vault.fs.exists('notes/.plan.1.sh')).toBe(false)
        expect(await vault.fs.exists('notes/.plan.3.ts')).toBe(false)
        // The note is as it was: the fences unnamed.
        expect(getMarkdownContent(editor)).toBe(NOTE)
        // The block's toolbar names the language, not the stand-in.
        await waitFor(() => [...container.querySelectorAll<HTMLInputElement>('.cm-toolbar-input')].some((i) => i.value === 'ts'), 3000)
        const inputs = [...container.querySelectorAll<HTMLInputElement>('.cm-toolbar-input')].map((i) => i.value)
        expect(inputs.some((v) => v.includes('.plan.'))).toBe(false)
        expect(inputs).toContain('src/lib.ts')
        // Hidden files are not the vault's business.
        expect(vault.paths().some((p) => p.includes('.plan.'))).toBe(false)
    })

    it('writes nothing to the note when a stand-in is only read into its fence', async () => {
        const vault = await Vault.open(memoryVfs({ 'notes/plan.md': NOTE, 'src/lib.ts': 'export {}\n' }), { watch: false })
        const container = createTestContainer(`shadow-${created.length}`)
        const events: string[] = []
        const trs: string[] = []
        const editor = createEditor({
            element: container,
            fs: { fs: vault.fs, filepath: 'notes/plan.md', autoSave: true },
            links: { resolver: vault.links, index: vault.links },
            search: vault.search,
            files: vault.files,
            codeblock: { standIns: true },
            onTransaction: ({ transaction }) => {
                if (transaction.docChanged) trs.push(JSON.stringify(transaction.steps.map((s) => s.toJSON())).slice(0, 240))
            },
        })
        created.push({ editor, container })
        ;(editor.storage as any).persistence.subscribe((e: { type: string }) => events.push(e.type))
        await waitFor(() => editor.getText().includes('Between'), 3000)
        await waitFor(async () => vault.fs.exists('notes/.plan.1.ts'), 5000)
        await new Promise((r) => setTimeout(r, 1200))
        // The stand-ins were read into their fences, and the named fence's
        // file into its own: none of that is an edit of the note.
        expect(events.filter((e) => e === 'save')).toEqual([])
        expect(trs.length).toBeGreaterThan(0)
    })

    it('removes stand-ins the note has no fence for any more, when it opens', async () => {
        const { editor, vault } = await open()
        await waitFor(async () => (await vault.fs.exists('notes/.plan.1.ts')) && (await vault.fs.exists('notes/.plan.2.ts')), 5000)
        // The second fence goes, and the note is reopened: its stand-in is gone.
        const md = getMarkdownContent(editor).replace('```ts\nconst b = 2\n```\n\n', '')
        await vault.fs.writeFile('notes/plan.md', md)
        await (editor.storage as any).persistence.loadFile('src/lib.ts')
        await (editor.storage as any).persistence.loadFile('notes/plan.md')
        await waitFor(async () => !(await vault.fs.exists('notes/.plan.2.ts')), 5000)
        expect(await vault.fs.exists('notes/.plan.1.ts')).toBe(true)
    })

    it('follows the fence as it is edited', async () => {
        const { editor, vault, container } = await open()
        await waitFor(() => vault.fs.exists('notes/.plan.1.ts'), 5000)
        const cm = container.querySelector('.cm-content') as HTMLElement
        await waitFor(() => cm.textContent?.includes('const a = 1') ?? false, 3000)
        // Type into the first block through its CodeMirror view.
        const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
        expect(view).toBeTruthy()
        view.dispatch({ changes: { from: view.state.doc.length, insert: '\nconst c = 3' }, userEvent: 'input.type' })
        await waitFor(() => getMarkdownContent(editor).includes('const a = 1\nconst c = 3'), 3000)
        await waitFor(async () => (await vault.fs.readFile('notes/.plan.1.ts')) === 'const a = 1\nconst c = 3', 5000)
        expect(getMarkdownContent(editor)).toContain('```ts\nconst a = 1\nconst c = 3\n```')
    })
})
