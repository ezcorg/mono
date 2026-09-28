import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { Vault, memoryVfs } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { cleanupEditor, waitFor } from '../../../test/utils'
import { authorOf, type CommentsStorage } from './comments'

/**
 * Comments in a real browser: measured boxes, so a card that drifts from
 * its text or covers another is caught; real keys into the composers.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement; vault: Vault }> = []
afterEach(() => {
    created.forEach(({ editor, container, vault }) => {
        cleanupEditor(editor, container)
        vault.close()
    })
    created.length = 0
    for (const key of Object.keys(localStorage)) if (key.startsWith('ezco-mde-')) localStorage.removeItem(key)
})

const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} says something worth a comment, number ${i + 1}.`)
const NOTE = ['# Review', ...paragraphs].join('\n\n') + '\n'
const comment = (author: string, minute: string, quote: string, body: string) => [`comments/Review/${author} 2026-09-13 12.${minute}.md`, `![[Review#:~:text=${encodeURIComponent(quote)}]]\n\n${body}\n`] as const
const FILES: Record<string, string> = Object.fromEntries([
    ['Review.md', NOTE],
    comment('alice', '01', 'Paragraph 2 says', 'First.'),
    // Two comments on the same line: the second must go below the first.
    comment('alice', '02', 'worth a comment, number 3', 'Second, a longer comment that wraps onto a few lines in the margin to take room.'),
    comment('alice', '03', 'Paragraph 3 says', 'Third, same line.'),
    comment('alice', '04', 'Paragraph 10 says', 'Done already.'),
    ['comments/Review/bob 2026-09-13 12.05.md', '![[comments/Review/alice 2026-09-13 12.02#:~:text=a%20longer%20comment]]\n\nA reply.\n'],
    ['comments/Review/carol 2026-09-13 12.06.md', '![[comments/Review/bob 2026-09-13 12.05#:~:text=A%20reply.]]\n\nAnd one to that.\n'],
])

type Layout = 'float' | 'column'

async function open(width: number, layout: Layout, files = FILES, author: string | null = 'theo') {
    const vault = await Vault.open(memoryVfs(files), { watch: false, identity: author ?? undefined })
    // Alice's fourth is resolved (by theo, whoever is looking).
    const resolver = author === 'theo' ? vault : await Vault.open(vault.fs, { watch: false, identity: 'theo' })
    await resolver.reactions.toggle({ doc: 'comments/Review/alice 2026-09-13 12.04.md', ref: 'Review#:~:text=Paragraph%2010%20says' }, '✅')
    if (resolver !== vault) resolver.close()
    const container = document.createElement('div')
    container.style.cssText = `width: ${width}px; height: 700px; overflow-y: auto;`
    document.body.append(container)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: 'Review.md', autoSave: true },
        links: { resolver: vault.links, index: vault.links },
        search: vault.search,
        files: vault.files,
        comments: { author: author ?? undefined, index: vault.comments, reactions: vault.reactions, margin: { layout } },
    })
    created.push({ editor, container, vault })
    const comments = (editor.storage as any).comments as CommentsStorage
    // Every comment on the note (the documents referencing it), at its text.
    const expected = Object.values(files).filter((text) => text.startsWith('![[Review#')).length
    await waitFor(() => comments.comments().length === expected && comments.comments().every((c) => c.target.range !== null), 5000)
    await waitFor(() => comments.comments().some((c) => c.resolved), 3000)
    await frames()
    return { editor, container, comments, vault }
}

const frames = async (n = 3) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r))
    const moving = [...document.querySelectorAll('.ezco-mde-comment-card')].flatMap((c) => c.getAnimations())
    await Promise.all(moving.map((a) => a.finished.catch(() => {})))
}
const margin = (c: HTMLElement) => c.querySelector('.ezco-mde-comment-margin') as HTMLElement
const idOf = (comments: CommentsStorage, body: string) => comments.comments().find((c) => c.body === body)!.id
const card = (c: HTMLElement, id: string) => c.querySelector(`.ezco-mde-comment-card[data-comment="${id}"]`) as HTMLElement
const visibleCards = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.ezco-mde-comment-card')].filter((e) => !e.hidden && !margin(c).hidden)
const anchorTop = (editor: MarkdownEditor, comments: CommentsStorage, id: string) => editor.view.coordsAtPos(comments.comments().find((c) => c.id === id)!.anchor!).top
const overlap = (a: DOMRect, b: DOMRect) => a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
const tool = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent === label) as HTMLButtonElement
const messageOf = (el: HTMLElement, id: string) => el.querySelector(`.ezco-mde-comment-message[data-comment="${id}"]`) as HTMLElement
const composerIn = (message: HTMLElement) =>
    message.querySelector(':scope > .ezco-mde-comment-thread > .ezco-mde-comment-composer .ezco-mde-comment-text, :scope > .ezco-mde-comment-bubble > .ezco-mde-comment-composer .ezco-mde-comment-text') as HTMLElement | null
/** Choose `label` from a message's "…" menu. */
const viaMenu = async (message: HTMLElement, label: string) => {
    tool(message, 'More').click()
    await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu'), 2000)
    const item = [...document.querySelectorAll<HTMLElement>('.ezco-mde-comment-menu .ezco-mde-context-menu-item')].find((b) => b.textContent?.trim() === label)
    if (!item) throw new Error(`No "${label}" in the menu: ${[...document.querySelectorAll('.ezco-mde-comment-menu .ezco-mde-context-menu-item')].map((b) => b.textContent).join(', ')}`)
    item.click()
    await waitFor(() => !document.querySelector('.ezco-mde-comment-menu'), 2000)
}
const menuLabels = async (message: HTMLElement) => {
    tool(message, 'More').click()
    await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu'), 2000)
    const labels = [...document.querySelectorAll<HTMLElement>('.ezco-mde-comment-menu .ezco-mde-context-menu-item')].map((b) => b.textContent?.trim())
    await userEvent.keyboard('{Escape}')
    await waitFor(() => !document.querySelector('.ezco-mde-comment-menu'), 2000)
    return labels
}
const clickText = async (editor: MarkdownEditor, comments: CommentsStorage, id: string) => {
    const r = comments.comments().find((c) => c.id === id)!.target.range!
    const at = editor.view.coordsAtPos(r.from + 2)
    const box = editor.view.dom.getBoundingClientRect()
    await userEvent.click(editor.view.dom, { position: { x: at.left - box.left, y: at.top - box.top + 4 } })
}
async function write(field: HTMLElement, text: string) {
    await waitFor(() => document.activeElement === field, 2000)
    await userEvent.keyboard(text)
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
}

