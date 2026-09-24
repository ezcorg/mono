import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { createEditor, MarkdownEditor } from '../index'
import { cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'
import type { CommentsStorage } from './comments'

/**
 * The comment margin in a real browser: measured boxes, so a card that
 * drifts from its text or covers another is caught.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const thread = (label: string, quote: string, body: string, status = 'open') =>
    `[^${label}]: @alice 2026-09-13T12:0${label.slice(-1)}Z · ${status} · [[#:~:text=${encodeURIComponent(quote)}]]\n    ${body}`

const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} says something worth a comment, number ${i + 1}.`)
const NOTE = [
    '# Review',
    ...paragraphs,
    thread('c-1', 'Paragraph 2 says', 'First.'),
    // Two threads on the same line: the second must go below the first.
    thread('c-2', 'worth a comment, number 3', 'Second, a longer comment that wraps onto a few lines in the margin to take room.'),
    thread('c-3', 'Paragraph 3 says', 'Third, same line.'),
    thread('c-4', 'Paragraph 10 says', 'Done already.', 'resolved'),
].join('\n\n')

async function open(width: number, content = NOTE) {
    const container = document.createElement('div')
    container.style.cssText = `width: ${width}px; height: 700px; overflow-y: auto;`
    document.body.append(container)
    const editor = createEditor({ element: container, content, comments: { author: 'theo' } })
    created.push({ editor, container })
    const comments = (editor.storage as any).comments as CommentsStorage
    await waitFor(() => container.querySelectorAll('.ezco-mde-comment-card').length > 0, 3000)
    await frames()
    return { editor, container, comments }
}

/** Laid out, and done moving: cards glide to a new place. */
const frames = async (n = 3) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r))
    const moving = [...document.querySelectorAll('.ezco-mde-comment-card')].flatMap((c) => c.getAnimations())
    await Promise.all(moving.map((a) => a.finished.catch(() => {})))
}
const card = (c: HTMLElement, id: string) => c.querySelector(`.ezco-mde-comment-card[data-thread="${id}"]`) as HTMLElement
const visibleCards = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.ezco-mde-comment-card')].filter((e) => !e.hidden)
const anchorTop = (editor: MarkdownEditor, comments: CommentsStorage, id: string) =>
    editor.view.coordsAtPos(comments.threads().find((t) => t.id === id)!.anchor!).top
const overlap = (a: DOMRect, b: DOMRect) => a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5

