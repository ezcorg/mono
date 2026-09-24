import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { Vault, memoryVfs } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

/** An editor with no vault: syntax only. */
function bare(content: string): MarkdownEditor {
    const container = createTestContainer(`wl-${created.length}`)
    const editor = createEditor({ element: container, content })
    created.push({ editor, container })
    return editor
}

/** An editor on `index.md` of an in-memory vault, links resolved by it. */
async function inVault(files: Record<string, string>, open = 'index.md') {
    const vault = await Vault.open(memoryVfs(files), { watch: false })
    const container = createTestContainer(`wlv-${created.length}`)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: open, autoSave: false },
        links: { resolver: vault.links },
    })
    created.push({ editor, container })
    await waitFor(() => editor.getText().includes(files[open].replace(/[#[\]]/g, '').trim().split('\n')[0].trim()), 3000)
    return { editor, vault, container }
}

const links = (editor: MarkdownEditor) =>
    Array.from(editor.view.dom.querySelectorAll('.ezco-mde-wikilink')) as HTMLElement[]
const filepath = (editor: MarkdownEditor) => (editor.storage as any).persistence.options.filepath as string

describe('Wikilink syntax', () => {
    const roundTrips = [
        'See [[note]] here.',
        'Aliased [[folder/Note Name|shown text]] and [[note#Heading]].',
        'Same note: [[#Heading]], block [[note#^abc-1]], quote [[Note#:~:text=brown%20fox]].',
        'Empty alias [[note|]] and two [[a]][[b]].',
        '**[[bold link]]** and *[[em|alias]]*',
        '* item with [[plan]]\n* another',
        '| a | b |\n| --- | --- |\n| [[x\\|y]] | [[z]] |\n\nAfter the table.',
    ]

    it.each(roundTrips)('round-trips %j byte for byte', (md) => {
        const editor = bare(md)
        expect(getMarkdownContent(editor)).toBe(md)
    })

    it('parses into wikilink nodes carrying target, fragment and alias as written', () => {
        const editor = bare('[[a/b#c|d]] and [[#top]]')
        const found: unknown[] = []
        editor.state.doc.descendants((node) => {
            if (node.type.name === 'wikilink') found.push(node.attrs)
        })
        expect(found).toEqual([
            { target: 'a/b', fragment: 'c', alias: 'd' },
            { target: '', fragment: 'top', alias: null },
        ])
        expect(links(editor).map((a) => a.textContent)).toEqual(['d', 'top'])
    })

    it('leaves escaped brackets, code and embeds alone', () => {
        const md = 'Not links: \\[\\[x\\]\\], `[[code]]`.'
        const editor = bare(md)
        expect(links(editor)).toHaveLength(0)
        expect(getMarkdownContent(editor)).toBe(md)
    })

    it('shows the target and fragment when there is no alias', () => {
        const editor = bare('[[plan#Goals]]')
        expect(links(editor)[0].textContent).toBe('plan › Goals')
    })
})

describe('Wikilinks in a vault', () => {
    const files = {
        'index.md': '# Index\n\nSee [[plan]], [[plan#Goals|goals]] and [[ghost]].\n\n## Later\n\nJump to [[#Later]].',
        'projects/plan.md': '# Plan\n\nIntro.\n\n## Goals\n\nShip it.',
    }

    it('marks a link to a missing note, and stops once the note exists', async () => {
        const { editor, vault } = await inVault(files)
        await waitFor(() => links(editor).some((a) => a.classList.contains('is-unresolved')), 2000)
        const byLabel = Object.fromEntries(links(editor).map((a) => [a.textContent, a]))
        expect(byLabel['plan'].classList.contains('is-unresolved')).toBe(false)
        expect(byLabel['plan'].getAttribute('data-path')).toBe('projects/plan.md')
        expect(byLabel['ghost'].classList.contains('is-unresolved')).toBe(true)
        await vault.fs.writeFile('ghost.md', '# Ghost')
        await waitFor(() => !byLabel['ghost'].isConnected || !links(editor).find((a) => a.textContent === 'ghost')!.classList.contains('is-unresolved'), 2000)
    })

    it('follows a click into the note, revealing the heading it names', async () => {
        const { editor } = await inVault(files)
        const goals = links(editor).find((a) => a.textContent === 'goals')!
        goals.click()
        await waitFor(() => filepath(editor) === 'projects/plan.md' && editor.getText().includes('Ship it'), 3000)
        const { $from } = editor.state.selection
        expect($from.parent.type.name).toBe('heading')
        expect($from.parent.textContent).toBe('Goals')
    })

    it('creates the note a dangling link names when it is followed', async () => {
        const { editor, vault } = await inVault(files)
        links(editor).find((a) => a.textContent === 'ghost')!.click()
        await waitFor(() => filepath(editor) === 'ghost.md', 3000)
        expect(await vault.fs.exists('ghost.md')).toBe(true)
        expect(vault.paths()).toContain('ghost.md')
    })

    it('reveals a heading in the same note', async () => {
        const { editor } = await inVault(files)
        editor.commands.setTextSelection(1)
        links(editor).find((a) => a.textContent === 'Later')!.click()
        await waitFor(() => editor.state.selection.$from.parent.textContent === 'Later', 2000)
        expect(filepath(editor)).toBe('index.md')
    })

    it('follows a Markdown link to a vault path in the editor, not a browser tab', async () => {
        const { editor } = await inVault({ 'index.md': '# Index\n\nThe [plan](projects/plan.md).', 'projects/plan.md': '# Plan' })
        let pos = 0
        editor.state.doc.descendants((node, p) => {
            if (node.isText && node.text === 'plan') pos = p + 1
        })
        editor.commands.setTextSelection(pos)
        const opened: string[] = []
        const original = window.open
        window.open = ((url?: string | URL) => {
            opened.push(String(url))
            return null
        }) as typeof window.open
        try {
            editor.commands.keyboardShortcut('Mod-Enter')
            await waitFor(() => filepath(editor) === 'projects/plan.md', 3000)
        } finally {
            window.open = original
        }
        expect(opened).toEqual([])
    })

    it('creates only notes from Markdown links: a bare web address opens the site, a missing file nothing', async () => {
        const { editor, vault } = await inVault({ 'index.md': '# Index\n\n[site](www.example.com), [doc](missing.pdf) and [new](new.md).' })
        const follow = async (text: string) => {
            let pos = 0
            editor.state.doc.descendants((node, p) => {
                if (node.isText && node.text === text) pos = p + 1
            })
            editor.commands.setTextSelection(pos)
            editor.commands.keyboardShortcut('Mod-Enter')
        }
        const opened: string[] = []
        const original = window.open
        window.open = ((url?: string | URL) => {
            opened.push(String(url))
            return null
        }) as typeof window.open
        try {
            await follow('site')
            await follow('doc')
            await new Promise((r) => setTimeout(r, 200))
            expect(opened).toEqual(['https://www.example.com'])
            expect(await vault.fs.exists('www.example.com')).toBe(false)
            expect(await vault.fs.exists('missing.pdf')).toBe(false)
            expect(filepath(editor)).toBe('index.md')
            await follow('new')
            await waitFor(() => filepath(editor) === 'new.md', 3000)
            expect(await vault.fs.exists('new.md')).toBe(true)
        } finally {
            window.open = original
        }
    })
})

describe('Editing wikilinks', () => {
    it('makes a link when `]]` closes one; Backspace at once undoes that, as for any input rule', async () => {
        const editor = bare('')
        await userEvent.click(editor.view.dom)
        await userEvent.keyboard('go [[[[plan#Goals|the goals]]')
        await waitFor(() => links(editor).length === 1, 2000)
        expect(getMarkdownContent(editor)).toBe('go [[plan#Goals|the goals]]')
        await userEvent.keyboard('{Backspace}')
        expect(links(editor)).toHaveLength(0)
        expect(editor.getText()).toBe('go [[plan#Goals|the goals]]')
    })

    it('turns a link back into its source on Backspace, and a typed `]` makes it a link again', async () => {
        const editor = bare('go [[plan|the plan]]')
        await userEvent.click(editor.view.dom)
        editor.commands.focus('end')
        await userEvent.keyboard('{Backspace}')
        expect(links(editor)).toHaveLength(0)
        expect(editor.getText()).toBe('go [[plan|the plan]')
        await userEvent.keyboard(']')
        await waitFor(() => links(editor).length === 1, 2000)
        expect(getMarkdownContent(editor)).toBe('go [[plan|the plan]]')
    })

    it('offers the vault’s notes after `[[`, and inserts the one chosen', async () => {
        const { editor } = await inVault({
            'index.md': '# Index',
            'projects/plan.md': '# Plan',
            'archive/2025/plan.md': '# Old plan',
        })
        await userEvent.click(editor.view.dom)
        editor.commands.focus('end')
        await userEvent.keyboard('{Enter}see [[[[pla')
        const rows = () => Array.from(document.querySelectorAll('.ezco-mde-wikilink-menu .ezco-mde-slash-item')) as HTMLElement[]
        await waitFor(() => rows().length >= 2, 3000)
        expect(rows().map((r) => r.querySelector('.ezco-mde-slash-item-desc')?.textContent)).toEqual([
            'projects/plan.md',
            'archive/2025/plan.md',
            'created when you follow the link',
        ])
        await userEvent.keyboard('{ArrowDown}{Enter}')
        await waitFor(() => links(editor).length === 1, 2000)
        const md = getMarkdownContent(editor)
        expect(md).toMatch(/\nsee \[\[2025\/plan\]\]$/)
        expect(md).not.toContain('[[pla\n')
    })
})
