import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { createEditor, MarkdownEditor, type MarkdownEditorOptions } from '../index'
import { cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'
import type { CommentsStorage } from './comments'

/**
 * Threads in a real browser: measured boxes, so a card that drifts from its
 * text or covers another is caught; real keys into the composers.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
    for (const key of Object.keys(localStorage)) if (key.startsWith('ezco-mde-')) localStorage.removeItem(key)
})
const composerIn = (message: HTMLElement) => message.querySelector(':scope > .ezco-mde-comment-composer .ezco-mde-comment-text') as HTMLElement | null

const thread = (label: string, quote: string, body: string, status = 'open') =>
    `[^${label}]: @alice 2026-09-13T12:0${label.slice(-1)}Z · ${status} · [[#:~:text=${encodeURIComponent(quote)}]]\n    ${body}`

const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} says something worth a comment, number ${i + 1}.`)
const NOTE = [
    '# Review',
    ...paragraphs,
    thread('c-1', 'Paragraph 2 says', 'First.'),
    // Two threads on the same line: the second must go below the first.
    thread('c-2', 'worth a comment, number 3', 'Second, a longer comment that wraps onto a few lines in the margin to take room.') +
        '\n    - @bob 2026-09-13T12:05Z: A reply.\n      - @alice 2026-09-13T12:06Z: And one to that.',
    thread('c-3', 'Paragraph 3 says', 'Third, same line.'),
    thread('c-4', 'Paragraph 10 says', 'Done already.', 'resolved'),
].join('\n\n')

type Layout = 'float' | 'column'

async function open(width: number, layout: Layout, content = NOTE, options: Partial<MarkdownEditorOptions> = {}) {
    const container = document.createElement('div')
    container.style.cssText = `width: ${width}px; height: 700px; overflow-y: auto;`
    document.body.append(container)
    const editor = createEditor({ element: container, content, comments: { author: 'theo', margin: { layout } }, ...options })
    created.push({ editor, container })
    const comments = (editor.storage as any).comments as CommentsStorage
    await waitFor(() => comments.threads().length > 0, 3000)
    await frames()
    return { editor, container, comments }
}

/** Laid out, and done moving: cards glide to a new place. */
const frames = async (n = 3) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r))
    const moving = [...document.querySelectorAll('.ezco-mde-comment-card')].flatMap((c) => c.getAnimations())
    await Promise.all(moving.map((a) => a.finished.catch(() => {})))
}
const margin = (c: HTMLElement) => c.querySelector('.ezco-mde-comment-margin') as HTMLElement
const card = (c: HTMLElement, id: string) => c.querySelector(`.ezco-mde-comment-card[data-thread="${id}"]`) as HTMLElement
const visibleCards = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.ezco-mde-comment-card')].filter((e) => !e.hidden && !margin(c).hidden)
const anchorTop = (editor: MarkdownEditor, comments: CommentsStorage, id: string) =>
    editor.view.coordsAtPos(comments.threads().find((t) => t.id === id)!.anchor!).top
const overlap = (a: DOMRect, b: DOMRect) => a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
/** A control by what it is for (its label), within `el`. */
const tool = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent === label) as HTMLButtonElement
const messageAt = (el: HTMLElement, path: string) => el.querySelector(`.ezco-mde-comment-message[data-path="${path}"]`) as HTMLElement
const clickText = async (editor: MarkdownEditor, comments: CommentsStorage, id: string) => {
    const r = comments.threads().find((t) => t.id === id)!.targets[0].range!
    const at = editor.view.coordsAtPos(r.from + 2)
    const box = editor.view.dom.getBoundingClientRect()
    await userEvent.click(editor.view.dom, { position: { x: at.left - box.left, y: at.top - box.top + 4 } })
}
/** Type into a composer's field (a small editor), then post with ⌘/Ctrl+Enter. */
async function write(field: HTMLElement, text: string) {
    await waitFor(() => document.activeElement === field, 2000)
    await userEvent.keyboard(text)
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
}

