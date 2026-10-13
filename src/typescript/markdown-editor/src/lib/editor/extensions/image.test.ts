import { describe, it, expect, afterEach } from 'vitest'
import { memoryVfs, type VfsInterface } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
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

describe('Images dropped on a note', () => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const posOf = (editor: MarkdownEditor, text: string) => {
        let at = -1
        editor.state.doc.descendants((node, pos) => {
            if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text)
            return at < 0
        })
        return at
    }

    /**
     * A drop on the note at the position `at`, as the browser delivers one:
     * a `DragEvent` with the files (or text) on its `dataTransfer` and the
     * pointer's coordinates, those of the position.
     */
    function drop(editor: MarkdownEditor, payload: { files?: File[]; text?: string }, at: number) {
        const data = new DataTransfer()
        for (const file of payload.files ?? []) data.items.add(file)
        if (payload.text !== undefined) data.setData('text/plain', payload.text)
        const { left, top, bottom } = editor.view.coordsAtPos(at)
        const event = new DragEvent('drop', { dataTransfer: data, clientX: left, clientY: (top + bottom) / 2, bubbles: true, cancelable: true })
        editor.view.dom.dispatchEvent(event)
        return event
    }

    it('stores a dropped image in attachments and puts it where it was dropped, not at the caret', async () => {
        const { editor, fs } = await inVault({ 'notes/n.md': 'Before. After.\n\nSecond.' }, 'notes/n.md')
        await frame()
        // The caret is elsewhere: the image goes under the pointer.
        editor.commands.setTextSelection(posOf(editor, 'Second') + 'Second.'.length)
        const event = drop(editor, { files: [new File([PNG], 'shot.png', { type: 'image/png' })] }, posOf(editor, ' After'))
        expect(event.defaultPrevented).toBe(true)
        await waitFor(() => getMarkdownContent(editor).includes('!['), 3000)
        const files = (await fs.readDir('attachments')).map(([name]) => name)
        expect(files).toHaveLength(1)
        expect(files[0]).toMatch(/^shot-[0-9a-f]{8}\.png$/)
        expect([...(await fs.readBytes(`attachments/${files[0]}`))]).toEqual([...PNG])
        const image = editor.state.doc.nodeAt(posOf(editor, 'Before.') + 'Before.'.length)!
        expect(image.type.name).toBe('image')
        expect(image.attrs.src).toBe(`../attachments/${files[0]}`)
        expect(getMarkdownContent(editor)).toBe(`Before.![shot](../attachments/${files[0]}) After.\n\nSecond.`)
    })

    it('drops several images in order, each stored once', async () => {
        const { editor, fs } = await inVault({ 'n.md': 'A\n\nB' }, 'n.md')
        await frame()
        const other = Uint8Array.from([...PNG, 0])
        const event = drop(editor, {
            files: [new File([PNG], 'one.png', { type: 'image/png' }), new File([other], 'two.png', { type: 'image/png' }), new File([PNG], 'one.png', { type: 'image/png' })],
        }, posOf(editor, 'B') + 1)
        expect(event.defaultPrevented).toBe(true)
        await waitFor(() => (getMarkdownContent(editor).match(/!\[/g) ?? []).length === 3, 3000)
        const files = (await fs.readDir('attachments')).map(([name]) => name).sort()
        expect(files).toHaveLength(2)
        expect(getMarkdownContent(editor)).toMatch(/^A\n\nB!\[one\]\(attachments\/one-(\w{8})\.png\)!\[two\]\(attachments\/two-\w{8}\.png\)!\[one\]\(attachments\/one-\1\.png\)$/)
    })

    it('leaves a dropped Markdown file alone: no node, no file, the browser’s default kept', async () => {
        const { editor, fs } = await inVault({ 'n.md': 'Only text.' }, 'n.md')
        await frame()
        const event = drop(editor, { files: [new File(['# Other\n\nNote.'], 'other.md', { type: 'text/markdown' })] }, posOf(editor, 'text'))
        expect(event.defaultPrevented).toBe(false)
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(getMarkdownContent(editor)).toBe('Only text.')
        expect(await fs.exists('attachments')).toBe(false)
    })

    it('drops text from elsewhere as Markdown, at the drop point', async () => {
        const { editor } = await inVault({ 'n.md': 'Start end.' }, 'n.md')
        await frame()
        const event = drop(editor, { text: '**dragged** ' }, posOf(editor, 'end'))
        expect(event.defaultPrevented).toBe(true)
        expect(getMarkdownContent(editor)).toBe('Start **dragged** end.')
    })
})
