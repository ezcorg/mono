import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { memoryVfs } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
import { createEditor, MarkdownEditor, MarkdownEditorOptions } from './index'
import { cleanupEditor, getMarkdownContent, waitFor } from '../../test/utils'
import type { CommentsStorage } from './extensions/comments'

/**
 * The README's "Keys", each pressed as a person presses it (`userEvent`'s
 * real keys through the browser) with Mod the platform's, ⌘ on a Mac and
 * Ctrl elsewhere, as ProseMirror's keymap resolves `Mod-`; and the effect
 * read from what shows, never from the command's return.
 */

const MOD = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? 'Meta' : 'Control'
/** `keys` with Mod held: `mod('{Shift>}e{/Shift}')` is ⌘⇧E on a Mac, Ctrl+Shift+E elsewhere. */
const mod = (keys: string) => `{${MOD}>}${keys}{/${MOD}}`

const created: Array<{ editor: MarkdownEditor; container: HTMLElement; vault: Vault }> = []
afterEach(() => {
    created.forEach(({ editor, container, vault }) => {
        cleanupEditor(editor, container)
        vault.close()
    })
    created.length = 0
    // The comments panel keeps its choice; not for the next test.
    for (const key of Object.keys(localStorage)) if (key.startsWith('ezco-mde-') || key.startsWith('ezco-settings:')) localStorage.removeItem(key)
})

const NOTE = '# Index\n\nStart here, then [[plan]] or [the plan](plan.md).\n\nA paragraph to comment on.\n'
const FILES: Record<string, string> = {
    'index.md': NOTE,
    'plan.md': '# Plan\n\nBack to [[index]].\n',
    'notes/animals.md': '# Animals\n\nThe quick brown fox.\n',
    // One comment on the note, so there is something for a panel to show.
    'comments/index/alice 2026-09-13 12.01.md': '![[index#:~:text=Start%20here]]\n\nFirst.\n',
}

/** An editor over a vault of a few notes, with every panel a key can ask for. */
async function open(options: Partial<MarkdownEditorOptions> = {}) {
    const vault = await Vault.open(memoryVfs(FILES), { watch: false, identity: 'theo' })
    const container = document.createElement('div')
    // Inside the 1280px viewport, and wide enough for a comments panel beside the note.
    container.style.cssText = 'width: 1200px; height: 700px; overflow-y: auto;'
    document.body.append(container)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: 'index.md', autoSave: false },
        links: { resolver: vault.links, index: vault.links },
        search: vault.search,
        files: vault.files,
        comments: { author: 'theo', index: vault.comments, reactions: vault.reactions },
        fileTree: {},
        ...options,
    })
    created.push({ editor, container, vault })
    await waitFor(() => editor.getText().includes('Start here'), 3000)
    // Tiptap mounts after a tick.
    await new Promise((r) => requestAnimationFrame(r))
    return { editor, container, vault }
}

/** Real focus in the note, on its heading (nothing there follows a click). */
const focusNote = async (container: HTMLElement) => {
    await userEvent.click(container.querySelector('.ezco-mde-body h1') as HTMLElement)
    await waitFor(() => document.activeElement === container.querySelector('.ProseMirror'), 2000)
}
const input = (c: HTMLElement) => c.querySelector('.cm-toolbar-input') as HTMLInputElement
const results = (c: HTMLElement) => [...c.querySelectorAll('.cm-search-result')] as HTMLElement[]
const filepath = (editor: MarkdownEditor) => (editor.storage as any).persistence.options.filepath as string | undefined
const posOf = (editor: MarkdownEditor, text: string) => {
    let from = -1
    editor.state.doc.descendants((node, pos) => {
        if (from < 0 && node.isText && node.text!.includes(text)) from = pos + node.text!.indexOf(text)
    })
    return { from, to: from + text.length }
}
/** The position just after the note's first wikilink. */
const afterWikilink = (editor: MarkdownEditor) => {
    let at = -1
    editor.state.doc.descendants((node, pos) => {
        if (at < 0 && node.type.name === 'wikilink') at = pos + node.nodeSize
    })
    return at
}
const wikilinks = (editor: MarkdownEditor) => editor.view.dom.querySelectorAll('.ezco-mde-wikilink').length

describe('The toolbar', () => {
    it('opens on ⌘P with nothing typed, and on ⇧⌘P with `>` before the editor’s commands', async () => {
        const { container } = await open()
        await focusNote(container)
        await userEvent.keyboard(mod('p'))
        expect(document.activeElement).toBe(input(container))
        expect(input(container).value).toBe('')
        // Then the commands, with focus back in the note first.
        await userEvent.keyboard('{Escape}')
        await focusNote(container)
        await userEvent.keyboard(mod('{Shift>}p{/Shift}'))
        expect(document.activeElement).toBe(input(container))
        expect(input(container).value).toBe('>')
        await waitFor(() => results(container).some((r) => r.textContent?.includes('> Callout')), 3000)
    })
})

