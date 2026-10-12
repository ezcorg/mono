import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { memoryVfs } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
import { createEditor, MarkdownEditor } from '../index'
import { cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'
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
    for (const left of document.querySelectorAll('.ezco-mde-comment-sheet')) left.remove()
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

type Layout = 'float' | 'column' | 'panel'

async function open(width: number, layout: Layout | undefined, files = FILES, author: string | null = 'theo') {
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
        comments: { author: author ?? undefined, index: vault.comments, reactions: vault.reactions, margin: layout ? { layout } : {} },
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
    const moving = [...document.querySelectorAll('.ezco-mde-comment-card')].flatMap((c) => c.getAnimations({ subtree: true }))
    await Promise.all(moving.map((a) => a.finished.catch(() => {})))
}
/** The editor's margin: in its container, or, a panel over the note's edge, in its frame on the page. */
const margin = (c: HTMLElement) => (c.querySelector('.ezco-mde-comment-margin') ?? document.querySelector('.ezco-mde-comment-overlay-frame .ezco-mde-comment-margin')) as HTMLElement
const within = (c: HTMLElement): HTMLElement => margin(c) ?? c
const idOf = (comments: CommentsStorage, body: string) => comments.comments().find((c) => c.body === body)!.id
const card = (c: HTMLElement, id: string) => within(c).querySelector(`.ezco-mde-comment-card[data-comment="${id}"]`) as HTMLElement
const visibleCards = (c: HTMLElement) => [...within(c).querySelectorAll<HTMLElement>('.ezco-mde-comment-card')].filter((e) => !e.hidden && !margin(c).hidden)
const anchorTop = (editor: MarkdownEditor, comments: CommentsStorage, id: string) => editor.view.coordsAtPos(comments.comments().find((c) => c.id === id)!.anchor!).top
const overlap = (a: DOMRect, b: DOMRect) => a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
const tool = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent === label) as HTMLButtonElement
const messageOf = (el: HTMLElement, id: string) => el.querySelector(`.ezco-mde-comment-message[data-comment="${id}"]`) as HTMLElement
/** The field of a reply being written in the thread of `message`, or of the edit in its bubble. */
const composerIn = (message: HTMLElement) =>
    message.querySelector(
        ':scope > .ezco-mde-comment-bubble > .ezco-mde-comment-foot > .ezco-mde-comment-thread > .ezco-mde-comment-message.is-composer > .ezco-mde-comment-bubble > .ezco-mde-comment-content .ezco-mde-comment-text, :scope > .ezco-mde-comment-bubble > .ezco-mde-comment-content .ezco-mde-comment-text',
    ) as HTMLElement | null