describe('The comment margin', () => {
    it('puts each card level with its text, none over another', async () => {
        const container0 = document.createElement('div')
        container0.style.cssText = 'width: 1100px; height: 700px; overflow-y: auto;'
        document.body.append(container0)
        const first = createEditor({ element: container0, content: NOTE, comments: { author: 'theo' } })
        created.push({ editor: first, container: container0 })
        await waitFor(() => container0.querySelectorAll('.ezco-mde-comment-card.is-placed').length === 3, 3000)
        // Placed where they belong at once, not flown in from the top.
        expect(visibleCards(container0).flatMap((c) => c.getAnimations())).toEqual([])

        const { editor, container, comments } = await open(1100)
        const cards = visibleCards(container)
        expect(cards.map((c) => c.dataset.thread)).toEqual(['c-1', 'c-2', 'c-3'])
        // The first where its text is; each at or below its text.
        expect(Math.abs(card(container, 'c-1').getBoundingClientRect().top - anchorTop(editor, comments, 'c-1'))).toBeLessThan(2)
        for (const id of ['c-2', 'c-3']) expect(card(container, id).getBoundingClientRect().top).toBeGreaterThanOrEqual(anchorTop(editor, comments, id) - 1)
        const boxes = cards.map((c) => c.getBoundingClientRect())
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false)
        // Beside the note, not over it.
        const body = editor.view.dom.getBoundingClientRect()
        for (const b of boxes) expect(b.left).toBeGreaterThanOrEqual(body.right - 1)
    })

    it('brings the card being looked at to its text, the others out of its way', async () => {
        const { editor, container, comments } = await open(1100)
        // c-3 was pushed below c-2; clicking its text makes it the active one.
        const r = comments.threads().find((t) => t.id === 'c-3')!.targets[0].range!
        const at = editor.view.coordsAtPos(r.from + 2)
        await userEvent.click(editor.view.dom, { position: { x: at.left - editor.view.dom.getBoundingClientRect().left, y: at.top - editor.view.dom.getBoundingClientRect().top + 4 } })
        await waitFor(() => comments.active() === 'c-3', 2000)
        await waitFor(() => Math.abs(card(container, 'c-3').getBoundingClientRect().top - anchorTop(editor, comments, 'c-3')) < 2, 2000)
        expect(card(container, 'c-3').classList.contains('is-active')).toBe(true)
        expect(container.querySelector('.ezco-mde-comment.is-active')?.textContent).toBe('Paragraph 3 says')
        const boxes = visibleCards(container).map((c) => c.getBoundingClientRect())
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false)
    })

    it('folds resolved threads away until asked for', async () => {
        const { container } = await open(1100)
        expect(card(container, 'c-4')).toBeNull()
        const toggle = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show resolved (1)')!
        toggle.click()
        await waitFor(() => !!card(container, 'c-4'), 2000)
        expect(card(container, 'c-4').classList.contains('is-resolved')).toBe(true)
        expect(card(container, 'c-4').textContent).toContain('Resolved')
    })

    it('writes a new comment from the selection', async () => {
        const { editor, container, comments } = await openEmpty('# Plan\n\nWe ship it on Friday.')
        let from = -1
        editor.state.doc.descendants((node, pos) => {
            if (node.isText && node.text!.includes('ship it')) from = pos + node.text!.indexOf('ship it')
        })
        editor.commands.setTextSelection({ from, to: from + 'ship it'.length })
        editor.commands.startComment()
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft textarea'), 2000)
        const input = container.querySelector('.ezco-mde-comment-card.is-draft textarea') as HTMLTextAreaElement
        await waitFor(() => document.activeElement === input, 2000)
        expect(container.querySelector('.ezco-mde-comment.is-draft')?.textContent).toBe('ship it')
        await userEvent.type(input, 'Which Friday?')
        await userEvent.keyboard('{Control>}{Enter}{/Control}')
        await waitFor(() => comments.threads().length === 1, 2000)
        expect(comments.threads()[0].thread.body).toBe('Which Friday?')
        expect(getMarkdownContent(editor)).toMatch(/· open · \[\[#:~:text=ship%20it\]\]\n {4}Which Friday\?$/)
        await waitFor(() => !!container.querySelector('.ezco-mde-comment-card:not(.is-draft)'), 2000)
        expect(container.querySelector('.ezco-mde-comment-card .ezco-mde-comment-body')?.textContent).toBe('Which Friday?')
    })

    it('replies, reacts and resolves from a card', async () => {
        const { container, comments } = await open(1100)
        card(container, 'c-1').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        await waitFor(() => comments.active() === 'c-1', 2000)
        const buttonIn = (el: HTMLElement, label: string) =>
            [...el.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement
        buttonIn(card(container, 'c-1'), 'Reply').click()
        const input = card(container, 'c-1').querySelector('textarea') as HTMLTextAreaElement
        await waitFor(() => document.activeElement === input, 2000)
        await userEvent.type(input, 'Agreed.')
        buttonIn(card(container, 'c-1'), 'Send').click()
        await waitFor(() => comments.threads()[0].thread.replies.length === 1, 2000)
        await waitFor(() => card(container, 'c-1').querySelector('.ezco-mde-comment-message.is-reply')?.textContent?.includes('Agreed.') ?? false, 2000)
        // A reaction, as a chip that is the author's own.
        buttonIn(card(container, 'c-1'), 'React').click()
        buttonIn(card(container, 'c-1'), 'React 👍').click()
        await waitFor(() => !!card(container, 'c-1').querySelector('.ezco-mde-comment-reaction'), 2000)
        const chip = card(container, 'c-1').querySelector('.ezco-mde-comment-reaction') as HTMLElement
        expect(chip.textContent).toBe('👍 1')
        expect(chip.getAttribute('aria-pressed')).toBe('true')
        buttonIn(card(container, 'c-1'), 'Resolve this thread').click()
        await waitFor(() => comments.threads()[0].thread.status === 'resolved', 2000)
    })

    it('becomes a popover over the note’s edge when there is no room beside it', async () => {
        const { editor, container, comments } = await open(560)
        const margin = container.querySelector('.ezco-mde-comment-margin') as HTMLElement
        await waitFor(() => margin.classList.contains('is-narrow'), 2000)
        await frames()
        // The note keeps its width; no card until a comment is looked at.
        expect(editor.view.dom.getBoundingClientRect().width).toBeGreaterThan(400)
        expect(visibleCards(container)).toEqual([])
        editor.commands.focusComment('c-2')
        await waitFor(() => visibleCards(container).length === 1, 2000)
        await frames()
        const box = visibleCards(container)[0].getBoundingClientRect()
        const view = container.getBoundingClientRect()
        expect(box.right).toBeLessThanOrEqual(view.right)
        expect(box.left).toBeGreaterThanOrEqual(view.left)
        // Just below its text, which it does not cover.
        const text = comments.threads().find((t) => t.id === 'c-2')!.targets[0].range!
        const end = editor.view.coordsAtPos(text.to, -1).bottom
        expect(box.top).toBeGreaterThanOrEqual(end)
        expect(box.top - end).toBeLessThan(12)
        // The note beside the card still takes clicks (the margin's empty
        // space over it does not).
        const other = comments.threads().find((t) => t.id === 'c-1')!.targets[0].range!
        const line = editor.view.coordsAtPos(other.from + 1)
        const column = margin.getBoundingClientRect()
        expect(line.bottom).toBeLessThan(box.top)
        const hit = document.elementFromPoint(column.left + 20, (line.top + line.bottom) / 2)
        expect(editor.view.dom.contains(hit)).toBe(true)
        // And the card itself does.
        const resolve = [...visibleCards(container)[0].querySelectorAll('button')].find((b) => b.textContent === 'Resolve')!.getBoundingClientRect()
        expect(document.elementFromPoint(resolve.left + resolve.width / 2, resolve.top + resolve.height / 2)?.textContent).toBe('Resolve')
    })

    it('shows a message’s Markdown, and nothing that would run', async () => {
        const body = '**Bold** and [[Zoology]] <img src="x" onerror="window.__ranImg = 1"> <script>window.__ranScript = 1</script> [x](javascript:alert(1))'
        const { container } = await open(1100, `Some text here.\n\n[^c-9]: @alice 2026-09-13T12:04Z · open · [[#:~:text=text%20here]]\n    ${body}`)
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
