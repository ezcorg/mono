import { describe, it, expect, afterEach } from 'vitest'
import { Vault, memoryVfs, type VfsInterface } from '@joinezco/storage'
import { createEditor, MarkdownEditor, MarkdownEditorOptions } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

// A 1×1 PNG.
const PNG = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
)

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

function make(options: MarkdownEditorOptions) {
    const container = createTestContainer(`img-${created.length}`)
    const editor = createEditor({ element: container, ...options })
    created.push({ editor, container })
    return { editor, container }
}

async function inVault(files: Record<string, string | Uint8Array>, open: string, autoSave = false) {
    const fs = memoryVfs(files)
    const vault = await Vault.open(fs, { watch: false })
    const made = make({ fs: { fs: vault.fs, filepath: open, autoSave }, links: { resolver: vault.links } })
    await waitFor(() => made.editor.getText().length > 0 || made.editor.state.doc.firstChild?.childCount === 1, 3000)
    return { ...made, fs: vault.fs as VfsInterface, vault }
}

describe('Image syntax', () => {
    const roundTrips = [
        '![alt](a.png)',
        '![A picture](dir/my%20pic.png "Its title")',
        '![sized|200](a.png) and ![both|200x100](b.png)',
        'An image ![inline](i.png) within text.',
        '![](https://example.com/x.png)',
        '![p](a\\(1\\).png)',
        '![b](<my pic.png>) and ![c](my%20pic.png)',
    ]

    it.each(roundTrips)('round-trips %j byte for byte', (md) => {
        const { editor } = make({ content: md })
        expect(getMarkdownContent(editor)).toBe(md)
    })
})

describe('Images in a vault', () => {
    it('shows an image from the vault’s bytes, relative to the note, sized by its alt', async () => {
        const { container } = await inVault(
            { 'attachments/dot.png': PNG, 'notes/n.md': '# N\n\n![a dot|120](../attachments/dot.png) and ![gone](nope.png)' },
            'notes/n.md',
        )
        const imgs = () => [...container.querySelectorAll('.ezco-mde-image')] as HTMLElement[]
        await waitFor(() => !!imgs()[0]?.querySelector('img')?.getAttribute('src')?.startsWith('blob:'), 3000)
        const img = imgs()[0].querySelector('img') as HTMLImageElement
        await waitFor(() => img.complete && img.naturalWidth === 1, 3000)
        expect(img.style.width).toBe('120px')
        expect(img.alt).toBe('a dot')
        await waitFor(() => imgs()[1].classList.contains('is-missing'), 3000)
        expect(imgs()[1].getAttribute('data-missing')).toBe('notes/nope.png')
    })

    it('stores a pasted image in the attachments folder, once, and links it relatively', async () => {
        const { editor, fs } = await inVault({ 'notes/n.md': 'Here:' }, 'notes/n.md')
        editor.commands.focus('end')
        const paste = () => {
            const data = new DataTransfer()
            data.items.add(new File([PNG], 'My Dot.png', { type: 'image/png' }))
            editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        }
        paste()
        await waitFor(() => getMarkdownContent(editor).includes('!['), 3000)
        const files = (await fs.readDir('attachments')).map(([name]) => name)
        expect(files).toHaveLength(1)
        expect(files[0]).toMatch(/^My-Dot-[0-9a-f]{8}\.png$/)
        expect([...(await fs.readBytes(`attachments/${files[0]}`))]).toEqual([...PNG])
        expect(getMarkdownContent(editor)).toBe(`Here:![My Dot](../attachments/${files[0]})`)
        // The same bytes again: one file, two links.
        paste()
        await waitFor(() => (getMarkdownContent(editor).match(/!\[/g) ?? []).length === 2, 3000)
        expect((await fs.readDir('attachments')).length).toBe(1)
    })

    it('puts a pasted image where it was pasted, though the note changed while it was stored', async () => {
        const store = memoryVfs({ 'n.md': 'Before. After.' })
        let release!: () => void
        const held = new Promise<void>((resolve) => (release = resolve))
        // Storing the image takes a while.
        const fs: VfsInterface = { ...store, writeBytes: async (path, data) => (await held, store.writeBytes(path, data)) }
        const vault = await Vault.open(fs, { watch: false })
        const { editor } = make({ fs: { fs: vault.fs, filepath: 'n.md' } })
        await waitFor(() => editor.getText().includes('After'), 3000)
        let at = 0
        editor.state.doc.descendants((node, pos) => {
            if (node.isText) at = pos + node.text!.indexOf(' After')
        })
        editor.commands.setTextSelection(at)
        const data = new DataTransfer()
        data.items.add(new File([PNG], 'dot.png', { type: 'image/png' }))
        editor.view.dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        // Meanwhile, text is added before the paste position.
        editor.commands.insertContentAt(1, 'Much ')
        release()
        await waitFor(() => getMarkdownContent(editor).includes('!['), 3000)
        expect(getMarkdownContent(editor)).toMatch(/^Much Before\.!\[dot\]\(attachments\/dot-[0-9a-f]{8}\.png\) After\.$/)
    })

    it('opens an image file as a preview from its bytes, and leaving it does not overwrite it', async () => {
        const { editor, container, fs } = await inVault({ 'a.md': '# A', 'pic.png': PNG }, 'a.md', true)
        const persistence = (editor.storage as any).persistence
        await persistence.loadFile('pic.png')
        await waitFor(() => !!container.querySelector('.cm-image-preview img')?.getAttribute('src')?.startsWith('blob:'), 5000)
        await persistence.loadFile('a.md')
        await new Promise((r) => setTimeout(r, 700))
        expect([...(await fs.readBytes('pic.png'))]).toEqual([...PNG])
    })
})