describe('Comments float over the note', () => {
    it('show nothing until commented text is clicked, then the one comment by its text, and close on Escape', async () => {
        const { editor, container, comments } = await open(900, 'float')
        expect(container.querySelector('.ezco-mde-comments')).toBeNull()
        expect(margin(container).hidden).toBe(true)
        expect(visibleCards(container)).toEqual([])
        const noteWidth = editor.view.dom.getBoundingClientRect().width
        expect(noteWidth).toBeGreaterThan(700)

        const second = idOf(comments, 'Second, a longer comment that wraps onto a few lines in the margin to take room.')
        await clickText(editor, comments, second)
        await waitFor(() => comments.active() === second, 2000)
        await waitFor(() => visibleCards(container).length === 1, 2000)
        await frames()
        const box = visibleCards(container)[0].getBoundingClientRect()
        const text = comments.comments().find((c) => c.id === second)!.target.range!
        const end = editor.view.coordsAtPos(text.to, -1).bottom
        expect(box.top).toBeGreaterThanOrEqual(end)
        expect(box.top - end).toBeLessThan(12)
        expect(box.right).toBeLessThanOrEqual(container.getBoundingClientRect().right)
        expect(editor.view.dom.getBoundingClientRect().width).toBe(noteWidth)
        // Over the note, the chrome's shadow lifts it off the text.
        expect(getComputedStyle(visibleCards(container)[0]).boxShadow).not.toBe('none')
        // The comment alone, who and when over it; its replies behind their count.
        expect(visibleCards(container)[0].querySelectorAll('.ezco-mde-comment-message').length).toBe(1)
        expect(visibleCards(container)[0].querySelector('.ezco-mde-comment-author')?.textContent).toBe('@alice')
        expect(tool(visibleCards(container)[0], 'Show 2 replies').textContent).toBe('2')
        tool(visibleCards(container)[0], 'Show 2 replies').click()
        await waitFor(() => visibleCards(container)[0].querySelectorAll('.ezco-mde-comment-message').length === 3, 2000)
        // The thread nests: carol's answer under bob's, which folds it.
        const bob = comments.comments().find((c) => c.id === second)!.replies[0].id
        expect(messageOf(visibleCards(container)[0], bob).querySelector('.ezco-mde-comment-message')?.querySelector('.ezco-mde-comment-author')?.textContent).toBe('@carol')
        tool(visibleCards(container)[0], 'Hide replies').click()
        await waitFor(() => visibleCards(container)[0].querySelectorAll('.ezco-mde-comment-message').length === 1, 2000)

        visibleCards(container)[0].focus()
        await userEvent.keyboard('{Escape}')
        await waitFor(() => comments.active() === null, 2000)
        expect(margin(container).hidden).toBe(true)
        expect(editor.isFocused).toBe(true)
    })

    it('keeps a resolved comment findable in the note, and reopens it', async () => {
        const { editor, container, comments } = await open(900, 'float')
        const done = idOf(comments, 'Done already.')
        expect(editor.view.dom.querySelector('.ezco-mde-comment.is-resolved')?.textContent).toBe('Paragraph 10 says')
        editor.commands.focusComment(done)
        await waitFor(() => !!card(container, done), 2000)
        expect(card(container, done).textContent).toContain('Resolved')
        await viaMenu(messageOf(card(container, done), done), 'Reopen')
        await waitFor(() => !comments.comments().find((c) => c.id === done)!.resolved, 3000)
    })

    it('floats above code blocks’ toolbars, as the selection menu does', async () => {
        const { container } = await open(900, 'float')
        expect(Number(getComputedStyle(margin(container)).zIndex)).toBeGreaterThan(401)
        expect(Number(getComputedStyle(container.querySelector('.ezco-mde-selection-menu-btn') as HTMLElement).zIndex)).toBeGreaterThan(401)
    })

    it('tells overlapping comments apart, and looks at each in turn when their overlap is clicked', async () => {
        const files = { ...FILES, ...Object.fromEntries([comment('dave', '07', 'Paragraph 2 says something', 'Overlapping.')]) }
        const { editor, container, comments } = await open(900, 'float', files)
        await waitFor(() => comments.comments().length === 5, 3000)
        const overlap = editor.view.dom.querySelector('.ezco-mde-comment-stack') as HTMLElement
        expect(overlap?.textContent).toBe('Paragraph 2 says')
        const narrow = idOf(comments, 'First.')
        const wide = idOf(comments, 'Overlapping.')
        // The narrowest first, then the next, then round again.
        const at = overlap.getBoundingClientRect()
        const box = editor.view.dom.getBoundingClientRect()
        // Clicks apart in time: two in quick succession are a double click.
        const click = async () => {
            await new Promise((r) => setTimeout(r, 600))
            await userEvent.click(editor.view.dom, { position: { x: at.left - box.left + at.width / 2, y: at.top - box.top + at.height / 2 } })
        }
        await click()
        await waitFor(() => comments.active() === narrow, 2000)
        await click()
        await waitFor(() => comments.active() === wide, 2000)
        await click()
        await waitFor(() => comments.active() === narrow, 2000)
        void container
    })

    it('puts a comment on the whole of a document at its top, without highlighting it all', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        // A reply's document: the answer to it quotes the whole of its text.
        await (editor.storage as any).persistence.loadFile('comments/Review/bob 2026-09-13 12.05.md')
        await waitFor(() => comments.comments().length === 1 && comments.comments()[0].author === 'carol', 4000)
        expect(comments.comments()[0].target.whole).toBe(true)
        expect(editor.view.dom.querySelector('.ezco-mde-comment')).toBeNull()
        const carol = comments.comments()[0].id
        await waitFor(() => !!card(container, carol) && card(container, carol).style.top === '0px', 3000)
    })
})

