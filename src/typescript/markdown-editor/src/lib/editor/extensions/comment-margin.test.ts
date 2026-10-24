import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { memoryVfs, type VfsInterface } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
import { createEditor, MarkdownEditor, settingsOf as settingsOfEditor } from '../index'
import { frames as raf, getMarkdownContent, rangeOf, tool, trackEditors, viaMenu as choose, waitFor } from '../../../test/utils'
import { authorOf, type CommentsStorage } from './comments'

/**
 * Comments in a real browser: measured boxes, so a card that drifts from
 * its text or covers another is caught; real keys into the composers.
 */

const { created, openVault } = trackEditors()

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

/** The settings of an editor: what it keeps its panel's choices in. */
const settingsOf = (editor: MarkdownEditor) => settingsOfEditor(editor)!

async function open(width: number, layout: Layout | undefined, files = FILES, author: string | null = 'theo', openOnClick = false, on?: VfsInterface, inline?: boolean) {
    const vault = await Vault.open(on ?? memoryVfs(files), { watch: false, identity: author ?? undefined })
    // Alice's fourth is resolved (by theo, whoever is looking). (On a
    // filesystem opened before, it is already: a toggle would undo it.)
    if (!on) {
        const resolver = author === 'theo' ? vault : await Vault.open(vault.fs, { watch: false, identity: 'theo' })
        await resolver.reactions.toggle({ doc: 'comments/Review/alice 2026-09-13 12.04.md', ref: 'Review#:~:text=Paragraph%2010%20says' }, '✅')
        if (resolver !== vault) resolver.close()
    }
    const made = await openVault(files, {
        vault,
        path: 'Review.md',
        autoSave: true,
        size: { width, height: 700, scroll: true },
        services: ['resolver', 'index', 'search', 'files', 'comments'],
        comments: { author: author ?? undefined, openOnClick, margin: { ...(layout ? { layout } : {}), ...(inline === undefined ? {} : { inline }) } },
    })
    await waitFor(() => made.comments.comments().some((c) => c.resolved), 3000)
    await frames()
    return made
}

/** Three frames, and every animation in the cards ended. */
const frames = async (n = 3) => {
    await raf(n)
    const moving = [...document.querySelectorAll('.ezco-mde-comment-card, .ezco-mde-comment-inline, .ezco-mde-beside')].flatMap((c) => c.getAnimations({ subtree: true }))
    await Promise.all(moving.map((a) => a.finished.catch(() => {})))
}
/** The editor's margin: in its container, or, a panel over the note's edge, in its frame on the page. */
const margin = (c: HTMLElement) => (c.querySelector('.ezco-mde-comment-margin') ?? document.querySelector('.ezco-mde-comment-overlay-frame .ezco-mde-comment-margin')) as HTMLElement
const within = (c: HTMLElement): HTMLElement => margin(c) ?? c
const idOf = (comments: CommentsStorage, body: string) => comments.comments().find((c) => c.body === body)!.id
/** The cards standing within the note (comment-inline.ts), in their boxes. */
const inlineCards = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.ezco-mde-body > .ezco-mde-comment-inline > .ezco-mde-comment-card, .ezco-mde-body .ezco-mde-comment-inline > .ezco-mde-comment-card')].filter((e) => !e.hidden)
const card = (c: HTMLElement, id: string) =>
    (within(c).querySelector(`.ezco-mde-comment-card[data-comment="${id}"]`) ?? inlineCards(c).find((e) => e.dataset.comment === id) ?? null) as HTMLElement
const visibleCards = (c: HTMLElement) => [...[...within(c).querySelectorAll<HTMLElement>('.ezco-mde-comment-card')].filter((e) => !e.hidden && !margin(c).hidden), ...inlineCards(c)]
const anchorTop = (editor: MarkdownEditor, comments: CommentsStorage, id: string) => editor.view.coordsAtPos(comments.comments().find((c) => c.id === id)!.anchor!).top
const overlap = (a: DOMRect, b: DOMRect) => a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
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
/** Choose `label` from a message's chevron menu. */
const viaMenu = (message: HTMLElement, label: string) => choose(tool(message, 'Comment menu'), label, '.ezco-mde-comment-menu')
/** Choose `label` from the panel head's chevron menu; a setting's state
 *  (its switch) as it was before the choice, else null. */
const viaHeadMenu = (container: HTMLElement, label: string) =>
    choose(tool(margin(container).querySelector('.ezco-mde-comment-margin-head') as HTMLElement, 'Comments panel menu'), label, '.ezco-mde-comment-menu')