describe('Threads float over the note', () => {
    it('show nothing until commented text is clicked, then the one thread by its text, and close on Escape', async () => {
        const { editor, container, comments } = await open(900, 'float')
        // No column was made, and nothing is beside or under the note.
        expect(container.querySelector('.ezco-mde-comments')).toBeNull()
        expect(margin(container).hidden).toBe(true)
        expect(visibleCards(container)).toEqual([])
        const noteWidth = editor.view.dom.getBoundingClientRect().width
        expect(noteWidth).toBeGreaterThan(700)

        await clickText(editor, comments, 'c-2')
        await waitFor(() => comments.active() === 'c-2', 2000)
        await waitFor(() => visibleCards(container).length === 1, 2000)
        await frames()
        const box = visibleCards(container)[0].getBoundingClientRect()
        // Just below its text (the scroll area has room), within the note's
        // edge, the note as wide as before.
        const text = comments.threads().find((t) => t.id === 'c-2')!.targets[0].range!
        const end = editor.view.coordsAtPos(text.to, -1).bottom
        expect(box.top).toBeGreaterThanOrEqual(end)
        expect(box.top - end).toBeLessThan(12)
        expect(box.bottom).toBeLessThanOrEqual(container.getBoundingClientRect().bottom)
        expect(box.right).toBeLessThanOrEqual(container.getBoundingClientRect().right)
        expect(editor.view.dom.getBoundingClientRect().width).toBe(noteWidth)
        // The note beside the card still takes clicks.
        const other = comments.threads().find((t) => t.id === 'c-1')!.targets[0].range!
        const line = editor.view.coordsAtPos(other.from + 1)
        const column = margin(container).getBoundingClientRect()
        const hit = document.elementFromPoint(column.left + 20, (line.top + line.bottom) / 2)
        expect(editor.view.dom.contains(hit)).toBe(true)

        visibleCards(container)[0].focus()
        await userEvent.keyboard('{Escape}')
        await waitFor(() => comments.active() === null, 2000)
        expect(margin(container).hidden).toBe(true)
        expect(editor.isFocused).toBe(true)
    })
})

describe('A column of threads', () => {
    it('puts each card level with its text, none over another', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        await waitFor(() => container.querySelectorAll('.ezco-mde-comment-card.is-placed').length === 3, 3000)
        const cards = visibleCards(container)
        expect(cards.map((c) => c.dataset.thread)).toEqual(['c-1', 'c-2', 'c-3'])
        // The first where its text is; each at or below its text.
        expect(Math.abs(card(container, 'c-1').getBoundingClientRect().top - anchorTop(editor, comments, 'c-1'))).toBeLessThan(2)
        for (const id of ['c-2', 'c-3']) expect(card(container, id).getBoundingClientRect().top).toBeGreaterThanOrEqual(anchorTop(editor, comments, id) - 1)
        const boxes = cards.map((c) => c.getBoundingClientRect())
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false)
        // Beside the note, in the column the editor made, not over it.
        expect(container.querySelector('.ezco-mde-comments .ezco-mde-comment-margin')).not.toBeNull()
        const body = editor.view.dom.getBoundingClientRect()
        for (const b of boxes) expect(b.left).toBeGreaterThanOrEqual(body.right - 1)
    })

    it('brings the card being looked at to its text, the others out of its way', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        // c-3 was pushed below c-2; clicking its text makes it the active one.
        await clickText(editor, comments, 'c-3')
        await waitFor(() => comments.active() === 'c-3', 2000)
        await waitFor(() => Math.abs(card(container, 'c-3').getBoundingClientRect().top - anchorTop(editor, comments, 'c-3')) < 2, 2000)
        expect(card(container, 'c-3').classList.contains('is-active')).toBe(true)
        expect(container.querySelector('.ezco-mde-comment.is-active')?.textContent).toBe('Paragraph 3 says')
        const boxes = visibleCards(container).map((c) => c.getBoundingClientRect())
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false)
    })

    it('folds resolved threads away until asked for', async () => {
        const { container } = await open(1100, 'column')
        expect(card(container, 'c-4')).toBeNull()
        tool(container, 'Show resolved (1)').click()
        await waitFor(() => !!card(container, 'c-4'), 2000)
        expect(card(container, 'c-4').classList.contains('is-resolved')).toBe(true)
        expect(card(container, 'c-4').textContent).toContain('Resolved')
    })

    it('floats after all where there is no room beside the note', async () => {
        const { editor, container, comments } = await open(560, 'column')
        await waitFor(() => margin(container).classList.contains('is-floating'), 2000)
        await frames()
        expect(editor.view.dom.getBoundingClientRect().width).toBeGreaterThan(400)
        expect(visibleCards(container)).toEqual([])
        editor.commands.focusComment('c-2')
        await waitFor(() => visibleCards(container).length === 1, 2000)
        expect(comments.active()).toBe('c-2')
    })
})

