import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { memoryVfs } from '@joinezco/storage'
import { Vault, type LinkIndex, type LinkRef } from '@joinezco/vault'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const FILES = {
    'index.md': '# Index\n\nSee [[plan]].',
    'projects/plan.md': '# Plan\n\nBack to [[index]]; ask [[ghost]].',
    'projects/roadmap.md': '# Roadmap\n\nFirst [[plan]], then [the index](../index.md).',
}

async function open(path: string, files: Record<string, string> = FILES) {
    const vault = await Vault.open(memoryVfs(files), { watch: false })
    const container = createTestContainer(`lp-${created.length}`)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: path, autoSave: true },
        links: { resolver: vault.links, index: vault.links, panel: { open: true } },
    })
    created.push({ editor, container })
    await waitFor(() => editor.getText().length > 0, 3000)
    return { editor, vault, container }
}

const panel = (container: HTMLElement) => container.querySelector('.ezco-mde-links') as HTMLElement
const rows = (container: HTMLElement, section: 'back' | 'dangling') =>
    Array.from(
        panel(container)?.querySelectorAll(
            section === 'back' ? '.ezco-mde-links-list:not(.ezco-mde-links-dangling *) .ezco-mde-links-link' : '.ezco-mde-links-dangling .ezco-mde-links-link',
        ) ?? [],
    ) as HTMLElement[]
const names = (els: HTMLElement[]) => els.map((el) => el.querySelector('.ezco-mde-links-name')?.textContent)
const filepath = (editor: MarkdownEditor) => (editor.storage as any).persistence.options.filepath as string

describe('Links panel', () => {
    it('lists the notes linking to the open note, and its links to notes not written yet', async () => {
        const { container } = await open('projects/plan.md')
        await waitFor(() => rows(container, 'back').length === 2, 3000)
        expect(names(rows(container, 'back'))).toEqual(['index', 'roadmap'])
        expect(names(rows(container, 'dangling'))).toEqual(['ghost'])
        // It sits under the note by default.
        expect(panel(container).previousElementSibling?.classList.contains('ezco-mde-body')).toBe(true)
    })

    it('follows the open note, and the vault as it changes', async () => {
        const { editor, vault, container } = await open('projects/plan.md')
        await waitFor(() => rows(container, 'back').length === 2, 3000)
        await (editor.storage as any).persistence.loadFile('index.md')
        await waitFor(() => names(rows(container, 'back')).join() === 'plan,roadmap', 3000)
        expect(panel(container).querySelector('.ezco-mde-links-dangling')?.hasAttribute('hidden')).toBe(true)
        // Another note gains a link here: the index says so, the panel shows it.
        await vault.fs.writeFile('journal.md', 'Today: [[index]]')
        await waitFor(() => names(rows(container, 'back')).includes('journal'), 3000)
    })

    it('opens a linking note at its link back, and creates a note not written yet', async () => {
        const { editor, vault, container } = await open('projects/plan.md')
        await waitFor(() => rows(container, 'back').length === 2, 3000)
        rows(container, 'back')[1].click()
        await waitFor(() => filepath(editor) === 'projects/roadmap.md', 3000)
        await waitFor(() => editor.state.selection.constructor.name === 'NodeSelection', 3000)
        expect((editor.state.selection as any).node.attrs.target).toBe('plan')

        await (editor.storage as any).persistence.loadFile('projects/plan.md')
        await waitFor(() => rows(container, 'dangling').length === 1, 3000)
        rows(container, 'dangling')[0].click()
        await waitFor(() => filepath(editor) === 'projects/ghost.md', 3000)
        expect(await vault.fs.exists('projects/ghost.md')).toBe(true)
    })

    it('works against any LinkIndex, not only a vault', async () => {
        const calls: string[] = []
        const index: LinkIndex = {
            backlinks: async (note) => {
                calls.push(`backlinks ${note}`)
                return [{ source: 'elsewhere/a.md', target: note, line: 4 }] satisfies LinkRef[]
            },
            unresolved: async () => [{ source: 'x.md', target: 'nowhere.md', line: 1 }],
            rename: async () => 0,
        }
        const fs = memoryVfs({ 'x.md': '# X' })
        const container = createTestContainer('lp-bare')
        const editor = createEditor({ element: container, fs: { fs, filepath: 'x.md' }, links: { index, panel: { open: true } } })
        created.push({ editor, container })
        await waitFor(() => rows(container, 'back').length === 1, 3000)
        expect(calls).toContain('backlinks x.md')
        expect(rows(container, 'back')[0].textContent).toContain('line 4')
        expect(names(rows(container, 'dangling'))).toEqual(['nowhere'])
    })

    it('shows nothing until asked for, and toggles with ⌘⇧L', async () => {
        const vault = await Vault.open(memoryVfs(FILES), { watch: false })
        const container = createTestContainer('lp-hidden')
        const calls: string[] = []
        const index: LinkIndex = {
            backlinks: async (p) => (calls.push(`backlinks:${p}`), vault.links.backlinks(p)),
            unresolved: async () => (calls.push('unresolved'), vault.links.unresolved()),
            rename: async () => 0,
        }
        const editor = createEditor({ element: container, fs: { fs: vault.fs, filepath: 'projects/plan.md', autoSave: true }, links: { resolver: vault.links, index } })
        created.push({ editor, container })
        await waitFor(() => editor.getText().length > 0, 3000)
        await new Promise((r) => setTimeout(r, 50))
        // Hidden, and the index has not been asked.
        expect(panel(container).hidden).toBe(true)
        expect(calls).toEqual([])
        editor.commands.toggleLinksPanel()
        await waitFor(() => rows(container, 'back').length === 2, 3000)
        expect(panel(container).hidden).toBe(false)
        editor.commands.focus()
        await userEvent.keyboard('{Control>}{Shift>}l{/Shift}{/Control}')
        await waitFor(() => panel(container).hidden, 2000)
    })

    it('is left out without an index, or when asked', () => {
        const a = createTestContainer('lp-none')
        const e1 = createEditor({ element: a, content: 'x' })
        created.push({ editor: e1, container: a })
        expect(panel(a)).toBeNull()
        const b = createTestContainer('lp-off')
        const e2 = createEditor({
            element: b,
            content: 'x',
            links: { index: { backlinks: async () => [], unresolved: async () => [], rename: async () => 0 }, panel: false },
        })
        created.push({ editor: e2, container: b })
        expect(panel(b)).toBeNull()
    })
})

describe('Renaming from the toolbar', () => {
    it('goes through the link index, so links to the note are rewritten', async () => {
        const { editor, vault, container } = await open('projects/plan.md')
        const input = container.querySelector('.cm-toolbar-input') as HTMLInputElement
        await userEvent.click(input)
        await userEvent.clear(input)
        await userEvent.type(input, 'projects/planning.md')
        const rename = () =>
            Array.from(container.querySelectorAll('.cm-search-result')).find((el) => el.textContent?.includes('Rename to')) as
                | HTMLElement
                | undefined
        await waitFor(() => !!rename(), 3000)
        rename()!.click()
        await waitFor(() => filepath(editor) === 'projects/planning.md', 3000)
        expect(await vault.fs.exists('projects/plan.md')).toBe(false)
        expect(await vault.fs.readFile('index.md')).toBe('# Index\n\nSee [[planning]].')
        expect(await vault.fs.readFile('projects/roadmap.md')).toContain('First [[planning]]')
        expect(editor.getText()).toContain('Back to')
    })
})