describe('A column of comments', () => {
    it('puts each card level with its text, none over another', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        await waitFor(() => [...container.querySelectorAll<HTMLElement>('.ezco-mde-comment-card')].filter((c) => c.style.top !== '').length === 3, 3000)
        const cards = visibleCards(container)
        expect(cards.map((c) => comments.comments().find((x) => x.id === c.dataset.comment)!.body)).toEqual(['First.', 'Second, a longer comment that wraps onto a few lines in the margin to take room.', 'Third, same line.'])
        expect(Math.abs(cards[0].getBoundingClientRect().top - anchorTop(editor, comments, cards[0].dataset.comment!))).toBeLessThan(2)
        for (const c of cards.slice(1)) expect(c.getBoundingClientRect().top).toBeGreaterThanOrEqual(anchorTop(editor, comments, c.dataset.comment!) - 1)
        const boxes = cards.map((c) => c.getBoundingClientRect())
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false)
        expect(container.querySelector('.ezco-mde-comments .ezco-mde-comment-margin')).not.toBeNull()
        const body = editor.view.dom.getBoundingClientRect()
        for (const b of boxes) expect(b.left).toBeGreaterThanOrEqual(body.right - 1)
    })

    it('brings the card being looked at to its text, the others out of its way', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        const third = idOf(comments, 'Third, same line.')
        await clickText(editor, comments, third)
        await waitFor(() => comments.active() === third, 2000)
        await waitFor(() => Math.abs(card(container, third).getBoundingClientRect().top - anchorTop(editor, comments, third)) < 2, 2000)
        expect(card(container, third).classList.contains('is-active')).toBe(true)
        expect(container.querySelector('.ezco-mde-comment.is-active')?.textContent).toBe('Paragraph 3 says')
        const boxes = visibleCards(container).map((c) => c.getBoundingClientRect())
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false)
    })

    it('folds resolved comments away until asked for', async () => {
        const { container, comments } = await open(1100, 'column')
        const done = idOf(comments, 'Done already.')
        expect(card(container, done)).toBeNull()
        tool(container, 'Show resolved (1)').click()
        await waitFor(() => !!card(container, done), 2000)
        expect(card(container, done).classList.contains('is-resolved')).toBe(true)
    })

    it('floats after all where there is no room beside the note', async () => {
        const { editor, container, comments } = await open(560, 'column')
        await waitFor(() => margin(container).classList.contains('is-floating'), 2000)
        await frames()
        expect(editor.view.dom.getBoundingClientRect().width).toBeGreaterThan(400)
        expect(visibleCards(container)).toEqual([])
        editor.commands.focusComment(idOf(comments, 'First.'))
        await waitFor(() => visibleCards(container).length === 1, 2000)
    })
})