describe('Typed triggers', () => {
    it('`/` opens the slash commands, `:` and two letters the emoji, `[[` the vault’s notes', async () => {
        const { editor, container } = await open()
        await focusNote(container)
        editor.commands.focus('end')
        // (`focus()` settles in the next frame.)
        await new Promise((r) => requestAnimationFrame(r))
        await userEvent.keyboard('{Enter}/')
        await waitFor(() => !!document.querySelector('.ezco-mde-slash-menu .ezco-mde-slash-item'), 2000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !document.querySelector('.ezco-mde-slash-menu'), 2000)
        await userEvent.keyboard(' :smi')
        await waitFor(() => document.querySelectorAll('.ezco-mde-emoji-cell').length > 0, 4000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => document.querySelectorAll('.ezco-mde-emoji-cell').length === 0, 2000)
        // (`[[` is user-event's escape for one `[`.)
        await userEvent.keyboard(' [[[[pl')
        const rows = () => [...document.querySelectorAll('.ezco-mde-wikilink-menu .ezco-mde-slash-item')] as HTMLElement[]
        await waitFor(() => rows().length > 0, 3000)
        expect(rows().map((r) => r.querySelector('.ezco-mde-slash-item-desc')?.textContent)).toContain('plan.md')
    })
})

describe('Links', () => {
    it('⌘Enter in a Markdown link’s text opens the note it links to', async () => {
        const { editor, container } = await open()
        await focusNote(container)
        editor.commands.setTextSelection(posOf(editor, 'the plan').from + 2)
        expect(editor.isActive('link')).toBe(true)
        await userEvent.keyboard(mod('{Enter}'))
        await waitFor(() => filepath(editor) === 'plan.md', 3000)
        await waitFor(() => editor.getText().includes('Back to'), 3000)
    })

    // Bug: StarterKit's HardBreak binds Mod-Enter too and, registered after the
    // syntax extensions (index.ts), runs first: ⌘Enter just after a wikilink
    // inserts a hard break instead of following it (a click still follows).
    it('⌘Enter just after a wikilink opens the note', async () => {
        const { editor, container } = await open()
        await focusNote(container)
        editor.commands.setTextSelection(afterWikilink(editor))
        await userEvent.keyboard(mod('{Enter}'))
        await waitFor(() => filepath(editor) === 'plan.md', 1500)
        expect(editor.getText()).toContain('Back to')
    })

    it('Backspace just after a wikilink gives its source back to edit', async () => {
        const { editor, container } = await open()
        await focusNote(container)
        expect(wikilinks(editor)).toBe(1)
        editor.commands.setTextSelection(afterWikilink(editor))
        await userEvent.keyboard('{Backspace}')
        await waitFor(() => wikilinks(editor) === 0, 2000)
        expect(editor.getText()).toContain('then [[plan] or')
        // The closing bracket typed makes it a link again.
        await userEvent.keyboard(']')
        await waitFor(() => wikilinks(editor) === 1, 2000)
        expect(getMarkdownContent(editor)).toContain('then [[plan]] or')
    })
})

