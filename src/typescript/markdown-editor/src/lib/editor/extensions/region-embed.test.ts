import { describe, it, expect, afterEach } from 'vitest'
import { EditorView } from '@codemirror/view'
import { Vault, memoryVfs } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const LIB = ['fn one() {}', 'fn two() {}', 'fn three() {}', 'fn four() {}', 'fn five() {}'].join('\n') + '\n'

async function open(note: string, useVersions = true) {
    const vault = await Vault.open(memoryVfs({ 'src/lib.rs': LIB, 'n.md': note }), { watch: false })
    const container = createTestContainer(`region-${created.length}`)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: 'n.md', autoSave: true },
        links: { resolver: vault.links },
        search: vault.search,
        files: vault.files,
        ...(useVersions ? { versions: vault.versions } : {}),
    })
    created.push({ editor, container })
    await waitFor(() => !!container.querySelector('.ezco-mde-embed--region .cm-content'), 3000)
    const region = () => EditorView.findFromDOM(container.querySelector('.ezco-mde-embed--region .cm-editor') as HTMLElement)!
    return { editor, vault, container, region }
}

/** Past the region's 500 ms save debounce. */
const saved = () => new Promise((r) => setTimeout(r, 800))

describe('Region embeds', () => {
    it('show the lines numbered as in the file, and write back only those lines when edited', async () => {
        const { vault, container, region } = await open('See ![[src/lib.rs#L2-L3]] here.')
        expect(region().state.doc.toString()).toBe('fn two() {}\nfn three() {}')
        // (CodeMirror keeps a hidden spacer in the gutter to size it.)
        const numbers = [...container.querySelectorAll<HTMLElement>('.ezco-mde-embed--region .cm-lineNumbers .cm-gutterElement')]
            .filter((el) => el.style.visibility !== 'hidden')
            .map((el) => el.textContent)
        expect(numbers).toEqual(['2', '3'])

        region().dispatch({ changes: { from: 3, to: 6, insert: 'TWO' }, userEvent: 'input.type' })
        await saved()
        expect(await vault.fs.readFile('src/lib.rs')).toBe(LIB.replace('fn two()', 'fn TWO()'))
        const [latest, first] = await vault.versions.history('src/lib.rs')
        expect(latest.parents).toEqual([first.id])
    })

    it('grows or shrinks its range with the lines it holds, so it keeps showing the same region', async () => {
        const { editor, vault, region } = await open('![[src/lib.rs#L2-L3]]')
        const view = region()
        view.dispatch({ changes: { from: view.state.doc.length, insert: '\nfn two_and_a_half() {}' }, userEvent: 'input.type' })
        await saved()
        expect(await vault.fs.readFile('src/lib.rs')).toBe(LIB.replace('fn three() {}\n', 'fn three() {}\nfn two_and_a_half() {}\n'))
        expect(getMarkdownContent(editor)).toBe('![[src/lib.rs#L2-L4]]')
    })

    it('keeps an edit as a conflict copy when the file changed since it was shown, and shows the file again', async () => {
        const { vault, region, container } = await open('![[src/lib.rs#L1-L2]]')
        await vault.fs.writeFile('src/lib.rs', LIB.replace('fn five', 'fn FIVE'))
        region().dispatch({ changes: { from: 0, insert: '// mine\n' }, userEvent: 'input.type' })
        await saved()
        expect(await vault.fs.readFile('src/lib.rs')).toBe(LIB.replace('fn five', 'fn FIVE'))
        const copies = (await vault.fs.readDir('src')).map(([name]) => name).filter((name) => name.includes('conflict'))
        expect(copies).toHaveLength(1)
        expect(await vault.fs.readFile(`src/${copies[0]}`)).toBe(`// mine\n${LIB}`)
        await waitFor(() => !!container.querySelector('.ezco-mde-embed--region .cm-content'), 3000)
        expect(region().state.doc.toString()).toBe('fn one() {}\nfn two() {}')
    })

    it('without a version log, writes only if the file is as it was shown', async () => {
        const { vault, region } = await open('![[src/lib.rs#L1-L1]]', false)
        await vault.fs.writeFile('src/lib.rs', `changed\n${LIB}`)
        region().dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' })
        await saved()
        expect(await vault.fs.readFile('src/lib.rs')).toBe(`changed\n${LIB}`)
    })
})