/** The foot of `message`'s bubble: its reactions and count, and its thread when open. */
const footOf = (message: HTMLElement) => message.querySelector(':scope > .ezco-mde-comment-bubble > .ezco-mde-comment-foot') as HTMLElement | null
const threadOf = (message: HTMLElement) => footOf(message)?.querySelector(':scope > .ezco-mde-comment-thread') as HTMLElement | null
/** Resolves when every animation running in `el` has ended. */
const settled = (el: HTMLElement) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined)))
const composerBlockIn = (el: HTMLElement) => el.querySelector('.ezco-mde-comment-message.is-composer') as HTMLElement | null
const sheet = () => document.querySelector('.ezco-mde-comment-sheet') as HTMLElement | null
const sheetText = () => sheet()?.querySelector('.ezco-mde-comment-sheet-body') as HTMLElement | null
const sheetPath = (editor: MarkdownEditor) => ((editor.storage as any).commentMargin.sheet as { path: string } | null)?.path ?? null
const posOf = (editor: MarkdownEditor, text: string) => {
    let from = -1
    editor.state.doc.descendants((node, pos) => {
        if (from < 0 && node.isText && node.text!.includes(text)) from = pos + node.text!.indexOf(text)
    })
    return { from, to: from + text.length }
}
/** Choose `label` from a message's chevron menu. */
const viaMenu = async (message: HTMLElement, label: string) => {
    tool(message, 'Comment menu').click()
    await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu'), 2000)
    const item = [...document.querySelectorAll<HTMLElement>('.ezco-mde-comment-menu .ezco-mde-context-menu-item')].find((b) => b.textContent?.trim() === label)
    if (!item) throw new Error(`No "${label}" in the menu: ${[...document.querySelectorAll('.ezco-mde-comment-menu .ezco-mde-context-menu-item')].map((b) => b.textContent).join(', ')}`)
    item.click()
    await waitFor(() => !document.querySelector('.ezco-mde-comment-menu'), 2000)
}
const menuLabels = async (message: HTMLElement) => {
    tool(message, 'Comment menu').click()
    await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu'), 2000)
    const labels = [...document.querySelectorAll<HTMLElement>('.ezco-mde-comment-menu .ezco-mde-context-menu-item')].map((b) => b.textContent?.trim())
    const groups = [...document.querySelectorAll('.ezco-mde-comment-menu .ezco-mde-context-menu-separator')].length
    await userEvent.keyboard('{Escape}')
    await waitFor(() => !document.querySelector('.ezco-mde-comment-menu'), 2000)
    menuGroups = groups + 1
    return labels
}
/** How many groups the last menu read had (the lines between them, plus one). */
let menuGroups = 0
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
        const { editor, container, comments } = await open(1100, 'float')
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
        // Over the note, the bubble is lifted by the chrome's shadow and points
        // at the text; the card around it is nothing.
        const bubble = visibleCards(container)[0].querySelector('.ezco-mde-comment-bubble.is-anchor') as HTMLElement
        expect(getComputedStyle(bubble).boxShadow).not.toBe('none')
        expect(getComputedStyle(visibleCards(container)[0]).backgroundColor).toBe('rgba(0, 0, 0, 0)')
        expect(getComputedStyle(bubble).getPropertyValue('--ezco-mde-text-base').trim()).toBe('16px')
        // In the bubble, under the text: React and the reply count, in a row of their own.
        const foot = bubble.querySelector(':scope > .ezco-mde-comment-foot') as HTMLElement
        expect(foot).not.toBeNull()
        expect(bubble.querySelector('.ezco-mde-comment-under')).toBeNull()
        expect(visibleCards(container)[0].querySelector('.ezco-mde-comment-under')).toBeNull()
        expect([...foot.querySelectorAll(':scope > .ezco-mde-comment-foot-row > button')].map((b) => b.getAttribute('aria-label'))).toEqual(['React', 'Hide replies'])
        // There is no close button: the chevron's menu has Dismiss, in the
        // last of its groups; another's comment offers no composer panel.
        expect(tool(visibleCards(container)[0], 'Close')).toBeUndefined()
        expect(await menuLabels(visibleCards(container)[0])).toEqual(['Reply', 'Edit', 'Resolve', 'Open as file', 'Delete', 'Show in comments panel', 'Dismiss'])
        expect(menuGroups).toBe(5)
        // The byline: who, when, then the fold; the chevron at the right.
        const head = visibleCards(container)[0].querySelector('.ezco-mde-comment-head') as HTMLElement
        expect([...head.children].map((c) => c.className.split(' ')[0])).toEqual(['ezco-mde-comment-author', 'ezco-mde-comment-time', 'ezco-mde-comment-fold', 'ezco-mde-comment-menu-button'])
        // The comment with its first replies, who and when over each; a
        // reply's own answers behind its count.
        expect(visibleCards(container)[0].querySelectorAll('.ezco-mde-comment-message').length).toBe(2)
        expect(visibleCards(container)[0].querySelector('.ezco-mde-comment-author')?.textContent).toBe('@alice')
        expect(tool(visibleCards(container)[0], 'Hide replies').textContent).toBe('1')
        const bob = comments.comments().find((c) => c.id === second)!.replies[0].id
        expect(tool(messageOf(visibleCards(container)[0], bob), 'Show 1 reply').textContent).toBe('1')
        tool(messageOf(visibleCards(container)[0], bob), 'Show 1 reply').click()
        await waitFor(() => visibleCards(container)[0].querySelectorAll('.ezco-mde-comment-message').length === 3, 2000)
        // The thread nests: carol's answer under bob's.
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