describe('Writing', () => {
    it('writes a new comment from the selection, in Markdown', async () => {
        const { editor, container, comments } = await openEmpty('# Plan\n\nWe ship it on Friday.')
        let from = -1
        editor.state.doc.descendants((node, pos) => {
            if (node.isText && node.text!.includes('ship it')) from = pos + node.text!.indexOf('ship it')
        })
        editor.commands.setTextSelection({ from, to: from + 'ship it'.length })
        editor.commands.startComment()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 2000)
        const field = container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text') as HTMLElement
        expect(container.querySelector('.ezco-mde-comment.is-draft')?.textContent).toBe('ship it')
        expect(field.classList.contains('ezco-mde-body')).toBe(true)
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard('Which *Friday*? ')
        // Typed as Markdown, shown as the note would show it.
        await waitFor(() => !!field.querySelector('em'), 2000)
        await userEvent.keyboard('{Control>}{Enter}{/Control}')
        await waitFor(() => comments.threads().length === 1, 2000)
        expect(comments.threads()[0].thread.body).toBe('Which *Friday*?')
        expect(getMarkdownContent(editor)).toMatch(/· open · \[\[#:~:text=ship%20it\]\]\n {4}Which \*Friday\*\?$/)
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card:not(.is-draft)'), 2000)
        expect(container.querySelector('.ezco-mde-comment-card .ezco-mde-comment-body em')?.textContent).toBe('Friday')
    })

    it('writes a reply right under its message, keeps the draft, and closes the thread on Cancel', async () => {
        const { editor, container, comments } = await open(900, 'float')
        editor.commands.focusComment('c-1')
        await waitFor(() => !!card(container, 'c-1'), 2000)
        // No composer until Reply is asked for; then it stands under the message.
        expect(card(container, 'c-1').querySelector('.ezco-mde-comment-composer')).toBeNull()
        tool(messageAt(card(container, 'c-1'), ''), 'Reply').click()
        await waitFor(() => !!composerIn(messageAt(card(container, 'c-1'), '')), 2000)
        const field = composerIn(messageAt(card(container, 'c-1'), ''))!
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard('Half a thought')
        await waitFor(() => localStorage.getItem('ezco-mde-comment-draft::c-1:') === 'Half a thought', 2000)
        tool(card(container, 'c-1').querySelector('.ezco-mde-comment-composer') as HTMLElement, 'Cancel').click()
        await waitFor(() => comments.active() === null, 2000)
        expect(margin(container).hidden).toBe(true)
        await waitFor(() => editor.isFocused, 2000)
        // Back later: the draft is offered, and the composer opens on it.
        editor.commands.focusComment('c-1')
        await waitFor(() => !!card(container, 'c-1'), 2000)
        expect(tool(messageAt(card(container, 'c-1'), ''), 'Reply').textContent).toBe('Reply · draft')
        tool(messageAt(card(container, 'c-1'), ''), 'Reply').click()
        await waitFor(() => composerIn(messageAt(card(container, 'c-1'), ''))?.textContent === 'Half a thought', 2000)
    })

    it('opens a full-size view over the note, with the thread and its passage, and posts from it', async () => {
        const { editor, container, comments } = await open(1000, 'float')
        editor.commands.focusComment('c-2')
        await waitFor(() => !!card(container, 'c-2'), 2000)
        tool(messageAt(card(container, 'c-2'), '0'), 'Reply to @bob').click()
        await waitFor(() => !!composerIn(messageAt(card(container, 'c-2'), '0')), 2000)
        await waitFor(() => document.activeElement === composerIn(messageAt(card(container, 'c-2'), '0')), 2000)
        await userEvent.keyboard('Started here, ')
        tool(card(container, 'c-2'), 'Open in editor').click()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-authoring'), 2000)
        const view = container.querySelector('.ezco-mde-comment-authoring') as HTMLElement
        // Over the note, with the words the thread is about and the thread itself beside the editor.
        expect(view.getBoundingClientRect().width).toBeGreaterThan(editor.view.dom.getBoundingClientRect().width - 1)
        expect(view.querySelector('.ezco-mde-comment-authoring-quote')?.textContent).toBe('worth a comment, number 3')
        expect(view.querySelectorAll('.ezco-mde-comment-authoring-thread .ezco-mde-comment-message').length).toBe(3)
        expect(view.querySelector('.ezco-mde-comment-authoring-head')?.textContent).toContain('Replying to @bob')
        // The draft came along (its trailing space is Markdown's to trim); the editor is full height and takes the rest.
        const full = view.querySelector('.ezco-mde-comment-composer.is-full .ezco-mde-comment-text') as HTMLElement
        expect(full.textContent).toBe('Started here,')
        expect(full.getBoundingClientRect().height).toBeGreaterThan(300)
        await waitFor(() => document.activeElement === full, 2000)
        await userEvent.keyboard('finished here.')
        await userEvent.keyboard('{Control>}{Enter}{/Control}')
        await waitFor(() => comments.threads().find((t) => t.id === 'c-2')!.thread.replies[0].replies.length === 2, 2000)
        expect(comments.threads().find((t) => t.id === 'c-2')!.thread.replies[0].replies[1].body).toBe('Started here,finished here.')
        expect(container.querySelector('.ezco-mde-comment-authoring')).toBeNull()
        expect(localStorage.getItem('ezco-mde-comment-draft::c-2:0')).toBeNull()
    })

    it('gives a draft back to the card when the full-size view is closed', async () => {
        const { editor, container } = await open(1000, 'float')
        editor.commands.focusComment('c-1')
        await waitFor(() => !!card(container, 'c-1'), 2000)
        tool(messageAt(card(container, 'c-1'), ''), 'Reply').click()
        await waitFor(() => document.activeElement === composerIn(messageAt(card(container, 'c-1'), '')), 2000)
        await userEvent.keyboard('Kept')
        tool(card(container, 'c-1'), 'Open in editor').click()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-authoring'), 2000)
        const full = container.querySelector('.ezco-mde-comment-composer.is-full .ezco-mde-comment-text') as HTMLElement
        await waitFor(() => document.activeElement === full, 2000)
        await userEvent.keyboard(' and more')
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !container.querySelector('.ezco-mde-comment-authoring'), 2000)
        await waitFor(() => composerIn(messageAt(card(container, 'c-1'), ''))?.textContent === 'Kept and more', 2000)
    })

    it('floats above code blocks’ toolbars', async () => {
        const { container } = await open(900, 'float')
        expect(Number(getComputedStyle(margin(container)).zIndex)).toBeGreaterThan(401)
    })

    it('keeps a floating card within the note, so opening one never lengthens the page', async () => {
        const { editor, container, comments } = await open(900, 'float')
        const before = container.scrollHeight
        // The last paragraph's thread, opened: the card fits above the note's end.
        editor.commands.addComment({ body: 'At the end.', ranges: [(() => { const r = { from: 0, to: 0 }; editor.state.doc.descendants((n, pos) => { if (n.isText && n.text!.includes('number 12')) { r.from = pos; r.to = pos + n.text!.length } }); return r })()] })
        await waitFor(() => comments.threads().length === 5, 2000)
        const id = comments.threads().find((t) => t.thread.body === 'At the end.')!.id
        editor.commands.focusComment(id)
        await waitFor(() => visibleCards(container).length === 1, 2000)
        await frames()
        const box = visibleCards(container)[0].getBoundingClientRect()
        // Within the scroll area (its text is near the note's end), and the page no longer.
        expect(box.bottom).toBeLessThanOrEqual(container.getBoundingClientRect().bottom + 1)
        expect(container.scrollHeight).toBe(before)
    })

    it('replies under the thread, reacts through the emoji chooser, and resolves from the message', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        editor.commands.focusComment('c-3')
        await waitFor(() => !!card(container, 'c-3'), 2000)
        tool(messageAt(card(container, 'c-3'), ''), 'Reply').click()
        await waitFor(() => !!composerIn(messageAt(card(container, 'c-3'), '')), 2000)
        await write(composerIn(messageAt(card(container, 'c-3'), ''))!, 'Agreed.')
        await waitFor(() => comments.threads().find((t) => t.id === 'c-3')!.thread.replies.length === 1, 2000)
        await waitFor(() => messageAt(card(container, 'c-3'), '0')?.textContent?.includes('Agreed.') ?? false, 2000)
        // A reaction from the quick row (the common ones), one click.
        tool(messageAt(card(container, 'c-3'), ''), 'React').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-reactions'), 2000)
        const quick = [...document.querySelectorAll<HTMLElement>('.ezco-mde-reactions .ezco-mde-emoji-cell')].map((c) => c.textContent)
        expect(quick.slice(0, 8)).toEqual(['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'])
        tool(document.querySelector('.ezco-mde-reactions') as HTMLElement, 'React 👍').click()
        await waitFor(() => !!card(container, 'c-3').querySelector('.ezco-mde-comment-reaction'), 2000)
        const chip = card(container, 'c-3').querySelector('.ezco-mde-comment-reaction') as HTMLElement
        expect(chip.textContent).toBe('👍 1')
        expect(chip.getAttribute('aria-pressed')).toBe('true')
        expect(document.querySelector('.ezco-mde-reactions')).toBeNull()
        // And one from the whole grid, searched for; the one just picked leads the recents.
        tool(messageAt(card(container, 'c-3'), ''), 'React').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-reactions'), 2000)
        tool(document.querySelector('.ezco-mde-reactions') as HTMLElement, 'More emoji').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-emoji-search'), 2000)
        // Never blank: the recent row (👍 just picked), then the first category.
        await waitFor(() => !!document.querySelector('.ezco-mde-emoji-grid .ezco-mde-emoji-cell'), 3000)
        expect(document.querySelector('.ezco-mde-emoji-heading')?.textContent).toBe('Recent')
        expect(document.querySelector('.ezco-mde-emoji-row .ezco-mde-emoji-cell')?.textContent).toBe('👍')
        expect(document.querySelector('.ezco-mde-emoji-grid .ezco-mde-emoji-cell')?.textContent).toBe('😀')
        const search = document.querySelector('.ezco-mde-emoji-search') as HTMLInputElement
        await waitFor(() => document.activeElement === search, 2000)
        await userEvent.keyboard('grinning face')
        await waitFor(() => document.querySelector('.ezco-mde-emoji-grid .ezco-mde-emoji-cell')?.textContent === '😀', 3000)
        await userEvent.keyboard('{Enter}')
        await waitFor(() => card(container, 'c-3').querySelectorAll('.ezco-mde-comment-reaction').length === 2, 2000)
        expect(document.querySelector('.ezco-mde-emoji-menu')).toBeNull()
        tool(messageAt(card(container, 'c-3'), ''), 'Resolve').click()
        await waitFor(() => comments.threads().find((t) => t.id === 'c-3')!.thread.status === 'resolved', 2000)
    })

    it('shows the four most given reactions, the rest behind +n', async () => {
        const many = ['👍', '👍', '😄', '🎉', '❤️', '🚀'].map((e, i) => `    - @u${i} 2026-09-13T12:1${i}Z: ${e}`).join('\n')
        const { container } = await open(1100, 'column', ['Some text here.', '', `[^c-8]: @alice 2026-09-13T12:04Z · open · [[#:~:text=text%20here]]\n    Loved.\n${many}`].join('\n'))
        const chips = () => [...card(container, 'c-8').querySelectorAll<HTMLElement>('.ezco-mde-comment-reaction')].map((c) => c.textContent)
        expect(chips()).toEqual(['👍 2', '😄 1', '🎉 1', '+2'])
        tool(card(container, 'c-8'), 'Show all 5 reactions').click()
        await waitFor(() => chips().length === 6, 2000)
        expect(chips()).toEqual(['👍 2', '😄 1', '🎉 1', '❤️ 1', '🚀 1', 'fewer'])
    })

    it('edits a message where it is, and deletes a reply or a whole thread after asking', async () => {
        const { editor, container, comments } = await open(1100, 'column')
        editor.commands.focusComment('c-2')
        await waitFor(() => card(container, 'c-2').classList.contains('is-active'), 2000)
        // Edit bob's reply in its place (from the message's menu): the composer stands where the body was.
        tool(messageAt(card(container, 'c-2'), '0'), 'More').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu'), 2000)
        tool(document.querySelector('.ezco-mde-comment-menu') as HTMLElement, 'Edit').click()
        await waitFor(() => !!messageAt(card(container, 'c-2'), '0')?.querySelector('.ezco-mde-comment-composer'), 2000)
        expect(messageAt(card(container, 'c-2'), '0').querySelector(':scope > .ezco-mde-comment-body')).toBeNull()
        const field = messageAt(card(container, 'c-2'), '0').querySelector('.ezco-mde-comment-text') as HTMLElement
        await waitFor(() => document.activeElement === field, 2000)
        await userEvent.keyboard(' Edited.')
        await userEvent.keyboard('{Control>}{Enter}{/Control}')
        await waitFor(() => comments.threads().find((t) => t.id === 'c-2')!.thread.replies[0].body === 'A reply. Edited.', 2000)
        // Delete the nested reply (alice's, not the author's: the note is the reader's file).
        tool(messageAt(card(container, 'c-2'), '0.0'), 'More').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu'), 2000)
        tool(document.querySelector('.ezco-mde-comment-menu') as HTMLElement, 'Delete').click()
        await waitFor(() => !!tool(messageAt(card(container, 'c-2'), '0.0'), 'Delete this comment'), 2000)
        tool(messageAt(card(container, 'c-2'), '0.0'), 'Delete this comment').click()
        await waitFor(() => comments.threads().find((t) => t.id === 'c-2')!.thread.replies[0].replies.length === 0, 2000)
        // The first message, answered by bob: a tombstone, bob's reply kept.
        tool(messageAt(card(container, 'c-2'), ''), 'More').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu'), 2000)
        tool(document.querySelector('.ezco-mde-comment-menu') as HTMLElement, 'Delete').click()
        await waitFor(() => !!tool(messageAt(card(container, 'c-2'), ''), 'Delete this comment'), 2000)
        tool(messageAt(card(container, 'c-2'), ''), 'Delete this comment').click()
        await waitFor(() => comments.threads().find((t) => t.id === 'c-2')?.thread.body === '[deleted]', 2000)
        expect(messageAt(card(container, 'c-2'), '').classList.contains('is-deleted')).toBe(true)
        expect(comments.threads().find((t) => t.id === 'c-2')!.thread.replies[0].body).toBe('A reply. Edited.')
        expect(getMarkdownContent(editor)).toContain('[^c-2]')
        // A message nobody answered goes, and the thread with it when it was the first.
        tool(messageAt(card(container, 'c-2'), '0'), 'More').click()
        await waitFor(() => !!document.querySelector('.ezco-mde-comment-menu'), 2000)
        tool(document.querySelector('.ezco-mde-comment-menu') as HTMLElement, 'Delete').click()
        await waitFor(() => !!tool(messageAt(card(container, 'c-2'), '0'), 'Delete this comment'), 2000)
        tool(messageAt(card(container, 'c-2'), '0'), 'Delete this comment').click()
        await waitFor(() => comments.threads().find((t) => t.id === 'c-2')?.thread.replies.length === 0, 2000)
        editor.commands.deleteComment('c-2')
        await waitFor(() => !comments.threads().some((t) => t.id === 'c-2'), 2000)
        expect(getMarkdownContent(editor)).not.toContain('[^c-2]')
    })

    it('folds a message’s replies away and back', async () => {
        const { container } = await open(1100, 'column')
        expect(messageAt(card(container, 'c-2'), '0')).not.toBeNull()
        tool(card(container, 'c-2'), 'Hide replies').click()
        await waitFor(() => messageAt(card(container, 'c-2'), '0') === null, 2000)
        expect(tool(card(container, 'c-2'), 'Show replies').textContent).toBe('▸ 1 reply')
        tool(card(container, 'c-2'), 'Show replies').click()
        await waitFor(() => messageAt(card(container, 'c-2'), '0') !== null, 2000)
    })

    it('offers nothing to write without an author', async () => {
        const { container } = await open(1100, 'column', NOTE, { comments: { margin: { layout: 'column' } } })
        expect(card(container, 'c-1').querySelector('.ezco-mde-comment-actions')).toBeNull()
    })
})