describe('Panels', () => {
    it('⌘⇧E shows the file tree and Escape puts it away; ⌘⇧L the backlinks; ⌘⌥B folds the rail', async () => {
        const { editor, container } = await open({ sidebar: {} })
        const tree = container.querySelector('.ezco-mde-files') as HTMLElement
        const links = container.querySelector('.ezco-mde-links') as HTMLElement
        const rail = container.querySelector('.ezco-mde-rail') as HTMLElement
        expect(tree.hidden).toBe(true)
        expect(links.hidden).toBe(true)

        // The file tree: shown, with focus on a row; Escape closes it.
        await focusNote(container)
        await userEvent.keyboard(mod('{Shift>}e{/Shift}'))
        await waitFor(() => !tree.hidden, 2000)
        await waitFor(() => [...tree.querySelectorAll('.ezco-mde-files-item')].some((r) => (r as HTMLElement).dataset.path === 'index.md'), 3000)
        expect(getComputedStyle(tree).display).not.toBe('none')
        expect(tree.contains(document.activeElement)).toBe(true)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => tree.hidden, 2000)
        expect(editor.isFocused).toBe(true)
        // And hidden again by the key.
        await userEvent.keyboard(mod('{Shift>}e{/Shift}'))
        await waitFor(() => !tree.hidden, 2000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => tree.hidden, 2000)

        // The backlinks under the note: the plan links here (so does alice's comment).
        await focusNote(container)
        await userEvent.keyboard(mod('{Shift>}l{/Shift}'))
        await waitFor(() => !links.hidden, 2000)
        const back = () => [...links.querySelectorAll('.ezco-mde-links-list:not(.ezco-mde-links-dangling *) .ezco-mde-links-name')].map((n) => n.textContent)
        await waitFor(() => back().includes('plan'), 3000)
        expect(getComputedStyle(links).display).not.toBe('none')
        await focusNote(container)
        await userEvent.keyboard(mod('{Shift>}l{/Shift}'))
        await waitFor(() => links.hidden, 2000)

        // The rail (the outline, the file tree) folded to its chevron, and back.
        expect(rail.classList.contains('is-collapsed')).toBe(false)
        const wide = rail.getBoundingClientRect().width
        expect(wide).toBeGreaterThan(60)
        await focusNote(container)
        await userEvent.keyboard(mod('{Alt>}b{/Alt}'))
        await waitFor(() => rail.classList.contains('is-collapsed'), 2000)
        await waitFor(() => rail.getBoundingClientRect().width < 30, 2000)
        await focusNote(container)
        await userEvent.keyboard(mod('{Alt>}b{/Alt}'))
        await waitFor(() => !rail.classList.contains('is-collapsed'), 2000)
        await waitFor(() => rail.getBoundingClientRect().width === wide, 2000)
    })

    it('⌘⇧M puts the comments panel beside the note away, and brings it back', async () => {
        // No rail: room beside the note for the panel the host asked for.
        const { editor, container } = await open({ fileTree: undefined })
        await (editor.storage as any).settings.ready
        const comments = (editor.storage as any).comments as CommentsStorage
        await waitFor(() => comments.comments().length === 1, 5000)
        // The margin: beside the note in its container, or, floating, in its frame on the page.
        const margin = () =>
            (container.querySelector('.ezco-mde-comment-margin') ?? document.querySelector('.ezco-mde-comment-overlay-frame .ezco-mde-comment-margin')) as HTMLElement
        const card = () => margin().querySelector('.ezco-mde-comment-card') as HTMLElement | null
        await waitFor(() => margin().classList.contains('is-panel') && !!card() && !card()!.hidden, 3000)
        // In the column the editor made for it, right of the note.
        const column = container.querySelector('.ezco-mde-comments') as HTMLElement
        expect(column.contains(margin())).toBe(true)
        expect(column.getBoundingClientRect().width).toBeGreaterThan(200)
        await focusNote(container)
        await userEvent.keyboard(mod('{Shift>}m{/Shift}'))
        await waitFor(() => margin().classList.contains('is-floating'), 3000)
        // Put away: nothing shows beside the note (no comment is open), and
        // the column it had takes no room.
        await waitFor(() => margin().hidden, 2000)
        expect(column.contains(margin())).toBe(false)
        expect(column.getBoundingClientRect().width).toBe(0)
        await focusNote(container)
        await userEvent.keyboard(mod('{Shift>}m{/Shift}'))
        await waitFor(() => margin().classList.contains('is-panel') && !!card() && !card()!.hidden, 3000)
        await waitFor(() => column.contains(margin()), 2000)
        expect(column.getBoundingClientRect().width).toBeGreaterThan(200)
    })
})

describe('Comments', () => {
    it('⌘⌥M writes a comment on the selection, over the note by its text; Escape cancels it', async () => {
        const { editor, container } = await open()
        await focusNote(container)
        editor.commands.setTextSelection(posOf(editor, 'paragraph to comment'))
        await userEvent.keyboard(mod('{Alt>}m{/Alt}'))
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        const draft = container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement
        const over = draft.closest('.ezco-mde-comment-over') as HTMLElement | null
        expect(over).not.toBeNull()
        expect(over!.hidden).toBe(false)
        expect(container.querySelector('.ezco-mde-comment.is-draft')?.textContent).toBe('paragraph to comment')
        const field = draft.querySelector('.ezco-mde-comment-text') as HTMLElement
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !container.querySelector('.ezco-mde-comment-card.is-draft'), 2000)
    })
})

describe('Marks', () => {
    it('⌘B makes the selection bold, ⌘I italic', async () => {
        const { editor, container } = await open()
        await focusNote(container)
        editor.commands.setTextSelection(posOf(editor, 'Start here'))
        await userEvent.keyboard(mod('b'))
        await waitFor(() => getMarkdownContent(editor).includes('**Start here**'), 2000)
        expect(editor.isActive('bold')).toBe(true)
        await userEvent.keyboard(mod('i'))
        await waitFor(() => editor.isActive('italic'), 2000)
        expect(getMarkdownContent(editor)).toMatch(/[*_]\*\*Start here\*\*[*_]|\*\*[*_]Start here[*_]\*\*/)
    })
})