describe('The panel, by default', () => {
    it('shows every comment beside the note when there is room past its text column, floats when there is not, and stays put away', async () => {
        const wide = await open(1100, undefined)
        await waitFor(() => margin(wide.container).classList.contains('is-panel'), 3000)
        await frames()
        expect(visibleCards(wide.container).length).toBe(3)
        // The text column keeps its measure: the panel takes only what is past
        // it, and the gutter keeps to the column's edge.
        const body = wide.editor.view.dom
        expect(body.getBoundingClientRect().width).toBeCloseTo(parseFloat(getComputedStyle(body.parentElement!).maxWidth), 0)
        expect(margin(wide.container).getBoundingClientRect().left).toBeGreaterThanOrEqual(body.getBoundingClientRect().right)
        expect(wide.container.querySelector('.ezco-mde-gutter')!.getBoundingClientRect().right).toBeCloseTo(body.getBoundingClientRect().left, 0)
        const narrow = await open(560, undefined)
        await waitFor(() => margin(narrow.container).classList.contains('is-floating'), 3000)
        expect(narrow.editor.view.dom.getBoundingClientRect().width).toBeGreaterThan(400)
        expect(visibleCards(narrow.container)).toEqual([])
        narrow.editor.commands.focusComment(idOf(narrow.comments, 'First.'))
        await waitFor(() => visibleCards(narrow.container).length === 1, 2000)
        // Without the room, the panel asked for comes over the note's edge
        // instead, the note no narrower for it, and slides away on its ×.
        const narrowFirst = idOf(narrow.comments, 'First.')
        await viaMenu(messageOf(card(narrow.container, narrowFirst), narrowFirst), 'Show in comments panel')
        await waitFor(() => margin(narrow.container).classList.contains('is-overlay'), 3000)
        await frames()
        expect(margin(narrow.container).classList.contains('is-panel')).toBe(true)
        expect(visibleCards(narrow.container).length).toBe(3)
        expect(narrow.editor.view.dom.getBoundingClientRect().width).toBeGreaterThan(400)
        const over = margin(narrow.container).getBoundingClientRect()
        const frame = narrow.container.getBoundingClientRect()
        expect(over.right).toBeCloseTo(frame.right, 0)
        expect(over.left).toBeGreaterThan(frame.left + 100)
        expect(margin(narrow.container).closest('.ezco-mde-comment-overlay-frame')).not.toBeNull()
        expect(tool(margin(narrow.container), 'Show the comments')).not.toBeUndefined()
        tool(margin(narrow.container), 'Hide comments panel').click()
        await waitFor(() => margin(narrow.container).classList.contains('is-floating'), 3000)
        expect(document.querySelector('.ezco-mde-comment-overlay-frame')).toBeNull()
        // Put away, it stays away: in this note, and in the next opened.
        tool(margin(wide.container), 'Hide comments panel').click()
        await waitFor(() => margin(wide.container).classList.contains('is-floating'), 3000)
        expect(localStorage.getItem('ezco-mde-comments-panel')).toBe('float')
        const again = await open(1100, undefined)
        await frames()
        expect(margin(again.container).classList.contains('is-floating')).toBe(true)
        // Asked for again, it is back, and the choice forgotten.
        const first = idOf(again.comments, 'First.')
        again.editor.commands.focusComment(first)
        await waitFor(() => !!card(again.container, first), 2000)
        await viaMenu(messageOf(card(again.container, first), first), 'Show in comments panel')
        await waitFor(() => margin(again.container).classList.contains('is-panel'), 3000)
        expect(localStorage.getItem('ezco-mde-comments-panel')).toBeNull()
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
        // In the comment's bubble, in the thread the count opens, in a bubble of its own.
        expect(messageOf(card(container, first), first).querySelector(':scope > .ezco-mde-comment-bubble > .ezco-mde-comment-foot.is-open > .ezco-mde-comment-thread > .ezco-mde-comment-message.is-composer')).not.toBeNull()
        expect(tool(messageOf(card(container, first), first), 'Reply').getAttribute('aria-expanded')).toBe('true')
        const field = composerIn(messageOf(card(container, first), first))!
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard('Half a thought')
        await waitFor(() => localStorage.getItem(`ezco-mde-comment-draft:Review.md:${first}:reply`) === 'Half a thought', 2000)
        tool(card(container, first), 'Cancel').click()
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
        // The reply shows under its comment; nothing more is offered until asked.
        await waitFor(() => !!messageOf(card(container, first), comments.comments().find((c) => c.id === first)!.replies[0].id), 2000)
        expect(composerBlockIn(card(container, first))).toBeNull()
        expect(tool(card(container, first), 'Hide replies').textContent).toBe('1')
    })

    it('writes a reply in full in the sheet, quotes more of the note into it, and opens it as a note', async () => {
        const { editor, container, comments, vault } = await open(900, 'float')
        const first = idOf(comments, 'First.')
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        tool(messageOf(card(container, first), first), 'Reply').click()
        await waitFor(() => document.activeElement === composerIn(messageOf(card(container, first), first)), 2000)
        await userEvent.keyboard('Started here')
        await viaMenu(composerBlockIn(card(container, first))!, 'Composer panel')
        // The reply's document, in the sheet beside the note; the note stays.
        await waitFor(() => !!sheet(), 4000)
        await waitFor(() => comments.comments().find((c) => c.id === first)!.replies.length === 1, 4000)
        const reply = comments.comments().find((c) => c.id === first)!.replies[0]
        expect(reply.body).toBe('Started here')
        expect((editor.storage as any).persistence.options.filepath).toBe('Review.md')
        await waitFor(() => !!sheetText()?.textContent?.includes('Started here'), 3000)
        // Its reference is a portal: the quoted words, who wrote them, the line.
        await waitFor(() => !!sheet()!.querySelector('.ezco-mde-embed--passage .ezco-mde-embed-body'), 3000)
        expect(sheet()!.querySelector('.ezco-mde-embed--passage .ezco-mde-embed-content')?.textContent?.trim()).toBe('First.')
        expect(sheet()!.querySelector('.ezco-mde-embed-meta')?.textContent).toBe('@alice · line 3')
        // More of the note, selected and asked for a comment, is quoted into the sheet.
        editor.commands.setTextSelection(posOf(editor, 'number 9'))
        editor.commands.startComment()
        await waitFor(() => sheet()!.querySelectorAll('.ezco-mde-embed--passage').length === 2, 3000)
        expect(container.querySelector('.ezco-mde-comment-card.is-draft')).toBeNull()
        await waitFor(async () => (await vault.fs.readFile(reply.ref.source)).includes('![[Review#:~:text=number%209]]'), 4000)
        // Opened as a note: the editor is the editor of the reply.
        tool(sheet()!, 'Open as file').click()
        await waitFor(() => (editor.storage as any).persistence.options.filepath === reply.ref.source, 4000)
        await waitFor(() => !sheet(), 2000)
        await waitFor(() => !!editor.view.dom.querySelector('.ezco-mde-embed--passage'), 3000)
    })

    it('reacts through the quick row and the full grid, resolves and closes, and shows the four most given reactions', async () => {
        const { editor, container, comments, vault } = await open(1100, 'column')
        const third = idOf(comments, 'Third, same line.')
        editor.commands.focusComment(third)
        await waitFor(() => card(container, third)?.classList.contains('is-active'), 2000)
        // The menu opens on the reactions to give: the common ones, two rows.
        tool(messageOf(card(container, third), third), 'Comment menu').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu .ezco-mde-comment-menu-reactions'), 2000)
        const block = document.querySelector('.ezco-mde-comment-menu-reactions') as HTMLElement
        const quick = [...block.querySelectorAll<HTMLElement>('.ezco-mde-emoji-cell:not(.is-more)')].map((c) => c.textContent)
        expect(quick.slice(0, 8)).toEqual(['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'])
        expect(block.getBoundingClientRect().height).toBeGreaterThan(55)
        expect(block.getBoundingClientRect().height).toBeLessThan(80)
        tool(block, 'React 👍').click()
        await waitFor(() => !document.querySelector('.ezco-mde-comment-menu'), 2000)
        await waitFor(() => !!card(container, third).querySelector('.ezco-mde-comment-reaction'), 3000)
        expect(card(container, third).querySelector('.ezco-mde-comment-reaction')?.textContent).toBe('👍 1')
        expect(card(container, third).querySelector('.ezco-mde-comment-reaction')?.getAttribute('aria-pressed')).toBe('true')
        // The reaction given is lit; the last cell opens the full grid, which
        // opens on the recent row, then the first category, never blank.
        tool(messageOf(card(container, third), third), 'Comment menu').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu-reactions'), 2000)
        expect(tool(document.querySelector('.ezco-mde-comment-menu-reactions') as HTMLElement, 'React 👍').getAttribute('aria-pressed')).toBe('true')
        tool(document.querySelector('.ezco-mde-comment-menu-reactions') as HTMLElement, 'More emoji').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-emoji-grid .ezco-mde-emoji-cell'), 3000)
        // The grid opens by the chevron it came from, not somewhere under the card.
        const chevron = tool(messageOf(card(container, third), third), 'Comment menu').getBoundingClientRect()
        const grid = document.querySelector('.ezco-mde-emoji-menu')!.closest('.tippy-box')!.getBoundingClientRect()
        expect(Math.abs(grid.top - chevron.bottom)).toBeLessThan(24)
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
        // React, right of the reactions in the bubble, offers them by itself, by the control.
        const react = tool(footOf(messageOf(card(container, third), third))!, 'React')
        expect(react.previousElementSibling?.classList.contains('ezco-mde-comment-reaction')).toBe(true)
        react.click()
        await waitFor(() => !!document.querySelector('.ezco-mde-reactions'), 2000)
        const quickRow = document.querySelector('.ezco-mde-reactions')!.closest('.tippy-box')!.getBoundingClientRect()
        expect(Math.abs(quickRow.top - react.getBoundingClientRect().bottom)).toBeLessThan(24)
        expect(Math.abs(quickRow.left - react.getBoundingClientRect().left)).toBeLessThan(40)
        tool(document.querySelector('.ezco-mde-reactions') as HTMLElement, 'React 🎉').click()
        await waitFor(() => !document.querySelector('.ezco-mde-reactions'), 2000)
        await waitFor(() => card(container, third).querySelectorAll('.ezco-mde-comment-reaction').length === 2, 3000)
        // A chip of one's own takes the reaction back.
        ;[...card(container, third).querySelectorAll<HTMLButtonElement>('.ezco-mde-comment-reaction')].find((c) => c.textContent === '🎉 1')!.click()
        await waitFor(() => card(container, third).querySelectorAll('.ezco-mde-comment-reaction').length === 1, 3000)
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
        await waitFor(() => !!messageOf(card(container, second), bob), 2000)
        await viaMenu(messageOf(card(container, second), bob), 'Edit')
        await waitFor(() => !!composerIn(messageOf(card(container, second), bob)), 2000)
        expect(messageOf(card(container, second), bob).querySelector(':scope > .ezco-mde-comment-bubble .ezco-mde-comment-body')).toBeNull()
        expect(messageOf(card(container, second), bob).querySelector(':scope > .ezco-mde-comment-bubble')?.classList.contains('is-editing')).toBe(true)
        const field = composerIn(messageOf(card(container, second), bob))!
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard(' Edited.')
        await userEvent.keyboard('{Control>}{Enter}{/Control}')
        await waitFor(() => comments.comments().find((c) => c.id === second)!.replies[0].body === 'A reply. Edited.', 4000)
        // Carol's answer to bob goes (nobody answered it).
        const carol = comments.comments().find((c) => c.id === second)!.replies[0].replies[0].id
        tool(messageOf(card(container, second), bob), 'Show 1 reply').click()
        await waitFor(() => !!messageOf(card(container, second), carol), 2000)
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

    it('shows a comment’s first replies, keeps a reply’s behind its count, and collapses a message with everything under it', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        const second = idOf(comments, 'Second, a longer comment that wraps onto a few lines in the margin to take room.')
        const bob = comments.comments().find((c) => c.id === second)!.replies[0].id
        const carol = comments.comments().find((c) => c.id === second)!.replies[0].replies[0].id
        editor.commands.focusComment(second)
        await waitFor(() => !!card(container, second), 2000)
        expect(messageOf(card(container, second), bob)).not.toBeNull()
        expect(messageOf(card(container, second), carol)).toBeNull()
        tool(messageOf(card(container, second), bob), 'Show 1 reply').click()
        await waitFor(() => messageOf(card(container, second), carol) !== null, 2000)
        // [–] on bob: bob to its byline, carol gone with it; [+] brings both back.
        expect(tool(messageOf(card(container, second), bob), 'Collapse').textContent).toBe('[–]')
        tool(messageOf(card(container, second), bob), 'Collapse').click()
        await waitFor(() => messageOf(card(container, second), carol) === null, 2000)
        const folded = messageOf(card(container, second), bob)
        expect(folded.querySelector(':scope > .ezco-mde-comment-bubble')?.classList.contains('is-collapsed')).toBe(true)
        // The byline sits where it did: the chevron stays, the padding too.
        expect(tool(folded, 'Comment menu')).not.toBeUndefined()
        expect(getComputedStyle(folded.querySelector(':scope > .ezco-mde-comment-bubble') as HTMLElement).paddingTop).toBe('7px')
        expect(folded.querySelector('.ezco-mde-comment-content')).toBeNull()
        expect(folded.querySelector('.ezco-mde-comment-folded-hint')?.textContent).toBe('1 reply')
        expect(tool(folded, 'Expand').textContent).toBe('[+]')
        tool(folded, 'Expand').click()
        await waitFor(() => messageOf(card(container, second), carol) !== null, 2000)
        // Every message has the fold, the comment itself too.
        expect(tool(messageOf(card(container, second), carol), 'Collapse')).not.toBeUndefined()
        tool(messageOf(card(container, second), second), 'Collapse').click()
        await waitFor(() => messageOf(card(container, second), bob) === null, 2000)
        expect(messageOf(card(container, second), second).querySelector('.ezco-mde-comment-folded-hint')?.textContent).toBe('2 replies')
        tool(messageOf(card(container, second), second), 'Expand').click()
        await waitFor(() => messageOf(card(container, second), bob) !== null, 2000)
        // The count hides the comment's own replies, all of them.
        tool(messageOf(card(container, second), second), 'Hide replies').click()
        await waitFor(() => messageOf(card(container, second), bob) === null, 2000)
        expect(messageOf(card(container, second), second).querySelector('.ezco-mde-comment-content')).not.toBeNull()
    })

    it('grows the thread out of its count, folds it back into the count, and writes a reply last in it', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        const second = idOf(comments, 'Second, a longer comment that wraps onto a few lines in the margin to take room.')
        const bob = comments.comments().find((c) => c.id === second)!.replies[0].id
        const carol = comments.comments().find((c) => c.id === second)!.replies[0].replies[0].id
        editor.commands.focusComment(second)
        await waitFor(() => !!card(container, second), 2000)
        const message = () => messageOf(card(container, second), second)
        const count = () => tool(message(), 'Hide replies') ?? tool(message(), 'Show 1 reply')
        const foot = () => footOf(message())!
        const frame = () => foot().querySelector(':scope > .ezco-mde-comment-thread-frame') as HTMLElement | null
        // Shown from the start: in the bubble, the count at the end of the
        // foot's row, marked open, and the thread in its frame under the row.
        expect(foot().parentElement).toBe(message().querySelector(':scope > .ezco-mde-comment-bubble'))
        expect(foot().querySelector(':scope > .ezco-mde-comment-foot-row > :last-child')).toBe(count())
        expect(count().getAttribute('aria-expanded')).toBe('true')
        expect(foot().classList.contains('is-open')).toBe(true)
        expect(threadOf(message())?.querySelector(`[data-comment="${bob}"]`)).not.toBeNull()
        expect(getComputedStyle(frame()!).display).not.toBe('none')
        const around = (el: HTMLElement) => {
            const f = frame()!.getBoundingClientRect()
            const r = el.getBoundingClientRect()
            return Math.abs(f.top - r.top) < 1 && Math.abs(f.bottom - r.bottom) < 1 && Math.abs(f.left - r.left) < 1
        }
        expect(around(foot())).toBe(true)
        // Folded away: the frame shrinks into the count while the replies
        // fade, the foot clipped meanwhile; then they are gone.
        const closing = foot()
        count().click()
        expect(closing.classList.contains('is-moving')).toBe(true)
        expect(closing.getAnimations({ subtree: true }).length).toBeGreaterThan(0)
        expect(getComputedStyle(closing).overflow).toBe('hidden')
        expect(messageOf(card(container, second), bob)).not.toBeNull()
        await waitFor(() => messageOf(card(container, second), bob) === null, 2000)
        expect(count().getAttribute('aria-expanded')).toBe('false')
        expect(foot().classList.contains('is-open')).toBe(false)
        expect(frame()).toBeNull()
        // Opened again: the frame grows out of the count, from its very shape.
        count().click()
        const opening = foot()
        expect(opening.classList.contains('is-moving')).toBe(true)
        const growth = frame()!.getAnimations()[0]
        expect(growth).toBeDefined()
        const first = (growth.effect as KeyframeEffect).getKeyframes()[0] as Record<string, string>
        expect(first.borderRadius).toBe('999px')
        expect(parseFloat(first.width)).toBeCloseTo(count().getBoundingClientRect().width, 0)
        await settled(opening)
        expect(opening.classList.contains('is-moving')).toBe(false)
        expect(around(opening)).toBe(true)
        // A reply to bob is written in bob's thread, which opens for it, after bob's own replies.
        await viaMenu(messageOf(card(container, second), bob), 'Reply')
        await waitFor(() => !!composerIn(messageOf(card(container, second), bob)), 2000)
        const thread = threadOf(messageOf(card(container, second), bob))!
        expect([...thread.children].map((c) => c.getAttribute('data-comment') ?? c.className)).toEqual([carol, 'ezco-mde-comment-message is-composer'])
        expect(tool(messageOf(card(container, second), bob), 'Hide replies').getAttribute('aria-expanded')).toBe('true')
    })

    it('shows every comment in a panel on request, and puts it away', async () => {
        const { editor, container, comments } = await open(1100, 'float')
        const first = idOf(comments, 'First.')
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        await viaMenu(messageOf(card(container, first), first), 'Show in comments panel')
        await waitFor(() => margin(container).classList.contains('is-panel'), 3000)
        await frames()
        expect(visibleCards(container).length).toBe(3)
        expect(container.querySelector('.ezco-mde-comments .ezco-mde-comment-margin')).not.toBeNull()
        tool(margin(container), 'Hide comments panel').click()
        await waitFor(() => margin(container).classList.contains('is-floating'), 3000)
        expect(container.querySelector('.ezco-mde-comments')).toBeNull()
        // Back over the note, as wide as the note: the card by its text again.
        expect(margin(container).style.width).toBe('')
        await frames()
        const box = card(container, first).getBoundingClientRect()
        const end = editor.view.coordsAtPos(comments.comments().find((c) => c.id === first)!.target.range!.to, -1)
        expect(box.left).toBeGreaterThan(end.left - 40)
        expect(editor.commands.toggleCommentsPanel()).toBe(true)
        await waitFor(() => margin(container).classList.contains('is-panel'), 3000)
    })

    it('offers nothing to write or react with without an author', async () => {
        const { container, comments } = await open(1100, 'column', FILES, null)
        const first = idOf(comments, 'First.')
        expect([...card(container, first).querySelectorAll('.ezco-mde-comment-action')].map((b) => b.getAttribute('aria-label'))).toEqual(['No replies'])
        expect(await menuLabels(messageOf(card(container, first), first))).toEqual(['Open as file'])
        expect(card(container, first).querySelector('.ezco-mde-comment-menu-reactions')).toBeNull()
    })

    it('opens an unwritten comment in the sheet with somewhere to write, saving it as it is typed', async () => {
        const { editor, container, comments, vault } = await open(900, 'float')
        editor.commands.setTextSelection(posOf(editor, 'number 7'))
        editor.commands.startComment()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        // Nothing typed yet: the composer's menu offers both long forms; the
        // sheet makes the document and opens it there.
        expect(await menuLabels(container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement)).toEqual(['Composer panel', 'Open as file'])
        await viaMenu(container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement, 'Composer panel')
        await waitFor(() => !!sheet(), 4000)
        // The document exists, holding only its reference: not a comment until
        // something is written under it.
        const path = sheetPath(editor)!
        expect(path).toMatch(/^comments\/Review\/theo /)
        expect(await vault.fs.readFile(path)).toBe('![[Review#:~:text=number%207]]\n')
        expect(comments.comments().some((c) => c.author === 'theo')).toBe(false)
        expect((editor.storage as any).persistence.options.filepath).toBe('Review.md')
        // The caret is in a paragraph of its own under the reference, ready for the text.
        await waitFor(() => !!sheet()!.contains(document.activeElement), 2000)
        await userEvent.keyboard('Written in the sheet.')
        await waitFor(async () => (await vault.fs.readFile(path)).includes('![[Review#:~:text=number%207]]\n\nWritten in the sheet.'), 4000)
        await waitFor(() => comments.comments().find((c) => c.ref.source === path)?.body === 'Written in the sheet.', 4000)
        // Escape closes the sheet; the document stays.
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !sheet(), 3000)
        expect(await vault.fs.exists(path)).toBe(true)
    })

    it('drops a reply opened in the sheet and closed with nothing written', async () => {
        const { editor, container, comments, vault } = await open(900, 'float')
        const first = idOf(comments, 'First.')
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        tool(messageOf(card(container, first), first), 'Reply').click()
        await waitFor(() => document.activeElement === composerIn(messageOf(card(container, first), first)), 2000)
        await userEvent.keyboard('{Control>}{Shift>}{Enter}{/Shift}{/Control}')
        await waitFor(() => !!sheet(), 4000)
        const path = sheetPath(editor)!
        expect(path).toMatch(/^comments\/Review\/theo /)
        expect(await vault.fs.exists(path)).toBe(true)
        tool(sheet()!, 'Close').click()
        await waitFor(() => !sheet(), 3000)
        await waitFor(async () => !(await vault.fs.exists(path)), 4000)
        await waitFor(() => comments.comments().find((c) => c.id === first)!.replies.length === 0, 3000)
    })

    it('names a second comment made in the same minute after its author too', () => {
        expect(authorOf('comments/Review/theo 2026-09-27 00.25 2.md')).toEqual({ author: 'theo', time: '2026-09-27T00:25' })
    })
})

