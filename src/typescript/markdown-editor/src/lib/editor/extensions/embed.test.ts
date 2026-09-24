import { describe, it, expect, afterEach } from 'vitest'
import { Vault, memoryVfs } from '@joinezco/storage'
import { createEditor, MarkdownEditor, MarkdownEditorOptions } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'
import { lineRange, sectionOf } from './embed'

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
    const container = createTestContainer(`emb-${created.length}`)
    const editor = createEditor({ element: container, ...options })
    created.push({ editor, container })
    return { editor, container }
}

describe('Embed syntax', () => {
    const roundTrips = [
        '![[diagram.png]]',
        '![[diagram.png|200]] beside ![[Note]]',
        '![[Note#Heading|Shown]] and ![[#Local]]',
        '![[src/lib.rs#L2-L3]]',
        '| a |\n| --- |\n| ![[x.png\\|120]] |\n\nafter',
        'A link [[Note]] is not an embed ![[Note]].',
    ]

    it.each(roundTrips)('round-trips %j byte for byte', (md) => {
        const { editor } = make({ content: md })
        expect(getMarkdownContent(editor)).toBe(md)
    })

    it('reads line ranges and sections', () => {
        expect(lineRange('L40-L80')).toEqual({ from: 40, to: 80 })
        expect(lineRange('L7')).toEqual({ from: 7, to: 7 })
        expect(lineRange('Heading')).toBeNull()
        const note = '# T\n\n## Goals\n\nShip.\n\n### Detail\n\nMore.\n\n## Later\n\nNo.'
        expect(sectionOf(note, 'Goals')).toBe('## Goals\n\nShip.\n\n### Detail\n\nMore.')
        expect(sectionOf(note, 'Nope')).toBeNull()
    })
})

describe('Embeds in a vault', () => {
    async function open(files: Record<string, string | Uint8Array>) {
        const vault = await Vault.open(memoryVfs(files), { watch: false })
        const made = make({ fs: { fs: vault.fs, filepath: 'index.md', autoSave: false }, links: { resolver: vault.links } })
        await waitFor(() => made.editor.getText().length > 0, 3000)
        return { ...made, vault }
    }
    const embeds = (c: HTMLElement) => [...c.querySelectorAll('.ezco-mde-embed')] as HTMLElement[]

    it('shows an image found by name, a note, a section, a region of a file, and a card for anything else', async () => {
        const { container } = await open({
            'index.md': '# Index\n\n![[dot.png|50]]\n\n![[Plan]]\n\n![[Plan#Goals]]\n\n![[main.rs#L2-L3]]\n\n![[paper.pdf]]\n\n![[Ghost]]',
            'media/dot.png': PNG,
            'projects/Plan.md': '---\nid: P\n---\n# Plan\n\nIntro.\n\n## Goals\n\nShip it.\n\n## Later\n\nNot yet.',
            'main.rs': 'fn main() {\n    let x = 1;\n    println!("{x}");\n}',
            'paper.pdf': '%PDF',
        })
        await waitFor(() => embeds(container).length === 6 && !embeds(container).some((e) => e.className === 'ezco-mde-embed'), 5000)
        const [image, note, section, region, file, missing] = embeds(container)
        expect(image.classList.contains('ezco-mde-embed--image')).toBe(true)
        expect(image.querySelector('img')?.style.width).toBe('50px')
        expect(note.querySelector('.ezco-mde-embed-content h1')?.textContent).toBe('Plan')
        expect(note.textContent).not.toContain('id: P')
        expect(section.querySelector('.ezco-mde-embed-content h2')?.textContent).toBe('Goals')
        expect(section.textContent).toContain('Ship it.')
        expect(section.textContent).not.toContain('Not yet.')
        // A region is an editor over those lines, numbered as in the file.
        await waitFor(() => region.querySelectorAll('.cm-line').length === 2, 3000)
        expect([...region.querySelectorAll('.cm-line')].map((l) => l.textContent)).toEqual(['    let x = 1;', '    println!("{x}");'])
        expect(
            [...region.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')]
                .filter((el) => el.style.visibility !== 'hidden')
                .map((el) => el.textContent),
        ).toEqual(['2', '3'])
        expect(file.classList.contains('ezco-mde-embed--file')).toBe(true)
        expect(missing.classList.contains('is-missing')).toBe(true)
    })

    it('follows the embedded note as it changes', async () => {
        const { container, vault } = await open({ 'index.md': '# Index\n\n![[Plan]]', 'Plan.md': 'First version.' })
        const content = () => container.querySelector('.ezco-mde-embed-content')?.textContent ?? ''
        await waitFor(() => content().includes('First version.'), 3000)
        await vault.fs.writeFile('Plan.md', 'Second version.')
        await waitFor(() => content().includes('Second version.'), 3000)
    })
})