describe('Writing', () => {
    it('writes a new comment from the selection as a document, typed as in the note', async () => {
        const { editor, container, comments, vault } = await open(1100, 'float')
        let from = -1
        editor.state.doc.descendants((node, pos) => {
            if (from < 0 && node.isText && node.text!.includes('number 5')) from = pos + node.text!.indexOf('number 5')
        })
        editor.commands.setTextSelection({ from, to: from + 'number 5'.length })
        editor.commands.startComment()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        const field = container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text') as HTMLElement
        expect(field.classList.contains('ezco-mde-body')).toBe(true)
        expect(container.querySelector('.ezco-mde-comment.is-draft')?.textContent).toBe('number 5')
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard('Which *five*? ')
        await waitFor(() => !!field.querySelector('em'), 2000)
        // The text is rendered at one size, written or shown.
        const typedSize = getComputedStyle(field).fontSize
        await userEvent.keyboard('{Control>}{Enter}{/Control}')
        await waitFor(() => comments.comments().length === 5, 4000)
        const mine = comments.comments().find((c) => c.author === 'theo')!
        expect(mine.body).toBe('Which *five*?')
        expect(await vault.fs.readFile(mine.ref.source)).toBe('![[Review#:~:text=number%205]]\n\nWhich *five*?\n')
        editor.commands.focusComment(mine.id)
        await waitFor(() => !!card(container, mine.id), 2000)
        const shown = card(container, mine.id).querySelector('.ezco-mde-comment-body') as HTMLElement
        expect(shown.querySelector('em')?.textContent).toBe('five')
        expect(getComputedStyle(shown).fontSize).toBe(typedSize)
    })

    it('writes a reply under its comment, keeps the draft, and closes on Cancel', async () => {
        const { editor, container, comments } = await open(900, 'float')
        const first = idOf(comments, 'First.')
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        expect(card(container, first).querySelector('.ezco-mde-comment-composer')).toBeNull()
        // With nothing to unfold, the count is where a reply starts.
        expect(tool(messageOf(card(container, first), first), 'Reply').textContent).toBe('0')
        tool(messageOf(card(container, first), first), 'Reply').click()
        await waitFor(() => !!composerIn(messageOf(card(container, first), first)), 2000)
        const field = composerIn(messageOf(card(container, first), first))!
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard('Half a thought')
        await waitFor(() => localStorage.getItem(`ezco-mde-comment-draft:Review.md:${first}:reply`) === 'Half a thought', 2000)
        tool(card(container, first).querySelector('.ezco-mde-comment-composer') as HTMLElement, 'Cancel').click()
        await waitFor(() => comments.active() === null, 2000)
        expect(margin(container).hidden).toBe(true)
        await waitFor(() => editor.isFocused, 2000)
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        await viaMenu(messageOf(card(container, first), first), 'Reply')
        await waitFor(() => composerIn(messageOf(card(container, first), first))?.textContent === 'Half a thought', 2000)
        await write(composerIn(messageOf(card(container, first), first))!, ' and the rest.')
        await waitFor(() => comments.comments().find((c) => c.id === first)!.replies.length === 1, 4000)
        expect(comments.comments().find((c) => c.id === first)!.replies[0].body).toBe('Half a thought and the rest.')
        expect(localStorage.getItem(`ezco-mde-comment-draft:Review.md:${first}:reply`)).toBeNull()
        // The thread stays open on the reply, with the field for the next.
        await waitFor(() => !!messageOf(card(container, first), comments.comments().find((c) => c.id === first)!.replies[0].id), 2000)
        expect(tool(card(container, first), 'Reply').textContent).toBe('Reply…')
    })

    it('opens a reply’s document in the editor, with the draft, from the composer', async () => {
        const { editor, container, comments } = await open(900, 'float')
        const first = idOf(comments, 'First.')
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        tool(messageOf(card(container, first), first), 'Reply').click()
        await waitFor(() => document.activeElement === composerIn(messageOf(card(container, first), first)), 2000)
        await userEvent.keyboard('Started here')
        tool(card(container, first), 'Open in editor').click()
        await waitFor(() => /^comments\/Review\/theo /.test((editor.storage as any).persistence.options.filepath ?? ''), 4000)
        await waitFor(() => editor.getText().includes('Started here'), 3000)
        // The reference at the top quotes what it answers, and opens the note there.
        await waitFor(() => !!editor.view.dom.querySelector('.ezco-mde-embed--passage'), 3000)
        expect(editor.view.dom.querySelector('.ezco-mde-embed--passage .ezco-mde-embed-content')?.textContent?.trim()).toBe('First.')
        ;(editor.view.dom.querySelector('.ezco-mde-embed--passage .ezco-mde-embed-open') as HTMLElement).click()
        await waitFor(() => (editor.storage as any).persistence.options.filepath === 'comments/Review/alice 2026-09-13 12.01.md', 4000)
    })

    it('reacts through the quick row and the full grid, resolves and closes, and shows the four most given reactions', async () => {
        const { editor, container, comments, vault } = await open(1100, 'column')
        const third = idOf(comments, 'Third, same line.')
        editor.commands.focusComment(third)
        await waitFor(() => card(container, third)?.classList.contains('is-active'), 2000)
        tool(messageOf(card(container, third), third), 'React').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-reactions'), 2000)
        const quick = [...document.querySelectorAll<HTMLElement>('.ezco-mde-reactions .ezco-mde-emoji-cell')].map((c) => c.textContent)
        expect(quick.slice(0, 8)).toEqual(['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'])
        tool(document.querySelector('.ezco-mde-reactions') as HTMLElement, 'React 👍').click()
        await waitFor(() => !!card(container, third).querySelector('.ezco-mde-comment-reaction'), 3000)
        expect(card(container, third).querySelector('.ezco-mde-comment-reaction')?.textContent).toBe('👍 1')
        expect(card(container, third).querySelector('.ezco-mde-comment-reaction')?.getAttribute('aria-pressed')).toBe('true')
        // The full grid opens on the recent row, then the first category, never blank.
        tool(messageOf(card(container, third), third), 'React').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-reactions'), 2000)
        tool(document.querySelector('.ezco-mde-reactions') as HTMLElement, 'More emoji').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-emoji-grid .ezco-mde-emoji-cell'), 3000)
        expect(document.querySelector('.ezco-mde-emoji-heading')?.textContent).toBe('Recent')
        expect(document.querySelector('.ezco-mde-emoji-row .ezco-mde-emoji-cell')?.textContent).toBe('👍')
        expect(document.querySelector('.ezco-mde-emoji-grid .ezco-mde-emoji-cell')?.textContent).toBe('😀')
        // One cell lit at a time, the pointer moving the light.
        const cells = [...document.querySelectorAll<HTMLElement>('.ezco-mde-emoji-grid .ezco-mde-emoji-cell')]
        cells[3].dispatchEvent(new MouseEvent('mouseenter'))
        expect(document.querySelectorAll('.ezco-mde-emoji-cell.is-selected').length).toBe(1)
        expect(cells[3].classList.contains('is-selected')).toBe(true)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !document.querySelector('.ezco-mde-emoji-menu'), 2000)
        // Others' reactions, the four most given shown.
        for (const [by, emoji] of [['a', '🎉'], ['b', '🎉'], ['c', '❤️'], ['d', '🚀'], ['e', '👀']]) {
            const other = await Vault.open(vault.fs, { watch: false, identity: by })
            await other.reactions.toggle({ doc: 'comments/Review/alice 2026-09-13 12.03.md', ref: 'Review#:~:text=Paragraph%203%20says' }, emoji)
            other.close()
        }
        await (editor.storage as any).comments.refresh()
        await waitFor(() => comments.comments().find((c) => c.id === third)!.reactions.length === 6, 4000)
        const chips = () => [...card(container, third).querySelectorAll<HTMLElement>('.ezco-mde-comment-reaction')].map((c) => c.textContent)
        // The most given first, then three of the singles, the rest behind +2.
        expect(chips()[0]).toBe('🎉 2')
        expect(chips().length).toBe(4)
        expect(chips()[3]).toBe('+2')
        tool(card(container, third), 'Show all 5 reactions').click()
        await waitFor(() => chips().length === 6, 2000)
        // Resolving closes the card.
        await viaMenu(messageOf(card(container, third), third), 'Resolve')
        await waitFor(() => comments.comments().find((c) => c.id === third)!.resolved, 3000)
        expect(comments.active()).toBeNull()
    })

    it('edits a comment where it is, and deletes one after asking', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        const second = idOf(comments, 'Second, a longer comment that wraps onto a few lines in the margin to take room.')
        const bob = comments.comments().find((c) => c.id === second)!.replies[0].id
        editor.commands.focusComment(second)
        await waitFor(() => card(container, second).classList.contains('is-active'), 2000)
        tool(card(container, second), 'Show 2 replies').click()
        await waitFor(() => !!messageOf(card(container, second), bob), 2000)
        await viaMenu(messageOf(card(container, second), bob), 'Edit')
        await waitFor(() => !!composerIn(messageOf(card(container, second), bob)), 2000)
        expect(messageOf(card(container, second), bob).querySelector(':scope > .ezco-mde-comment-bubble > .ezco-mde-comment-body')).toBeNull()
        const field = composerIn(messageOf(card(container, second), bob))!
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard(' Edited.')
        await userEvent.keyboard('{Control>}{Enter}{/Control}')
        await waitFor(() => comments.comments().find((c) => c.id === second)!.replies[0].body === 'A reply. Edited.', 4000)
        // Carol's answer to bob goes (nobody answered it).
        const carol = comments.comments().find((c) => c.id === second)!.replies[0].replies[0].id
        await viaMenu(messageOf(card(container, second), carol), 'Delete')
        await waitFor(() => !!tool(messageOf(card(container, second), carol), 'Delete this comment'), 2000)
        tool(messageOf(card(container, second), carol), 'Delete this comment').click()
        await waitFor(() => comments.comments().find((c) => c.id === second)!.replies[0].replies.length === 0, 4000)
        // Bob's, answered before: only a tombstone now.
        await viaMenu(messageOf(card(container, second), second), 'Delete')
        await waitFor(() => !!tool(messageOf(card(container, second), second), 'Delete this comment'), 2000)
        tool(messageOf(card(container, second), second), 'Delete this comment').click()
        await waitFor(() => comments.comments().find((c) => c.id === second)?.body === '[deleted]', 4000)
        expect(messageOf(card(container, second), second).classList.contains('is-deleted')).toBe(true)
    })

    it('unfolds a comment’s replies on their count, and folds a reply’s answers as a news site does', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        const second = idOf(comments, 'Second, a longer comment that wraps onto a few lines in the margin to take room.')
        const bob = comments.comments().find((c) => c.id === second)!.replies[0].id
        const carol = comments.comments().find((c) => c.id === second)!.replies[0].replies[0].id
        editor.commands.focusComment(second)
        await waitFor(() => !!card(container, second), 2000)
        expect(messageOf(card(container, second), bob)).toBeNull()
        tool(card(container, second), 'Show 2 replies').click()
        await waitFor(() => !!messageOf(card(container, second), carol), 2000)
        // [–] folds carol's answer under bob's; [+] brings it back.
        expect(tool(messageOf(card(container, second), bob), 'Fold answers').textContent).toBe('[–]')
        tool(messageOf(card(container, second), bob), 'Fold answers').click()
        await waitFor(() => messageOf(card(container, second), carol) === null, 2000)
        expect(tool(messageOf(card(container, second), bob), 'Show 1 answer').textContent).toBe('[+]')
        tool(messageOf(card(container, second), bob), 'Show 1 answer').click()
        await waitFor(() => messageOf(card(container, second), carol) !== null, 2000)
        tool(card(container, second), 'Hide replies').click()
        await waitFor(() => messageOf(card(container, second), bob) === null, 2000)
    })

    it('offers nothing to write or react with without an author', async () => {
        const { container, comments } = await open(1100, 'column', FILES, null)
        const first = idOf(comments, 'First.')
        expect([...card(container, first).querySelectorAll('.ezco-mde-comment-action')].map((b) => b.getAttribute('aria-label'))).toEqual(['No replies', 'More'])
        expect(await menuLabels(messageOf(card(container, first), first))).toEqual(['Open document'])
    })

    it('keeps a comment as a draft, answers it with one, and publishes them together', async () => {
        const { editor, container, comments, vault } = await open(900, 'float')
        let from = -1
        editor.state.doc.descendants((node, pos) => {
            if (from < 0 && node.isText && node.text!.includes('number 8')) from = pos + node.text!.indexOf('number 8')
        })
        editor.commands.setTextSelection({ from, to: from + 'number 8'.length })
        editor.commands.startComment()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        // The composer stands at the end of the text it is about.
        await frames()
        const composer = container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement
        const end = editor.view.coordsAtPos(from + 'number 8'.length, -1)
        expect(Math.abs(composer.getBoundingClientRect().left - end.left)).toBeLessThan(2)
        expect(composer.getBoundingClientRect().top).toBeGreaterThanOrEqual(end.bottom)
        const field = container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text') as HTMLElement
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard('Not yet.')
        tool(composer, 'Draft').click()
        await waitFor(() => comments.drafts().length === 1, 3000)
        // Only this browser has it: marked so in the note and on its card, counted in the bar.
        expect(editor.view.dom.querySelector('.ezco-mde-comment.is-pending')?.textContent).toBe('number 8')
        expect(comments.comments().filter((c) => c.author === 'theo' && c.ref.source === '').length).toBe(1)
        const bar = container.querySelector('.ezco-mde-comment-drafts') as HTMLElement
        expect(bar.hidden).toBe(false)
        expect(bar.textContent).toContain('1 draft')
        const draft = comments.drafts()[0].id
        editor.commands.focusComment(draft)
        await waitFor(() => !!card(container, draft), 2000)
        expect(card(container, draft).querySelector('.ezco-mde-comment-status')?.textContent).toBe('Draft')
        expect(await menuLabels(messageOf(card(container, draft), draft))).toEqual(['Reply', 'Edit', 'Publish draft', 'Discard draft'])
        // An answer to a draft is a draft too.
        tool(messageOf(card(container, draft), draft), 'Reply').click()
        await waitFor(() => !!composerIn(messageOf(card(container, draft), draft)), 2000)
        await write(composerIn(messageOf(card(container, draft), draft))!, 'Nor this.')
        await waitFor(() => comments.drafts().length === 2, 3000)
        expect(comments.comments().find((c) => c.id === draft)!.replies[0].draft).toBe(true)
        expect(bar.textContent).toContain('2 drafts')
        // Published together: two documents, the reply referencing the comment's text.
        tool(bar, 'Publish every draft').click()
        await waitFor(() => comments.drafts().length === 0 && comments.comments().some((c) => c.body === 'Not yet.' && c.ref.source !== ''), 5000)
        const mine = comments.comments().find((c) => c.body === 'Not yet.')!
        expect(await vault.fs.readFile(mine.ref.source)).toBe('![[Review#:~:text=number%208]]\n\nNot yet.\n')
        await waitFor(() => comments.comments().find((c) => c.body === 'Not yet.')!.replies.length === 1, 4000)
        const reply = comments.comments().find((c) => c.body === 'Not yet.')!.replies[0]
        expect(reply.body).toBe('Nor this.')
        expect(reply.ref.link.fragment).toBe(':~:text=Not%20yet.')
        expect(bar.hidden).toBe(true)
        expect(editor.view.dom.querySelector('.ezco-mde-comment.is-pending')).toBeNull()
        expect(localStorage.getItem('ezco-mde-comment-queue:Review.md')).toBeNull()
    })

    it('discards drafts, after asking', async () => {
        const { editor, container, comments } = await open(900, 'float')
        editor.commands.setTextSelection({ from: 2, to: 8 })
        expect(editor.commands.addComment({ body: 'Gone soon.', draft: true })).toBe(true)
        await waitFor(() => comments.drafts().length === 1, 3000)
        const bar = container.querySelector('.ezco-mde-comment-drafts') as HTMLElement
        tool(bar, 'Discard every draft').click()
        await waitFor(() => bar.textContent?.includes('Discard them?'), 2000)
        tool(bar, 'Keep them').click()
        await waitFor(() => !bar.textContent?.includes('Discard them?'), 2000)
        expect(comments.drafts().length).toBe(1)
        tool(bar, 'Discard every draft').click()
        await waitFor(() => bar.textContent?.includes('Discard them?'), 2000)
        tool(bar, 'Discard every draft').click()
        await waitFor(() => comments.drafts().length === 0, 3000)
        expect(bar.hidden).toBe(true)
    })

    it('opens an unwritten comment in the editor with somewhere to write, and looks at it on the way back', async () => {
        const { editor, container, comments, vault } = await open(900, 'float')
        let from = -1
        editor.state.doc.descendants((node, pos) => {
            if (from < 0 && node.isText && node.text!.includes('number 7')) from = pos + node.text!.indexOf('number 7')
        })
        editor.commands.setTextSelection({ from, to: from + 'number 7'.length })
        editor.commands.startComment()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        // Nothing typed yet: the corner glyph opens the document in the editor.
        tool(container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement, 'Open in editor').click()
        await waitFor(() => /^comments\/Review\/theo /.test((editor.storage as any).persistence.options.filepath ?? ''), 4000)
        const path = (editor.storage as any).persistence.options.filepath as string
        // The caret is in a paragraph of its own under the reference, ready for the text.
        await waitFor(() => editor.isFocused && editor.state.selection.$from.parent === editor.state.doc.lastChild, 2000)
        expect(editor.state.doc.childCount).toBe(2)
        expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe('embed')
        await userEvent.keyboard('Written in the editor itself.')
        await (editor.storage as any).persistence.flushPendingSave()
        expect(await vault.fs.readFile(path)).toContain('![[Review#:~:text=number%207]]\n\nWritten in the editor itself.')
        // Back by the reference at the top: the note, with the comment looked at.
        await waitFor(() => !!editor.view.dom.querySelector('.ezco-mde-embed--passage .ezco-mde-embed-open'), 3000)
        ;(editor.view.dom.querySelector('.ezco-mde-embed--passage .ezco-mde-embed-open') as HTMLElement).click()
        await waitFor(() => (editor.storage as any).persistence.options.filepath === 'Review.md', 4000)
        await waitFor(() => comments.comments().some((c) => c.ref.source === path && c.target.range !== null), 4000)
        const mine = comments.comments().find((c) => c.ref.source === path)!
        expect(mine.body).toBe('Written in the editor itself.')
        expect(mine.author).toBe('theo')
        await waitFor(() => comments.active() === mine.id, 2000)
        expect(editor.view.dom.querySelector('.ezco-mde-comment.is-active')?.textContent).toBe('number 7')
        await waitFor(() => !!card(container, mine.id) && !card(container, mine.id).hidden, 2000)
        // Escape closes it, and it stays closed.
        card(container, mine.id).focus()
        await userEvent.keyboard('{Escape}')
        await waitFor(() => comments.active() === null, 2000)
        await frames()
        expect(comments.active()).toBeNull()
    })

    it('drops a reply opened in the editor and left with nothing written', async () => {
        const { editor, container, comments, vault } = await open(900, 'float')
        const first = idOf(comments, 'First.')
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        tool(messageOf(card(container, first), first), 'Reply').click()
        await waitFor(() => document.activeElement === composerIn(messageOf(card(container, first), first)), 2000)
        await userEvent.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}')
        await waitFor(() => /^comments\/Review\/theo /.test((editor.storage as any).persistence.options.filepath ?? ''), 4000)
        const path = (editor.storage as any).persistence.options.filepath as string
        expect(await vault.fs.exists(path)).toBe(true)
        await (editor.storage as any).persistence.loadFile('Review.md')
        await waitFor(async () => !(await vault.fs.exists(path)), 4000)
        await waitFor(() => comments.comments().find((c) => c.id === first)!.replies.length === 0, 3000)
    })

    it('names a second comment made in the same minute after its author too', () => {
        expect(authorOf('comments/Review/theo 2026-09-27 00.25 2.md')).toEqual({ author: 'theo', time: '2026-09-27T00:25' })
    })
})