describe('What a comment shows', () => {
    const openWith = async (files: Record<string, string>, layout: Layout = 'column', width = 1100) => {
        const vault = await Vault.open(memoryVfs(files), { watch: false, identity: 'theo' })
        const container = document.createElement('div')
        container.style.cssText = `width: ${width}px; height: 700px; overflow-y: auto;`
        document.body.append(container)
        const editor = createEditor({
            element: container,
            fs: { fs: vault.fs, filepath: 'Review.md', autoSave: true },
            links: { resolver: vault.links, index: vault.links },
            search: vault.search,
            files: vault.files,
            comments: { author: 'theo', index: vault.comments, reactions: vault.reactions, margin: { layout } },
        })
        created.push({ editor, container, vault })
        const comments = (editor.storage as any).comments as CommentsStorage
        return { editor, container, vault, comments }
    }

    it('shows a fence named by a file as the note does, the file’s lines in a code block, even with fences inside', async () => {
        // A Markdown file with a fence in it, quoted in a fence named by it:
        // the outer fence is longer, as the editor writes it.
        const inner = '# A\n\n```ts\nconst x = 1\n```\n\nafter\n'
        const files = {
            'Review.md': NOTE,
            'notes.md': inner,
            'comments/Review/alice 2026-09-13 12.09.md': '![[Review#:~:text=Paragraph%201%20says]]\n\n' + '````notes.md\n' + inner + '````\n\nSaid about it.\n',
        }
        const { editor, container, comments } = await openWith(files)
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card .ezco-mde-comment-body .cm-content'), 6000)
        const body = container.querySelector('.ezco-mde-comment-card .ezco-mde-comment-body') as HTMLElement
        await waitFor(() => !!body.querySelector('.cm-content')?.textContent?.includes('after'), 6000)
        // One code block holding the whole file; the text after it a paragraph of the comment.
        expect(body.querySelectorAll('.cm-editor').length).toBe(1)
        expect([...body.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Said about it.'])
        // Shown, not written: nothing can be typed into the block.
        expect(body.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false')
        // The same document in the editor itself keeps its fence when written back.
        editor.commands.openCommentAsNote(comments.comments()[0].id)
        await waitFor(() => (editor.storage as any).persistence.options.filepath === 'comments/Review/alice 2026-09-13 12.09.md', 4000)
        await waitFor(() => !!editor.view.dom.querySelector('.cm-content'), 4000)
        expect(getMarkdownContent(editor)).toContain('\n````notes.md\n')
    })

    it('folds a long comment after a few lines, with the fold to open it', async () => {
        const long = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of a long comment.`).join('\n\n')
        const { container } = await openWith({ 'Review.md': NOTE, 'comments/Review/alice 2026-09-13 12.09.md': `![[Review#:~:text=Paragraph%201%20says]]\n\n${long}\n` })
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-content.is-clamped'), 5000)
        const content = container.querySelector('.ezco-mde-comment-content') as HTMLElement
        const more = tool(container.querySelector('.ezco-mde-comment-card') as HTMLElement, 'Show the whole text')
        expect(more.hidden).toBe(false)
        expect(more.textContent).toBe('Show more')
        const folded = content.getBoundingClientRect().height
        more.click()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-content.is-expanded'), 2000)
        await frames()
        expect(container.querySelector('.ezco-mde-comment-content.is-clamped')).toBeNull()
        expect((container.querySelector('.ezco-mde-comment-content') as HTMLElement).getBoundingClientRect().height).toBeGreaterThan(folded * 2)
        expect(tool(container.querySelector('.ezco-mde-comment-card') as HTMLElement, 'Fold the text').textContent).toBe('Show less')
    })

    it('folds a comment whose quoted document arrives after the comment is shown', async () => {
        const other = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the other note.`).join('\n\n')
        // The quote shares its line with text: alone on a line it would be a reference of its own.
        const files = { 'Review.md': NOTE, 'Other.md': other + '\n', 'comments/Review/alice 2026-09-13 12.09.md': '![[Review#:~:text=Paragraph%201%20says]]\n\nSee this: ![[Other]]\n' }
        const { container } = await openWith(files)
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card .ezco-mde-comment-body .ezco-mde-embed--note .ezco-mde-embed-body'), 6000)
        // The quoted note, read after the card was drawn, is what makes the text long: it is folded all the same.
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-content.is-clamped'), 5000)
        const more = tool(container.querySelector('.ezco-mde-comment-card') as HTMLElement, 'Show the whole text')
        expect(more.hidden).toBe(false)
        expect(more.textContent).toBe('Show more')
    })

    it('keeps a card within the note’s frame, scrolling inside it', async () => {
        const long = Array.from({ length: 80 }, (_, i) => `Reply line ${i + 1}.`).join('\n\n')
        const files = {
            'Review.md': NOTE,
            'comments/Review/alice 2026-09-13 12.09.md': '![[Review#:~:text=Paragraph%201%20says]]\n\nShort.\n',
            'comments/Review/bob 2026-09-13 12.10.md': `![[comments/Review/alice 2026-09-13 12.09#:~:text=Short.]]\n\n${long}\n`,
        }
        const { editor, container, comments } = await openWith(files, 'float', 900)
        await waitFor(() => comments.comments().length === 1 && comments.comments()[0].replies.length === 1, 5000)
        editor.commands.focusComment(comments.comments()[0].id)
        await waitFor(() => visibleCards(container).length === 1, 2000)
        await waitFor(() => visibleCards(container)[0].querySelectorAll('.ezco-mde-comment-message').length === 2, 2000)
        const reply = comments.comments()[0].replies[0].id
        await waitFor(() => !tool(messageOf(visibleCards(container)[0], reply), 'Show the whole text').hidden, 3000)
        tool(messageOf(visibleCards(container)[0], reply), 'Show the whole text').click()
        await frames()
        const box = visibleCards(container)[0].getBoundingClientRect()
        const frame = container.getBoundingClientRect()
        expect(box.height).toBeLessThanOrEqual(frame.height - 15)
        expect(box.top).toBeGreaterThanOrEqual(frame.top)
        expect(box.bottom).toBeLessThanOrEqual(frame.bottom)
        const inside = visibleCards(container)[0].querySelector('.ezco-mde-comment-inside') as HTMLElement
        expect(inside.scrollHeight).toBeGreaterThan(inside.clientHeight)
    })

    it('lists every comment in a panel, in the note’s order, marks the one being read past, and takes the note to one clicked, level with its bubble', async () => {
        // A note long enough to scroll any of its lines to the top.
        const files = { ...FILES, 'Review.md': ['# Review', ...paragraphs, ...Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the longer part, nothing to say.`)].join('\n\n') + '\n' }
        const { editor, container, comments } = await open(1100, 'panel', files)
        await waitFor(() => margin(container).classList.contains('is-panel'), 2000)
        await frames()
        const cards = visibleCards(container)
        expect(cards.map((c) => comments.comments().find((x) => x.id === c.dataset.comment)!.body)).toEqual(['First.', 'Second, a longer comment that wraps onto a few lines in the margin to take room.', 'Third, same line.'])
        // In the flow, one under the other, not placed by hand.
        for (const c of cards) expect(c.style.top).toBe('')
        for (let i = 1; i < cards.length; i++) expect(cards[i].getBoundingClientRect().top).toBeGreaterThan(cards[i - 1].getBoundingClientRect().bottom - 1)
        expect(getComputedStyle(margin(container)).position).toBe('sticky')
        const third = idOf(comments, 'Third, same line.')
        editor.commands.focusComment(third)
        await waitFor(() => card(container, third).classList.contains('is-active'), 2000)
        await frames()
        const m = margin(container).getBoundingClientRect()
        const box = card(container, third).getBoundingClientRect()
        expect(box.top).toBeGreaterThanOrEqual(m.top - 1)
        expect(box.bottom).toBeLessThanOrEqual(m.bottom + 1)
        // The head stays while the list scrolls.
        expect(getComputedStyle(margin(container).querySelector('.ezco-mde-comment-list') as HTMLElement).overflowY).toBe('auto')
        expect(getComputedStyle(margin(container)).overflowY).not.toBe('auto')
        // The comment looked at is the current one, stepped out a little from the others.
        expect(card(container, third).classList.contains('is-current')).toBe(true)
        expect(getComputedStyle(card(container, third)).transform).not.toBe('none')
        expect(getComputedStyle(card(container, idOf(comments, 'First.'))).transform).toBe('none')
        // As the note is read past commented text, that comment is the current one.
        const done = idOf(comments, 'Done already.')
        tool(container, 'Show resolved (1)').click()
        await waitFor(() => !!card(container, done), 2000)
        const textTop = (id: string) => editor.view.coordsAtPos(comments.comments().find((c) => c.id === id)!.target.range!.from, 1).top
        const frame = container.getBoundingClientRect()
        container.scrollTop += textTop(done) - (frame.top + frame.height * 0.3)
        container.dispatchEvent(new Event('scroll'))
        await waitFor(() => card(container, done).classList.contains('is-current'), 2000)
        expect(container.querySelectorAll('.ezco-mde-comment-card.is-current').length).toBe(1)
        container.scrollTop = 0
        container.dispatchEvent(new Event('scroll'))
        await waitFor(() => !card(container, done).classList.contains('is-current'), 2000)
        expect(container.querySelectorAll('.ezco-mde-comment-card.is-current').length).toBe(1)
        // A click on a comment's bubble takes the note to its text, level
        // with the top of the bubble, and lights the comment.
        // (The card is drawn again as it becomes the one looked at: its bubble is found again.)
        const bubble = () => card(container, done).querySelector('.ezco-mde-comment-bubble.is-anchor') as HTMLElement
        expect(getComputedStyle(bubble()).cursor).toBe('pointer')
        bubble().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        await waitFor(() => comments.active() === done, 2000)
        await waitFor(() => Math.abs(textTop(done) - bubble().getBoundingClientRect().top) < 2, 4000)
        expect(card(container, done).classList.contains('is-current')).toBe(true)
        expect(getComputedStyle(bubble()).borderTopColor).not.toBe(getComputedStyle(card(container, idOf(comments, 'First.')).querySelector('.ezco-mde-comment-bubble.is-anchor') as HTMLElement).borderTopColor)
    })

    it('shows a quoted passage as a portal: its paragraph around it, the words marked, and where they are', async () => {
        const { editor, comments } = await open(1100, 'column')
        const second = idOf(comments, 'Second, a longer comment that wraps onto a few lines in the margin to take room.')
        editor.commands.openCommentAsNote(second)
        await waitFor(() => (editor.storage as any).persistence.options.filepath === 'comments/Review/alice 2026-09-13 12.02.md', 4000)
        await waitFor(() => !!editor.view.dom.querySelector('.ezco-mde-embed--passage.has-context .ezco-mde-embed-quoted'), 5000)
        const portal = editor.view.dom.querySelector('.ezco-mde-embed--passage') as HTMLElement
        expect(portal.querySelector('.ezco-mde-embed-quoted')?.textContent).toBe('worth a comment, number 3')
        expect(portal.querySelector('.ezco-mde-embed-content')?.textContent).toBe('Paragraph 3 says something worth a comment, number 3.')
        expect(portal.querySelector('.ezco-mde-embed-meta')?.textContent).toBe('line 7')
        expect(getComputedStyle(portal).borderTopStyle).toBe('solid')
    })

    it('shows the Markdown, and nothing in it runs', async () => {
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
