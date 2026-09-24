import { describe, it, expect, afterEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import { persistFile, regionField } from '@joinezco/codeblock'
import { Vault, memoryVfs } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

/**
 * A region of a file in a note: a fence whose info string names the file and
 * its lines (```` ```src/lib.rs#L2-L3 ````). The file is the source of truth;
 * the fence's body is the lines as last seen, and an edit to them goes back
 * into the file where they are.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const LIB = ['fn one() {}', 'fn two() {}', 'fn three() {}', 'fn four() {}', 'fn five() {}'].join('\n') + '\n'

const fence = (info: string, body: string) => '```' + info + '\n' + body + '\n```'

async function open(note: string, options: { lib?: string; versions?: boolean } = {}) {
    const vault = await Vault.open(memoryVfs({ 'src/lib.rs': options.lib ?? LIB, 'n.md': note }), { watch: false })
    const container = createTestContainer(`region-${created.length}`)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: 'n.md', autoSave: true },
        links: { resolver: vault.links },
        search: vault.search,
        files: vault.files,
        ...(options.versions === false ? {} : { versions: vault.versions }),
    })
    created.push({ editor, container })
    const region = () => {
        const dom = container.querySelector<HTMLElement>('.ProseMirror .cm-editor')
        return dom ? EditorView.findFromDOM(dom) : null
    }
    // Loaded: the region knows where its lines are.
    await waitFor(() => !!region()?.state.field(regionField, false), 3000)
    return { editor, vault, container, region: () => region()! }
}

const numbers = (view: EditorView) =>
    // (CodeMirror keeps a hidden spacer in the gutter to size it.)
    [...view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')].filter((el) => el.style.visibility !== 'hidden').map((el) => el.textContent)

const type = (view: EditorView, at: number, insert: string) => view.dispatch({ changes: { from: at, insert }, userEvent: 'input.type' })

describe('A region of a file, as a fence', () => {
    it('reads and writes its info string, the file’s path and its lines', async () => {
        const note = fence('src/lib.rs#L2-L3', 'fn two() {}\nfn three() {}')
        const { editor } = await open(note)
        const block = editor.state.doc.firstChild!
        expect(block.type.name).toBe('ezcodeBlock')
        expect(block.attrs).toMatchObject({ file: 'src/lib.rs', lines: 'L2-L3', language: 'rust' })
        expect(getMarkdownContent(editor)).toBe(note)
    })

    it('shows the file’s lines, numbered as the file numbers them, and puts an edit back in their place', async () => {
        const { editor, vault, region } = await open(`See:\n\n${fence('src/lib.rs#L2-L3', 'fn two() {}\nfn three() {}')}`)
        expect(region().state.doc.toString()).toBe('fn two() {}\nfn three() {}')
        await waitFor(() => numbers(region()).join(',') === '2,3', 3000)

        type(region(), 3, 'TWO_')
        await persistFile(region())
        expect(await vault.fs.readFile('src/lib.rs')).toBe(LIB.replace('fn two()', 'fn TWO_two()'))
        const [latest, first] = await vault.versions.history('src/lib.rs')
        expect(latest.parents).toEqual([first.id])
        // The note keeps the lines as they now are.
        expect(getMarkdownContent(editor)).toContain(fence('src/lib.rs#L2-L3', 'fn TWO_two() {}\nfn three() {}'))
    })

    it('takes the file’s lines over a body the file no longer has', async () => {
        const { editor, region } = await open(fence('src/lib.rs#L2', 'fn deux() {}'))
        await waitFor(() => region().state.doc.toString() === 'fn two() {}', 3000)
        await waitFor(() => getMarkdownContent(editor) === fence('src/lib.rs#L2', 'fn two() {}'), 3000)
    })

    it('finds its lines where they moved to, and says so in its info string', async () => {
        const { editor, region } = await open(fence('src/lib.rs#L2-L3', 'fn two() {}\nfn three() {}'), { lib: '// one\n// two\n' + LIB })
        expect(region().state.doc.toString()).toBe('fn two() {}\nfn three() {}')
        await waitFor(() => getMarkdownContent(editor) === fence('src/lib.rs#L4-L5', 'fn two() {}\nfn three() {}'), 3000)
        await waitFor(() => numbers(region()).join(',') === '4,5', 3000)
    })

    it('grows its range with the lines it holds', async () => {
        const { editor, vault, region } = await open(fence('src/lib.rs#L2-L3', 'fn two() {}\nfn three() {}'))
        type(region(), region().state.doc.length, '\nfn two_and_a_half() {}')
        await persistFile(region())
        expect(await vault.fs.readFile('src/lib.rs')).toBe(LIB.replace('fn three() {}\n', 'fn three() {}\nfn two_and_a_half() {}\n'))
        await waitFor(() => getMarkdownContent(editor) === fence('src/lib.rs#L2-L4', 'fn two() {}\nfn three() {}\nfn two_and_a_half() {}'), 3000)
    })

    it('puts an edit where its lines are now when the file changed above them since they were shown', async () => {
        const { editor, vault, region } = await open(fence('src/lib.rs#L2-L3', 'fn two() {}\nfn three() {}'))
        await vault.fs.writeFile('src/lib.rs', '// added above\n' + LIB)
        type(region(), 0, '#[inline]\n')
        await persistFile(region())
        expect(await vault.fs.readFile('src/lib.rs')).toBe('// added above\n' + LIB.replace('fn two', '#[inline]\nfn two'))
        await waitFor(() => getMarkdownContent(editor) === fence('src/lib.rs#L3-L5', '#[inline]\nfn two() {}\nfn three() {}'), 3000)
    })

    it('keeps an edit as a conflict copy when its own lines changed in the file, and shows the file’s', async () => {
        const { vault, region } = await open(fence('src/lib.rs#L1-L2', 'fn one() {}\nfn two() {}'))
        await vault.fs.writeFile('src/lib.rs', LIB.replace('fn one', 'fn ONE'))
        type(region(), 0, '// mine\n')
        await waitFor(async () => (await vault.fs.readDir('src')).some(([name]) => name.includes('conflict')), 3000)
        const copy = (await vault.fs.readDir('src')).map(([name]) => name).find((name) => name.includes('conflict'))!
        expect(await vault.fs.readFile(`src/${copy}`)).toBe(`// mine\n${LIB}`)
        expect(await vault.fs.readFile('src/lib.rs')).toBe(LIB.replace('fn one', 'fn ONE'))
        await waitFor(() => region().state.doc.toString() === 'fn ONE() {}\nfn two() {}', 3000)
    })

    it('does so without a version log too', async () => {
        const { vault, region } = await open(fence('src/lib.rs#L1', 'fn one() {}'), { versions: false })
        await vault.fs.writeFile('src/lib.rs', LIB.replace('fn one', 'fn ONE'))
        type(region(), 0, 'pub ')
        await waitFor(async () => (await vault.fs.readDir('src')).some(([name]) => name.includes('conflict')), 3000)
        expect(await vault.fs.readFile('src/lib.rs')).toBe(LIB.replace('fn one', 'fn ONE'))
        await waitFor(() => region().state.doc.toString() === 'fn ONE() {}', 3000)
    })

    it('does not bring a body the file no longer has back into the file on undo', async () => {
        const { editor, vault, region } = await open(fence('src/lib.rs#L2', 'fn deux() {}'))
        await waitFor(() => getMarkdownContent(editor) === fence('src/lib.rs#L2', 'fn two() {}'), 3000)
        editor.commands.undo()
        await persistFile(region())
        expect(region().state.doc.toString()).toBe('fn two() {}')
        expect(await vault.fs.readFile('src/lib.rs')).toBe(LIB)
    })
})