describe('A comment’s Markdown', () => {
    it('is shown, and nothing in it runs', async () => {
        const body = '**Bold** and [[Zoology]] <img src="x" onerror="window.__ranImg = 1"> <script>window.__ranScript = 1</script> [x](javascript:alert(1))'
        const files = { 'Review.md': NOTE, 'comments/Review/alice 2026-09-13 12.09.md': `![[Review#:~:text=Paragraph%201%20says]]\n${body}\n` }
        const vault = await Vault.open(memoryVfs(files), { watch: false, identity: 'theo' })
        const container = document.createElement('div')
        container.style.cssText = 'width: 1100px; height: 700px; overflow-y: auto;'
        document.body.append(container)
        const editor = createEditor({
            element: container,
            fs: { fs: vault.fs, filepath: 'Review.md', autoSave: true },
            links: { resolver: vault.links, index: vault.links },
            search: vault.search,
            files: vault.files,
            comments: { author: 'theo', index: vault.comments, reactions: vault.reactions, margin: { layout: 'column' } },
        })
        created.push({ editor, container, vault })
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card .ezco-mde-comment-body'), 5000)
        const rendered = container.querySelector('.ezco-mde-comment-card .ezco-mde-comment-body') as HTMLElement
        expect(rendered.querySelector('strong')?.textContent).toBe('Bold')
        expect(rendered.querySelector('[data-wikilink]')?.textContent).toBe('Zoology')
        expect(rendered.querySelector('script, [onerror]')).toBeNull()
        expect(rendered.querySelector('a[href^="javascript" i]')).toBeNull()
        await frames()
        expect((window as any).__ranImg).toBeUndefined()
        expect((window as any).__ranScript).toBeUndefined()
    })
})