describe('A message’s Markdown', () => {
    it('is shown, and nothing in it runs', async () => {
        const body = '**Bold** and [[Zoology]] <img src="x" onerror="window.__ranImg = 1"> <script>window.__ranScript = 1</script> [x](javascript:alert(1))'
        const { container } = await open(1100, 'column', `Some text here.\n\n[^c-9]: @alice 2026-09-13T12:04Z · open · [[#:~:text=text%20here]]\n    ${body}`)
        const rendered = card(container, 'c-9').querySelector('.ezco-mde-comment-body') as HTMLElement
        expect(rendered.querySelector('strong')?.textContent).toBe('Bold')
        expect(rendered.querySelector('[data-wikilink]')?.textContent).toBe('Zoology')
        expect(rendered.querySelector('script, [onerror]')).toBeNull()
        expect(rendered.querySelector('a[href^="javascript" i]')).toBeNull()
        await frames()
        expect((window as any).__ranImg).toBeUndefined()
        expect((window as any).__ranScript).toBeUndefined()
    })
})

async function openEmpty(content: string) {
    const container = document.createElement('div')
    container.style.cssText = 'width: 1100px; height: 700px; overflow-y: auto;'
    document.body.append(container)
    const editor = createEditor({ element: container, content, comments: { author: 'theo' } })
    created.push({ editor, container })
    await waitFor(() => editor.getText().includes('Friday'), 3000)
    // The editor takes focus once created; a draft opened before that would
    // lose it.
    await waitFor(() => editor.isFocused, 3000)
    return { editor, container, comments: (editor.storage as any).comments as CommentsStorage }
}