/** How far a card beside the note has stepped out towards the text (negative: left). */
const shift = (el: HTMLElement) => new DOMMatrix(getComputedStyle(el).transform).m41
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
/** The marks in the annotation column beside the note. */
const marks = (c: HTMLElement) => [...(c.querySelector('.ezco-mde-annotations') as HTMLElement).querySelectorAll<HTMLElement>('.ezco-mde-comment-mark')]
/** The mark on the line comment `id` starts on. */
const markOfIn = (c: HTMLElement, id: string) => marks(c).find((m) => (JSON.parse(m.dataset.comments!) as string[]).includes(id))!
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
    it('show nothing until a comment’s mark is clicked, then the comment by its text, and close on Escape; a click on the text only places the caret', async () => {
        const { editor, container, comments } = await open(1100, 'float')
        expect(container.querySelector('.ezco-mde-comments')).toBeNull()
        expect(margin(container).hidden).toBe(true)
        expect(visibleCards(container)).toEqual([])
        const noteWidth = editor.view.dom.getBoundingClientRect().width
        expect(noteWidth).toBeGreaterThan(700)

        // A click on commented text: the caret goes there and nothing opens.
        const first = idOf(comments, 'First.')
        await clickText(editor, comments, first)
        await new Promise((r) => setTimeout(r, 300))
        expect(comments.active()).toBeNull()
        expect(visibleCards(container)).toEqual([])
        expect(editor.state.selection.from).toBeGreaterThanOrEqual(comments.comments().find((c) => c.id === first)!.target.range!.from)
        // The second and third start on one line: its mark opens them both,
        // one under the other; the first clicked (`toggleComments` would
        // take either) is looked at.
        const second = idOf(comments, 'Second, a longer comment that wraps onto a few lines in the margin to take room.')
        const third = idOf(comments, 'Third, same line.')
        await waitFor(() => marks(container).length === 3, 3000)
        const markOf = (id: string) => markOfIn(container, id)
        expect(markOf(second)).toBe(markOf(third))
        markOf(second).click()
        await waitFor(() => visibleCards(container).length === 2, 2000)
        await frames()
        expect(comments.open().sort()).toEqual([second, third].sort())
        // (The one whose text starts first on the line is looked at.)
        expect(comments.active()).toBe((JSON.parse(markOf(second).dataset.comments!) as string[])[0])
        expect(markOf(second).classList.contains('is-open')).toBe(true)
        const [upper, lower] = visibleCards(container).map((c) => c.getBoundingClientRect()).sort((a, b) => a.top - b.top)
        expect(lower.top).toBeGreaterThanOrEqual(upper.bottom)
        // The mark again closes them both; Close in a card's menu, that card.
        markOf(second).click()
        await waitFor(() => visibleCards(container).length === 0 && comments.active() === null, 2000)
        markOf(second).click()
        await waitFor(() => visibleCards(container).length === 2, 2000)
        await viaMenu(messageOf(card(container, third), third), 'Close')
        await waitFor(() => visibleCards(container).length === 1, 2000)
        expect(comments.open()).toEqual([second])
        await waitFor(() => comments.active() === second, 2000)
        await frames()
        const box = visibleCards(container)[0].getBoundingClientRect()
        const text = comments.comments().find((c) => c.id === second)!.target.range!
        // Beside its text: level with the line it starts on, right of the text's column.
        const start = editor.view.coordsAtPos(text.from, 1)
        expect(Math.abs(box.top - start.top)).toBeLessThan(start.bottom - start.top + 12)
        expect(box.left).toBeGreaterThan(start.right)
        expect(box.right).toBeLessThanOrEqual(container.getBoundingClientRect().right)
        expect(editor.view.dom.getBoundingClientRect().width).toBe(noteWidth)
        // Within the note, beside its text, in the note's flow (the margin
        // has nothing to show): the test below measures what moves.
        expect(editor.view.dom.contains(visibleCards(container)[0])).toBe(true)
        expect(margin(container).hidden).toBe(true)
        // The bubble is lifted by the chrome's shadow and points
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
        // There is no close button: the chevron's menu has Close, in the
        // last of its groups; another's comment offers no composer panel.
        expect(tool(visibleCards(container)[0], 'Close')).toBeUndefined()
        expect(await menuLabels(visibleCards(container)[0])).toEqual(['Reply', 'Edit', 'Resolve', 'Open as file', 'Delete', 'Show in comments panel', 'Close'])
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
        await waitFor(() => editor.isFocused, 2000)
        // Open again, a click elsewhere in the note closes what is open.
        markOf(second).click()
        await waitFor(() => visibleCards(container).length === 2, 2000)
        await userEvent.click(editor.view.dom.querySelector('h1') as HTMLElement)
        await waitFor(() => comments.active() === null && visibleCards(container).length === 0, 2000)
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

    it('tells overlapping comments apart, and, asked to open comments on a click, looks at each in turn when their overlap is clicked', async () => {
        const files = { ...FILES, ...Object.fromEntries([comment('dave', '07', 'Paragraph 2 says something', 'Overlapping.')]) }
        const { editor, container, comments } = await open(900, 'float', files, 'theo', true)
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
        const frame = narrow.container.getBoundingClientRect()
        // (Slid in from the edge: a transition.)
        await waitFor(() => Math.abs(margin(narrow.container).getBoundingClientRect().right - frame.right) < 1, 2000)
        const over = margin(narrow.container).getBoundingClientRect()
        expect(over.right).toBeCloseTo(frame.right, 0)
        expect(over.left).toBeGreaterThan(frame.left + 100)
        expect(margin(narrow.container).closest('.ezco-mde-comment-overlay-frame')).not.toBeNull()
        expect(tool(margin(narrow.container), 'Show the comments')).not.toBeUndefined()
        await viaHeadMenu(narrow.container, 'Hide comments panel')
        await waitFor(() => margin(narrow.container).classList.contains('is-floating'), 3000)
        expect(document.querySelector('.ezco-mde-comment-overlay-frame')).toBeNull()
        // Put away, it stays away: in this note, and in the next opened.
        // (From the head's menu: the head has no × of its own.)
        expect(tool(margin(wide.container), 'Hide comments panel')).toBeUndefined()
        await viaHeadMenu(wide.container, 'Hide comments panel')
        await waitFor(() => margin(wide.container).classList.contains('is-floating'), 3000)
        // The choice is a setting, in this device's file in the vault.
        expect(settingsOf(wide.editor).get('comments.panel')).toBe(false)
        const deviceFile = settingsOf(wide.editor).file('device')!
        expect(deviceFile.startsWith('.settings/theo/devices/')).toBe(true)
        await waitFor(async () => (await wide.vault.fs.exists(deviceFile)) && (await wide.vault.fs.readFile(deviceFile)).includes('panel: false'), 3000)
        const again = await open(1100, undefined, FILES, 'theo', false, wide.vault.fs)
        await waitFor(() => margin(again.container).classList.contains('is-floating'), 3000)
        // Asked for again, it is back, and the choice forgotten.
        const first = idOf(again.comments, 'First.')
        again.editor.commands.focusComment(first)
        await waitFor(() => !!card(again.container, first), 2000)
        await viaMenu(messageOf(card(again.container, first), first), 'Show in comments panel')
        await waitFor(() => margin(again.container).classList.contains('is-panel'), 3000)
        expect(settingsOf(again.editor).get('comments.panel')).toBe(true)
        // Nothing of the choice in this browser: the vault has it.
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
        await waitFor(() => marks(container).length === 3, 3000)
        // Beside the note, the mark looks at the comment (the second and
        // third share the line: the one after the one looked at).
        markOfIn(container, third).click()
        await waitFor(() => comments.active() !== null, 2000)
        if (comments.active() !== third) markOfIn(container, third).click()
        await waitFor(() => comments.active() === third, 2000)
        await waitFor(() => Math.abs(card(container, third).getBoundingClientRect().top - anchorTop(editor, comments, third)) < 2, 2000)
        expect(card(container, third).classList.contains('is-active')).toBe(true)
        expect(container.querySelector('.ezco-mde-comment.is-active')?.textContent).toBe('Paragraph 3 says')
        const boxes = visibleCards(container).map((c) => c.getBoundingClientRect())
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false)
    })

    it('folds resolved comments away until asked for', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        const done = idOf(comments, 'Done already.')
        expect(card(container, done)).toBeNull()
        await viaHeadMenu(container, 'Show resolved (1)')
        await waitFor(() => !!card(container, done), 2000)
        expect(card(container, done).classList.contains('is-resolved')).toBe(true)
        // Its text in the note reads as text: no mark of its own under it.
        const text = editor.view.dom.querySelector('.ezco-mde-comment.is-resolved') as HTMLElement
        expect(getComputedStyle(text).borderBottomStyle).toBe('none')
        expect(getComputedStyle(text).backgroundColor).toBe('rgba(0, 0, 0, 0)')
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

    it('writes a new comment over the note, by its text, with the panel beside the note', async () => {
        const { editor, container, comments } = await open(1100, 'panel')
        await waitFor(() => margin(container).classList.contains('is-panel'), 2000)
        await frames()
        const { from, to } = rangeOf(editor, 'number 7')
        editor.commands.setTextSelection({ from, to })
        editor.commands.startComment()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        // (Placed in the next frame.)
        await waitFor(() => (container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement).style.top !== '', 2000)
        const draft = container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement
        // Over the note, not in the panel: under the end of its text, by it.
        expect(margin(container).contains(draft)).toBe(false)
        expect(editor.view.dom.parentElement!.contains(draft)).toBe(true)
        expect(visibleCards(container).length).toBe(3)
        const end = editor.view.coordsAtPos(to, -1)
        const box = draft.getBoundingClientRect()
        expect(box.top).toBeGreaterThanOrEqual(end.bottom)
        expect(box.top).toBeLessThan(end.bottom + 16)
        expect(box.left).toBeLessThanOrEqual(end.left)
        expect(box.right).toBeLessThanOrEqual(editor.view.dom.getBoundingClientRect().right + 1)
        const field = draft.querySelector('.ezco-mde-comment-text') as HTMLElement
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard('Seven.')
        await userEvent.keyboard('{Control>}{Enter}{/Control}')
        await waitFor(() => comments.comments().length === 5, 4000)
        await waitFor(() => !container.querySelector('.ezco-mde-comment-card.is-draft'), 2000)
        // Posted, it is in the panel with the rest.
        await waitFor(() => visibleCards(container).length === 4, 3000)
        // Cancel puts the composer away without a comment.
        editor.commands.setTextSelection({ from, to })
        editor.commands.startComment()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft'), 2000)
        tool(container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement, 'Cancel').click()
        await waitFor(() => !container.querySelector('.ezco-mde-comment-card.is-draft'), 2000)
        expect(comments.comments().length).toBe(5)
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
        // The comment's mark carries the dot of a reply being drafted.
        await waitFor(() => markOfIn(container, first).classList.contains('has-draft'), 2000)
        expect(markOfIn(container, first).title).toBe('Comment by @alice')
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        await viaMenu(messageOf(card(container, first), first), 'Reply')
        await waitFor(() => composerIn(messageOf(card(container, first), first))?.textContent === 'Half a thought', 2000)
        await write(composerIn(messageOf(card(container, first), first))!, ' and the rest.')
        await waitFor(() => comments.comments().find((c) => c.id === first)!.replies.length === 1, 4000)
        expect(comments.comments().find((c) => c.id === first)!.replies[0].body).toBe('Half a thought and the rest.')
        expect(localStorage.getItem(`ezco-mde-comment-draft:Review.md:${first}:reply`)).toBeNull()
        await waitFor(() => !markOfIn(container, first).classList.contains('has-draft'), 2000)
        // The reply shows under its comment; nothing more is offered until asked.
        await waitFor(() => !!messageOf(card(container, first), comments.comments().find((c) => c.id === first)!.replies[0].id), 2000)
        expect(composerBlockIn(card(container, first))).toBeNull()
        expect(tool(card(container, first), 'Hide replies').textContent).toBe('1')
    })

    it('writes a reply at length as a file: the editor becomes the reply’s, its reference a portal to the passage', async () => {
        const { editor, container, comments, vault } = await open(900, 'float')
        const first = idOf(comments, 'First.')
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        tool(messageOf(card(container, first), first), 'Reply').click()
        await waitFor(() => document.activeElement === composerIn(messageOf(card(container, first), first)), 2000)
        await userEvent.keyboard('Started here')
        // The composer's menu offers the one long way: the document as the note.
        expect(await menuLabels(composerBlockIn(card(container, first))!)).toEqual(['Open as file'])
        await viaMenu(composerBlockIn(card(container, first))!, 'Open as file')
        // The reply's document, loaded as the note (the comments shown are
        // then the reply's own): its reference quotes the comment it answers,
        // and what was typed is under it.
        await waitFor(() => /^comments\/Review\/theo /.test((editor.storage as any).persistence.options.filepath ?? ''), 4000)
        const path = (editor.storage as any).persistence.options.filepath as string
        expect(await vault.fs.readFile(path)).toMatch(/^!\[\[comments\/Review\/alice 2026-09-13 12\.01#:~:text=First\.\]\]\n\nStarted here\n$/)
        // Its reference is a portal: the quoted words, who wrote them, the line.
        await waitFor(() => !!editor.view.dom.querySelector('.ezco-mde-embed--passage .ezco-mde-embed-body'), 3000)
        expect(editor.view.dom.querySelector('.ezco-mde-embed--passage .ezco-mde-embed-content')?.textContent?.trim()).toBe('First.')
        expect(editor.view.dom.querySelector('.ezco-mde-embed-meta')?.textContent).toBe('@alice · line 3')
        expect(editor.getText()).toContain('Started here')
    })

    it('reacts through the quick row and the full grid, resolves and closes, and shows the four most given reactions', async () => {
        const { editor, container, comments, vault } = await open(1100, 'column')
        const third = idOf(comments, 'Third, same line.')
        editor.commands.focusComment(third)
        await waitFor(() => card(container, third)?.classList.contains('is-active'), 2000)
        // The menu opens on the reactions to give: the common ones, two rows.
        tool(messageOf(card(container, third), third), 'Comment menu').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu .ezco-mde-reaction-grid'), 2000)
        const block = document.querySelector('.ezco-mde-reaction-grid') as HTMLElement
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
        await waitFor(() => !!document.querySelector('.ezco-mde-reaction-grid'), 2000)
        expect(tool(document.querySelector('.ezco-mde-reaction-grid') as HTMLElement, 'React 👍').getAttribute('aria-pressed')).toBe('true')
        tool(document.querySelector('.ezco-mde-reaction-grid') as HTMLElement, 'More emoji').click()
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
        await viaHeadMenu(container, 'Hide comments panel')
        await waitFor(() => margin(container).classList.contains('is-floating'), 3000)
        expect(container.querySelector('.ezco-mde-comments')).toBeNull()
        // Back within the note, beside its text again.
        expect(margin(container).style.width).toBe('')
        await waitFor(() => !!card(container, first) && editor.view.dom.contains(card(container, first)), 2000)
        await frames()
        const box = card(container, first).getBoundingClientRect()
        const start = editor.view.coordsAtPos(comments.comments().find((c) => c.id === first)!.target.range!.from, 1)
        expect(Math.abs(box.top - start.top)).toBeLessThan(start.bottom - start.top + 12)
        expect(box.left).toBeGreaterThan(start.right)
        expect(editor.commands.toggleCommentsPanel()).toBe(true)
        await waitFor(() => margin(container).classList.contains('is-panel'), 3000)
    })

    it('offers nothing to write or react with without an author', async () => {
        const { container, comments } = await open(1100, 'column', FILES, null)
        const first = idOf(comments, 'First.')
        expect([...card(container, first).querySelectorAll('.ezco-mde-comment-action')].map((b) => b.getAttribute('aria-label'))).toEqual(['No replies'])
        expect(await menuLabels(messageOf(card(container, first), first))).toEqual(['Open as file', 'Hide comments panel'])
        expect(card(container, first).querySelector('.ezco-mde-reaction-grid')).toBeNull()
    })

    it('opens an unwritten comment as a file with somewhere to write, saving it as it is typed', async () => {
        const { editor, container, comments, vault } = await open(900, 'float')
        editor.commands.setTextSelection(rangeOf(editor, 'number 7'))
        editor.commands.startComment()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        // Nothing typed yet: the composer's menu offers the long way; the
        // document is made and loaded as the note.
        expect(await menuLabels(container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement)).toEqual(['Open as file'])
        await viaMenu(container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement, 'Open as file')
        await waitFor(() => /^comments\/Review\/theo /.test((editor.storage as any).persistence.options.filepath ?? ''), 4000)
        const path = (editor.storage as any).persistence.options.filepath as string
        // The document exists, holding only its reference: not a comment until
        // something is written under it.
        expect(await vault.fs.readFile(path)).toBe('![[Review#:~:text=number%207]]\n')
        expect(comments.comments().some((c) => c.author === 'theo')).toBe(false)
        // The caret is in a paragraph of its own under the reference, ready for the text.
        await waitFor(() => editor.isFocused && editor.state.selection.$from.parent.type.name === 'paragraph', 2000)
        await userEvent.keyboard('Written as a file.')
        await waitFor(async () => (await vault.fs.readFile(path)).includes('![[Review#:~:text=number%207]]\n\nWritten as a file.'), 4000)
        expect(await vault.fs.exists(path)).toBe(true)
    })

    it('drops a reply opened as a file and left with nothing written', async () => {
        const { editor, container, comments, vault } = await open(900, 'float')
        const first = idOf(comments, 'First.')
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        tool(messageOf(card(container, first), first), 'Reply').click()
        await waitFor(() => document.activeElement === composerIn(messageOf(card(container, first), first)), 2000)
        await viaMenu(composerBlockIn(card(container, first))!, 'Open as file')
        await waitFor(() => /^comments\/Review\/theo /.test((editor.storage as any).persistence.options.filepath ?? ''), 4000)
        const path = (editor.storage as any).persistence.options.filepath as string
        expect(await vault.fs.exists(path)).toBe(true)
        // Left with nothing under its reference and put down (the note loaded
        // again), the document goes.
        await (editor.storage as any).persistence.loadFile('Review.md')
        await waitFor(async () => !(await vault.fs.exists(path)), 4000)
        await waitFor(() => comments.comments().find((c) => c.id === first)!.replies.length === 0, 3000)
    })

    it('marks a draft comment on its line, dashed, keeps it there when put down, and brings its composer back from the mark', async () => {
        const { editor, container, comments } = await open(900, 'float')
        await waitFor(() => marks(container).length === 3, 3000)
        const { from, to } = rangeOf(editor, 'number 7')
        const line = () => editor.view.coordsAtPos(from, 1)
        const draftMark = () => marks(container).find((m) => m.dataset.kind === 'draft')
        editor.commands.setTextSelection({ from, to })
        editor.commands.startComment()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        // Being written: a dashed mark of its own on the text's line, lit.
        await waitFor(() => !!draftMark(), 2000)
        expect(draftMark()!.classList.contains('is-draft')).toBe(true)
        expect(draftMark()!.classList.contains('is-active')).toBe(true)
        expect(draftMark()!.title).toBe('Your comment, being written')
        expect(draftMark()!.querySelector('path')?.getAttribute('stroke-dasharray')).not.toBeNull()
        const box = draftMark()!.getBoundingClientRect()
        expect(box.top + box.height / 2).toBeGreaterThan(line().top)
        expect(box.top + box.height / 2).toBeLessThan(line().bottom)
        expect(marks(container).length).toBe(4)
        // In the accent, not the comments' colour.
        expect(getComputedStyle(draftMark()!).color).not.toBe(getComputedStyle(markOfIn(container, idOf(comments, 'First.'))).color)
        const field = container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text') as HTMLElement
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard('Half a comment')
        await waitFor(() => localStorage.getItem('ezco-mde-comment-draft:Review.md:new:') === 'Half a comment', 2000)
        expect(localStorage.getItem('ezco-mde-comment-draft:Review.md:new:at')).toBe(':~:text=number%207')
        // Put down: the composer goes, the mark stays, unlit, with the draft.
        tool(container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement, 'Cancel').click()
        await waitFor(() => !container.querySelector('.ezco-mde-comment-card.is-draft'), 2000)
        await waitFor(() => !!draftMark() && !draftMark()!.classList.contains('is-active'), 2000)
        expect(draftMark()!.title).toBe('Your draft comment')
        expect(editor.view.dom.querySelector('.ezco-mde-comment.is-draft')).toBeNull()
        // The mark brings the composer back, on its words, with what was typed.
        draftMark()!.click()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        expect(container.querySelector('.ezco-mde-comment.is-draft')?.textContent).toBe('number 7')
        await waitFor(() => (container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text') as HTMLElement).textContent === 'Half a comment', 2000)
        await waitFor(() => draftMark()?.classList.contains('is-active') === true, 2000)
        // Pressed again while open, the composer takes the focus back.
        ;(editor.view.dom as HTMLElement).focus()
        draftMark()!.click()
        await waitFor(() => document.activeElement === container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        // Posted, the draft's mark is a comment's, and nothing is kept.
        await userEvent.keyboard(', finished.')
        await userEvent.keyboard('{Control>}{Enter}{/Control}')
        await waitFor(() => comments.comments().some((c) => c.author === 'theo'), 4000)
        await waitFor(() => !draftMark() && marks(container).length === 4, 3000)
        expect(localStorage.getItem('ezco-mde-comment-draft:Review.md:new:')).toBeNull()
        expect(localStorage.getItem('ezco-mde-comment-draft:Review.md:new:at')).toBeNull()
        const mine = comments.comments().find((c) => c.author === 'theo')!
        expect(mine.body).toBe('Half a comment, finished.')
        expect(markOfIn(container, mine.id).dataset.kind).toBe('comments')
    })

    it('names a second comment made in the same minute after its author too', () => {
        expect(authorOf('comments/Review/theo 2026-09-27 00.25 2.md')).toEqual({ author: 'theo', time: '2026-09-27T00:25' })
    })
})

describe('Within the note', () => {
    const paragraphOf = (editor: MarkdownEditor, text: string) => {
        const { node } = editor.view.domAtPos(rangeOf(editor, text).from)
        return (node instanceof HTMLElement ? node : node.parentElement!).closest('p') as HTMLElement
    }
    /** The right edge of a block's own text (not of a box in it). */
    const textRight = (block: HTMLElement) => {
        let right = -Infinity
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
        const range = document.createRange()
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.parentElement?.closest('.ezco-mde-comment-inline')) continue
            range.selectNodeContents(node)
            for (const r of range.getClientRects()) if (r.width > 0) right = Math.max(right, r.right)
        }
        return right
    }
    const lineTop = (editor: MarkdownEditor, text: string) => editor.view.coordsAtPos(rangeOf(editor, text).from).top
    const lineHeight = (block: HTMLElement) => parseFloat(getComputedStyle(block).lineHeight)

    it('stands an open comment beside its text, the paragraph in one column and the card in the other, and leaves the Markdown alone', async () => {
        const { editor, container, comments } = await open(900, 'float')
        await waitFor(() => marks(container).length === 3, 3000)
        const first = idOf(comments, 'First.')
        const markdown = getMarkdownContent(editor)
        const p2 = paragraphOf(editor, 'Paragraph 2 says')
        const p3 = paragraphOf(editor, 'Paragraph 3 says')
        const gap = p3.getBoundingClientRect().top - p2.getBoundingClientRect().bottom
        const wide = p2.getBoundingClientRect()
        markOfIn(container, first).click()
        await waitFor(() => visibleCards(container).length === 1, 2000)
        await frames()
        const box = card(container, first).parentElement as HTMLElement
        // In a box of the note's own, in the paragraph, which is a row now.
        expect(box.classList.contains('ezco-mde-comment-inline')).toBe(true)
        expect(box.parentElement).toBe(p2)
        expect(p2.classList.contains('ezco-mde-beside')).toBe(true)
        expect(box.getAttribute('contenteditable')).toBe('false')
        const b = box.getBoundingClientRect()
        const p = p2.getBoundingClientRect()
        // The card in the right column, half the paragraph at most, the text in the left one.
        expect(b.width).toBeLessThanOrEqual(300)
        expect(b.width).toBeGreaterThan(200)
        expect(b.right).toBeCloseTo(p.right, 0)
        expect(textRight(p2)).toBeLessThanOrEqual(b.left - 8)
        expect(parseFloat(getComputedStyle(p2).paddingRight)).toBeCloseTo(b.width + 16, 0)
        expect(p.width).toBeCloseTo(wide.width, 0)
        // Level with the line its text starts on, in the paragraph, which holds it; what follows is below it.
        expect(Math.abs(b.top - lineTop(editor, 'Paragraph 2 says'))).toBeLessThan(lineHeight(p2))
        expect(b.top).toBeGreaterThanOrEqual(p.top)
        expect(p.bottom).toBeGreaterThanOrEqual(b.bottom - 1)
        expect(p3.getBoundingClientRect().top).toBeGreaterThanOrEqual(p.bottom)
        for (const other of editor.view.dom.querySelectorAll(':scope > p')) if (other !== p2) expect(overlap(other.getBoundingClientRect(), b)).toBe(false)
        expect(getComputedStyle(card(container, first)).position).toBe('relative')
        // The card is the chrome's, not the note's: its own face, at the chrome's size.
        expect(getComputedStyle(box).fontSize).toBe('13px')
        expect(getComputedStyle(card(container, first).querySelector('.ezco-mde-comment-bubble') as HTMLElement).boxShadow).not.toBe('none')
        // The note's text is as it was, and so is its Markdown.
        expect(getMarkdownContent(editor)).toBe(markdown)
        expect(editor.state.doc.textContent).not.toContain('First.')
        expect(markOfIn(container, first).classList.contains('is-open')).toBe(true)
        // Escape in the card: the column is given back, the paragraphs are as they were, the note has the focus.
        card(container, first).focus()
        await userEvent.keyboard('{Escape}')
        await waitFor(() => comments.active() === null && !editor.view.dom.querySelector('.ezco-mde-comment-inline'), 3000)
        expect(p2.classList.contains('ezco-mde-beside')).toBe(false)
        expect(p2.style.paddingRight).toBe('')
        expect(p2.style.minHeight).toBe('')
        expect(p2.getBoundingClientRect().height).toBeCloseTo(wide.height, 0)
        expect(p3.getBoundingClientRect().top - p2.getBoundingClientRect().bottom).toBeCloseTo(gap, 0)
        expect(getMarkdownContent(editor)).toBe(markdown)
        await waitFor(() => editor.isFocused, 2000)
    })

    it('slides the card in from under the mark as the paragraph narrows into its column, and back out as the column is given back', async () => {
        const { editor, container, comments } = await open(900, 'float')
        await waitFor(() => marks(container).length === 3, 3000)
        const first = idOf(comments, 'First.')
        const p2 = paragraphOf(editor, 'Paragraph 2 says')
        const p3 = paragraphOf(editor, 'Paragraph 3 says')
        const p3Top = p3.getBoundingClientRect().top
        const wide = p2.getBoundingClientRect()
        markOfIn(container, first).click()
        await waitFor(() => visibleCards(container).length === 1, 2000)
        const box = card(container, first).parentElement as HTMLElement
        const moving = () => p2.getAnimations({ subtree: true }).filter((a) => a.playState !== 'finished')
        await waitFor(() => moving().length === 2, 2000)
        for (const a of moving()) a.pause()
        // At the start: the paragraph as it was, at its full width, the
        // card wholly right of it, clipped, level with the mark's line.
        for (const a of moving()) a.currentTime = 0
        await raf(1)
        let b = box.getBoundingClientRect()
        let p = p2.getBoundingClientRect()
        const mark = markOfIn(container, first).getBoundingClientRect()
        expect(parseFloat(getComputedStyle(p2).paddingRight)).toBe(0)
        expect(p.height).toBeCloseTo(wide.height, 0)
        expect(p3.getBoundingClientRect().top).toBeCloseTo(p3Top, 0)
        expect(b.left).toBeGreaterThanOrEqual(p.right)
        expect(Math.abs(b.left - mark.left)).toBeLessThan(32)
        expect(Math.abs(b.top - mark.top)).toBeLessThan(lineHeight(p2))
        expect(getComputedStyle(p2).overflow).toBe('clip')
        // Half way: the column part open and the text in it, the card part way in.
        for (const a of moving()) a.currentTime = 150
        await raf(1)
        b = box.getBoundingClientRect()
        p = p2.getBoundingClientRect()
        const pad = parseFloat(getComputedStyle(p2).paddingRight)
        expect(pad).toBeGreaterThan(0)
        expect(pad).toBeLessThan(b.width + 16)
        expect(b.left).toBeLessThan(p.right)
        expect(b.right).toBeGreaterThan(p.right)
        expect(textRight(p2)).toBeLessThanOrEqual(p.right - pad + 1)
        // At rest: the card in its column, the paragraph holding it, nothing clipped.
        for (const a of moving()) a.finish()
        await frames()
        b = box.getBoundingClientRect()
        p = p2.getBoundingClientRect()
        expect(b.right).toBeCloseTo(p.right, 0)
        expect(parseFloat(getComputedStyle(p2).paddingRight)).toBeCloseTo(b.width + 16, 0)
        expect(p.bottom).toBeGreaterThanOrEqual(b.bottom - 1)
        // Closing: the same way back out, the column closing behind it.
        card(container, first).focus()
        await userEvent.keyboard('{Escape}')
        await waitFor(() => moving().length === 2, 2000)
        for (const a of moving()) a.pause()
        for (const a of moving()) a.currentTime = 150
        await raf(1)
        b = box.getBoundingClientRect()
        p = p2.getBoundingClientRect()
        expect(b.right).toBeGreaterThan(p.right + 1)
        expect(parseFloat(getComputedStyle(p2).paddingRight)).toBeLessThan(b.width + 16)
        expect(parseFloat(getComputedStyle(p2).paddingRight)).toBeGreaterThan(0)
        for (const a of moving()) a.finish()
        await waitFor(() => comments.active() === null && !editor.view.dom.querySelector('.ezco-mde-comment-inline'), 3000)
        expect(p3.getBoundingClientRect().top).toBeCloseTo(p3Top, 0)
        expect(p2.style.paddingRight).toBe('')
    })

    it('opens two comments on a paragraph one under the other beside it, and a click elsewhere closes them', async () => {
        const { editor, container, comments } = await open(900, 'float')
        await waitFor(() => marks(container).length === 3, 3000)
        const second = idOf(comments, 'Second, a longer comment that wraps onto a few lines in the margin to take room.')
        markOfIn(container, second).click()
        await waitFor(() => visibleCards(container).length === 2, 2000)
        await frames()
        const p3 = paragraphOf(editor, 'Paragraph 3 says')
        const p4 = paragraphOf(editor, 'Paragraph 4 says')
        const [upper, lower] = visibleCards(container).map((c) => c.getBoundingClientRect()).sort((a, b) => a.top - b.top)
        const p = p3.getBoundingClientRect()
        expect(lower.top).toBeGreaterThanOrEqual(upper.bottom)
        expect(upper.top).toBeGreaterThanOrEqual(p.top)
        expect(p.bottom).toBeGreaterThanOrEqual(lower.bottom - 1)
        expect(textRight(p3)).toBeLessThanOrEqual(Math.min(upper.left, lower.left) - 8)
        expect(p4.getBoundingClientRect().top).toBeGreaterThanOrEqual(p.bottom)
        await userEvent.click(editor.view.dom.querySelector('h1') as HTMLElement)
        await waitFor(() => comments.active() === null && visibleCards(container).length === 0, 3000)
        expect(editor.view.dom.querySelector('.ezco-mde-comment-inline')).toBeNull()
        expect(p3.classList.contains('ezco-mde-beside')).toBe(false)
        expect(p3.style.paddingRight).toBe('')
    })

    it('stands the card under the paragraph instead where the reader asks, moving what follows down', async () => {
        const { editor, container, comments } = await open(900, 'float')
        await settingsOf(editor).set('comments.beside', false)
        const first = idOf(comments, 'First.')
        const p2 = paragraphOf(editor, 'Paragraph 2 says')
        const p3 = paragraphOf(editor, 'Paragraph 3 says')
        const gap = p3.getBoundingClientRect().top - p2.getBoundingClientRect().bottom
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        await frames()
        const box = card(container, first).parentElement as HTMLElement
        // In a box of the note's own after the paragraph, before the next, the column's width; the card in it at the left.
        expect(box.previousElementSibling).toBe(p2)
        expect(box.nextElementSibling).toBe(p3)
        expect(p2.classList.contains('ezco-mde-beside')).toBe(false)
        const b = box.getBoundingClientRect()
        expect(b.width).toBeCloseTo(p2.getBoundingClientRect().width, 0)
        expect(card(container, first).getBoundingClientRect().width).toBeLessThanOrEqual(480)
        expect(card(container, first).getBoundingClientRect().left).toBeCloseTo(b.left, 0)
        expect(p3.getBoundingClientRect().top - p2.getBoundingClientRect().bottom).toBeGreaterThan(gap + b.height - 1)
        for (const other of editor.view.dom.querySelectorAll(':scope > p')) expect(overlap(other.getBoundingClientRect(), b)).toBe(false)
        // Beside again when asked.
        await settingsOf(editor).set('comments.beside', true)
        await waitFor(() => card(container, first)?.parentElement?.parentElement === p2, 3000)
        await frames()
        expect(p2.classList.contains('ezco-mde-beside')).toBe(true)
        expect(editor.view.dom.querySelector(':scope > .ezco-mde-comment-inline')).toBeNull()
    })

    it('writes a reply within the note without touching the note', async () => {
        const { editor, container, comments } = await open(900, 'float')
        const first = idOf(comments, 'First.')
        const markdown = getMarkdownContent(editor)
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        expect(editor.view.dom.contains(card(container, first))).toBe(true)
        tool(messageOf(card(container, first), first), 'Reply').click()
        const field = () => composerIn(messageOf(card(container, first), first))!
        await waitFor(() => !!field() && document.activeElement === field(), 2000)
        await userEvent.keyboard('From within the note.')
        await waitFor(() => field().textContent === 'From within the note.', 2000)
        expect(getMarkdownContent(editor)).toBe(markdown)
        expect(editor.state.doc.textContent).not.toContain('From within')
        await userEvent.keyboard('{Control>}{Enter}{/Control}')
        await waitFor(() => comments.comments().find((c) => c.id === first)!.replies.length === 1, 4000)
        expect(comments.comments().find((c) => c.id === first)!.replies[0].body).toBe('From within the note.')
        expect(getMarkdownContent(editor)).toBe(markdown)
    })

    it('floats over the note instead where the host asks, and comes within it when the reader does', async () => {
        const { editor, container, comments } = await open(900, 'float', FILES, 'theo', false, undefined, false)
        const first = idOf(comments, 'First.')
        editor.commands.focusComment(first)
        await waitFor(() => !!card(container, first), 2000)
        await frames()
        expect(margin(container).contains(card(container, first))).toBe(true)
        expect(editor.view.dom.querySelector('.ezco-mde-comment-inline')).toBeNull()
        expect(getComputedStyle(card(container, first)).position).toBe('absolute')
        expect(margin(container).hidden).toBe(false)
        // The reader's choice is over the host's.
        await settingsOf(editor).set('comments.inline', true)
        await waitFor(() => !!card(container, first) && editor.view.dom.contains(card(container, first)), 3000)
        expect(margin(container).hidden).toBe(true)
        await settingsOf(editor).set('comments.inline', false)
        await waitFor(() => !!card(container, first) && margin(container).contains(card(container, first)), 3000)
        expect(editor.view.dom.querySelector('.ezco-mde-comment-inline')).toBeNull()
    })
})

describe('What a comment shows', () => {
    const openWith = async (files: Record<string, string>, layout: Layout = 'column', width = 1100, inline?: boolean) => {
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
            comments: { author: 'theo', index: vault.comments, reactions: vault.reactions, margin: { layout, ...(inline === undefined ? {} : { inline }) } },
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

    // (Floating over the note, `inline: false`: a card within the note has
    // the note's own scroll to be seen by.)
    it('keeps a floating card within the note’s frame, scrolling inside it', async () => {
        const long = Array.from({ length: 80 }, (_, i) => `Reply line ${i + 1}.`).join('\n\n')
        const files = {
            'Review.md': NOTE,
            'comments/Review/alice 2026-09-13 12.09.md': '![[Review#:~:text=Paragraph%201%20says]]\n\nShort.\n',
            'comments/Review/bob 2026-09-13 12.10.md': `![[comments/Review/alice 2026-09-13 12.09#:~:text=Short.]]\n\n${long}\n`,
        }
        const { editor, container, comments } = await openWith(files, 'float', 900, false)
        await waitFor(() => comments.comments().length === 1 && comments.comments()[0].replies.length === 1, 5000)
        editor.commands.focusComment(comments.comments()[0].id)
        await waitFor(() => visibleCards(container).length === 1, 2000)
        await waitFor(() => visibleCards(container)[0].querySelectorAll('.ezco-mde-comment-message').length === 2, 2000)
        const reply = comments.comments()[0].replies[0].id
        await waitFor(() => !tool(messageOf(visibleCards(container)[0], reply), 'Show the whole text').hidden, 3000)
        tool(messageOf(visibleCards(container)[0], reply), 'Show the whole text').click()
        await frames()
        const frame = container.getBoundingClientRect()
        expect(visibleCards(container)[0].getBoundingClientRect().height).toBeLessThanOrEqual(frame.height - 15)
        // Grown, the card stays under its text; the note is scrolled so the
        // whole of it is in the frame.
        await waitFor(() => {
            const box = visibleCards(container)[0].getBoundingClientRect()
            return box.top >= frame.top && box.bottom <= frame.bottom
        }, 4000)
        const inside = visibleCards(container)[0].querySelector('.ezco-mde-comment-inside') as HTMLElement
        expect(inside.scrollHeight).toBeGreaterThan(inside.clientHeight)
    })

    it('scrolls a floating card under the last lines into view, growing the note’s end for it, and gives the end back', async () => {
        // A comment on the last paragraph: its card has nowhere to be but
        // under the note's end.
        const longer = ['# Review', ...Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the longer part, nothing to say.`), ...paragraphs].join('\n\n') + '\n'
        const files = { ...FILES, 'Review.md': longer, ...Object.fromEntries([comment('erin', '08', 'Paragraph 12 says', 'At the end.')]) }
        const { editor, container, comments } = await openWith(files, 'float', 900, false)
        await waitFor(() => comments.comments().some((c) => c.body === 'At the end.'), 4000)
        const scroller = container
        const last = comments.comments().find((c) => c.body === 'At the end.')!
        scroller.scrollTop = scroller.scrollHeight
        const before = scroller.scrollHeight
        editor.commands.focusComment(last.id)
        await waitFor(() => !!card(container, last.id), 2000)
        const host = editor.view.dom.parentElement as HTMLElement
        await waitFor(() => parseFloat(host.style.paddingBottom || '0') > 0, 3000)
        expect(scroller.scrollHeight).toBeGreaterThan(before)
        await waitFor(() => {
            const box = card(container, last.id).getBoundingClientRect()
            const frame = scroller.getBoundingClientRect()
            return box.bottom <= frame.bottom + 1 && box.top >= editor.view.coordsAtPos(last.target.range!.to, -1).bottom - 1
        }, 4000)
        // Under its text still, not moved above it.
        expect(card(container, last.id).getBoundingClientRect().top).toBeGreaterThanOrEqual(editor.view.coordsAtPos(last.target.range!.to, -1).bottom)
        // Closed, the note's end is given back.
        editor.commands.focusComment(null)
        await waitFor(() => comments.active() === null, 2000)
        await waitFor(() => !host.style.paddingBottom, 2000)
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
        // The comment looked at is the current one. Looking at it does not
        // step its card out: only the note's scroll does that (so a card
        // clicked and one read past are never both stepped out).
        expect(card(container, third).classList.contains('is-current')).toBe(true)
        await frames()
        expect(shift(card(container, third))).toBe(0)
        // As the note is read past commented text, that comment is the current one.
        const done = idOf(comments, 'Done already.')
        await viaHeadMenu(container, 'Show resolved (1)')
        await waitFor(() => !!card(container, done), 2000)
        const textTop = (id: string) => editor.view.coordsAtPos(comments.comments().find((c) => c.id === id)!.target.range!.from, 1).top
        const frame = container.getBoundingClientRect()
        container.scrollTop += textTop(done) - (frame.top + frame.height * 0.3)
        container.dispatchEvent(new Event('scroll'))
        await waitFor(() => card(container, done).classList.contains('is-current'), 2000)
        expect(container.querySelectorAll('.ezco-mde-comment-card.is-current').length).toBe(1)
        // Its text at the reading line, the card has stepped out all the way
        // (32px); the others, far from the line, not at all; the note
        // scrolled on, it steps back in by how far the text is.
        await waitFor(() => shift(card(container, done)) < -31, 2000)
        expect(shift(card(container, third))).toBe(0)
        container.scrollTop -= frame.height * 0.2
        container.dispatchEvent(new Event('scroll'))
        await waitFor(() => shift(card(container, done)) > -31 && shift(card(container, done)) < -1, 2000)
        container.scrollTop = 0
        container.dispatchEvent(new Event('scroll'))
        await waitFor(() => !card(container, done).classList.contains('is-current'), 2000)
        expect(container.querySelectorAll('.ezco-mde-comment-card.is-current').length).toBe(1)
        await waitFor(() => shift(card(container, done)) === 0, 2000)
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

    it('takes the note to a comment clicked on its text, and anchors the cards to their text from the head’s menu, keeping the choice', async () => {
        // The commented paragraphs far enough down the note for it to scroll
        // any of them level with a bubble.
        const files = { ...FILES, 'Review.md': ['# Review', ...Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the longer part, nothing to say.`), ...paragraphs].join('\n\n') + '\n' }
        const { editor, container, comments, vault } = await open(1100, 'panel', files)
        await waitFor(() => margin(container).classList.contains('is-panel'), 2000)
        await frames()
        const third = idOf(comments, 'Third, same line.')
        const textTop = () => editor.view.coordsAtPos(comments.comments().find((c) => c.id === third)!.target.range!.from, 1).top
        // A click on the comment's own text (most of the bubble), not only
        // on the bubble's edge, takes the note there.
        const body = () => card(container, third).querySelector('.ezco-mde-comment-body') as HTMLElement
        await userEvent.click(body())
        await waitFor(() => comments.active() === third, 2000)
        const bubble = () => card(container, third).querySelector('.ezco-mde-comment-bubble.is-anchor') as HTMLElement
        await waitFor(() => Math.abs(textTop() - bubble().getBoundingClientRect().top) < 2, 4000)
        // From the head's menu, a switch that was off: the cards anchored
        // to their text, level with it, scrolling with the note (a column),
        // rather than a list of their own.
        expect(await viaHeadMenu(container, 'Anchor comments to text')).toBe('false')
        await waitFor(() => !margin(container).classList.contains('is-panel') && !margin(container).classList.contains('is-floating'), 2000)
        await frames()
        for (const c of visibleCards(container)) expect(c.style.top).not.toBe('')
        expect(getComputedStyle(margin(container)).position).not.toBe('sticky')
        // The one looked at exactly at its text (the others make way for it).
        expect(Math.abs(card(container, third).getBoundingClientRect().top - anchorTop(editor, comments, third))).toBeLessThan(2)
        // Anchored, the cards are still: none steps out as the note scrolls.
        container.scrollTop += 120
        container.dispatchEvent(new Event('scroll'))
        await frames()
        for (const c of visibleCards(container)) expect(shift(c)).toBe(0)
        expect(container.querySelectorAll('.ezco-mde-comment-card.is-current').length).toBeLessThanOrEqual(1)
        // The head stays at the top of the frame as the note scrolls, over
        // the cards passing under it.
        const head = margin(container).querySelector('.ezco-mde-comment-margin-head') as HTMLElement
        expect(getComputedStyle(head).position).toBe('sticky')
        container.scrollTop = 600
        container.dispatchEvent(new Event('scroll'))
        await frames()
        expect(head.getBoundingClientRect().top).toBeCloseTo(container.getBoundingClientRect().top, 0)
        expect(margin(container).getBoundingClientRect().height).toBeGreaterThanOrEqual(editor.view.dom.getBoundingClientRect().height - 1)
        // Kept, as a setting in the vault: another editor on it opens
        // anchored; the switch is on, and turns off.
        expect(settingsOf(editor).get('comments.anchored')).toBe(true)
        const deviceFile = settingsOf(editor).file('device')!
        await waitFor(async () => (await vault.fs.exists(deviceFile)) && (await vault.fs.readFile(deviceFile)).includes('anchored: true'), 3000)
        const again = await open(1100, 'panel', files, 'theo', false, vault.fs)
        await waitFor(() => again.container.querySelectorAll('.ezco-mde-comment-card').length === 3, 3000)
        await waitFor(() => !margin(again.container).classList.contains('is-panel'), 3000)
        await frames()
        for (const c of visibleCards(again.container)) expect(c.style.top).not.toBe('')
        const first = idOf(again.comments, 'First.')
        expect(Math.abs(card(again.container, first).getBoundingClientRect().top - anchorTop(again.editor, again.comments, first))).toBeLessThan(2)
        expect(await viaHeadMenu(again.container, 'Anchor comments to text')).toBe('true')
        await waitFor(() => margin(again.container).classList.contains('is-panel'), 2000)
        expect(settingsOf(again.editor).get('comments.anchored')).toBe(false)
    })

    it('marks each comment’s first line with a bubble in the column beside the note, level with the line; beside a panel a click looks at the comment, or at each in turn', async () => {
        const { editor, container, comments } = await open(1100, 'panel')
        await waitFor(() => margin(container).classList.contains('is-panel'), 2000)
        // Four comments on three lines: the second and third start on the
        // same paragraph (one mark for both); the fourth is resolved, and
        // marked still, its text no longer highlighted.
        await waitFor(() => marks(container).length === 3, 3000)
        const first = idOf(comments, 'First.')
        const second = idOf(comments, 'Second, a longer comment that wraps onto a few lines in the margin to take room.')
        const third = idOf(comments, 'Third, same line.')
        const done = idOf(comments, 'Done already.')
        const markOf = (id: string) => markOfIn(container, id)
        expect(markOf(third)).toBeDefined()
        expect(markOf(third)).toBe(markOf(second))
        expect(markOf(done).classList.contains('is-resolved')).toBe(true)
        expect(markOf(first).classList.contains('is-resolved')).toBe(false)
        expect(markOf(first).querySelector('svg')).not.toBeNull()
        expect(markOf(third).title).toBe('2 comments')
        // The column stands right of the note, before the panel, and the
        // mark on the first line of its comment's text.
        const column = container.querySelector('.ezco-mde-annotations') as HTMLElement
        const note = editor.view.dom.getBoundingClientRect()
        expect(column.getBoundingClientRect().left).toBeGreaterThanOrEqual(note.right - 1)
        expect(column.getBoundingClientRect().right).toBeLessThanOrEqual(margin(container).getBoundingClientRect().left + 1)
        const lineOf = (id: string) => editor.view.coordsAtPos(comments.comments().find((c) => c.id === id)!.target.range!.from, 1)
        const box = markOf(first).getBoundingClientRect()
        expect(box.top + box.height / 2).toBeGreaterThan(lineOf(first).top)
        expect(box.top + box.height / 2).toBeLessThan(lineOf(first).bottom)
        expect(box.left).toBeGreaterThanOrEqual(column.getBoundingClientRect().left)
        expect(box.right).toBeLessThanOrEqual(column.getBoundingClientRect().right)
        // The block glyphs in the gutter are untouched by the marks.
        expect(container.querySelectorAll('.ezco-mde-gutter .ezco-mde-comment-mark').length).toBe(0)
        // A click looks at the comment; on a line two start on, at each in turn.
        markOf(first).click()
        await waitFor(() => comments.active() === first, 2000)
        await waitFor(() => markOf(first).classList.contains('is-active'), 2000)
        markOf(third).click()
        await waitFor(() => comments.active() === third, 2000)
        markOf(third).click()
        await waitFor(() => comments.active() === second, 2000)
        markOf(third).click()
        await waitFor(() => comments.active() === third, 2000)
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
