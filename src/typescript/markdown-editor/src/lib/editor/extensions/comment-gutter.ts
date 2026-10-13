/**
 * Comment marks in the gutter (the column the block glyphs stand in,
 * block-actions.ts): a speech bubble in the comment colour on the first
 * line of each comment's text, in the glyph column, so where the comments
 * are can be seen at a glance, and a resolved one, whose text reads as
 * text again, can still be found. The block's own glyph gives its line to
 * the mark (`coverGlyphs`). The comment looked at has the fuller bubble,
 * a resolved one an empty grey one. A line two comments start on has one
 * mark; a click on a mark looks at its comment, or at each in turn.
 */
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { commentsKey, type CommentInfo } from './comments'

/** The mark: a speech bubble, filled by how much it is looked at (CSS). */
const MARK_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8l-3.5 2.75V11.5h-2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'

/**
 * The block glyphs in `gutter` whose line a comment's mark stands on give
 * way to it. Both are laid out by script in their own frames, so whichever
 * is laid out last calls this and the two agree.
 */
export function coverGlyphs(gutter: HTMLElement) {
    const marks = [...gutter.querySelectorAll<HTMLElement>('.ezco-mde-comment-mark')].map((m) => {
        const top = parseFloat(m.style.top) || 0
        return { top, bottom: top + (parseFloat(m.style.height) || 0) }
    })
    for (const glyph of gutter.querySelectorAll<HTMLElement>('.ezco-mde-block-icon')) {
        const centre = (parseFloat(glyph.style.top) || 0) + (parseFloat(glyph.style.height) || 0) / 2
        glyph.classList.toggle('is-marked', marks.some((m) => centre >= m.top && centre <= m.bottom))
    }
}

class CommentGutter {
    private readonly marks: HTMLButtonElement[] = []
    private frame = 0
    private readonly observer: ResizeObserver | null

    constructor(private readonly view: EditorView, private readonly editor: Editor) {
        this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule())
        this.observer?.observe(view.dom)
        this.schedule()
    }

    /** The gutter beside the note, when the layout has one. */
    private gutter(): HTMLElement | null {
        const row = this.view.dom.parentElement?.parentElement
        return row?.classList.contains('ezco-mde-content') ? row.querySelector<HTMLElement>(':scope > .ezco-mde-gutter') : null
    }

    update() {
        this.schedule()
    }

    private schedule() {
        if (this.frame) return
        this.frame = requestAnimationFrame(() => {
            this.frame = 0
            this.layout()
        })
    }

    private layout() {
        const gutter = this.gutter()
        if (!gutter || !this.view.dom.isConnected) return
        const state = commentsKey.getState(this.view.state)
        const comments = (state?.comments ?? []).filter((c) => c.target.range && !c.target.whole && c.target.range.to > c.target.range.from)
        const box = gutter.getBoundingClientRect()
        // One mark per line comments start on, in the note's order.
        type Line = { top: number; height: number; comments: CommentInfo[] }
        const lines: Line[] = []
        for (const c of [...comments].sort((a, b) => a.target.range!.from - b.target.range!.from)) {
            let at: { top: number; bottom: number }
            try {
                at = this.view.coordsAtPos(c.target.range!.from, 1)
            } catch {
                continue
            }
            const top = at.top - box.top
            const height = at.bottom - at.top
            if (height <= 0) continue
            const line = lines.find((l) => Math.abs(l.top - top) < 1)
            if (line) line.comments.push(c)
            else lines.push({ top, height, comments: [c] })
        }
        while (this.marks.length > lines.length) this.marks.pop()!.remove()
        lines.forEach((line, i) => {
            let mark = this.marks[i]
            if (!mark) {
                mark = document.createElement('button')
                mark.type = 'button'
                mark.className = 'ezco-mde-comment-mark'
                mark.contentEditable = 'false'
                mark.innerHTML = MARK_ICON
                mark.addEventListener('mousedown', (e) => e.preventDefault())
                mark.addEventListener('click', (e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    this.look(e.currentTarget as HTMLButtonElement)
                })
                gutter.appendChild(mark)
                this.marks.push(mark)
            }
            // (As JSON: an id has spaces in it.)
            const ids = JSON.stringify(line.comments.map((c) => c.id))
            if (mark.dataset.comments !== ids) mark.dataset.comments = ids
            const [first] = line.comments
            const title =
                line.comments.length === 1
                    ? `${first.resolved ? 'Resolved comment' : 'Comment'} by ${first.time ? `@${first.author}` : first.author}`
                    : `${line.comments.length} comments`
            if (mark.title !== title) {
                mark.title = title
                mark.setAttribute('aria-label', title)
            }
            const top = `${line.top.toFixed(2)}px`
            const height = `${line.height.toFixed(2)}px`
            if (mark.style.top !== top) mark.style.top = top
            if (mark.style.height !== height) mark.style.height = height
            mark.classList.toggle('is-active', line.comments.some((c) => c.id === state?.active))
            mark.classList.toggle('is-resolved', line.comments.every((c) => c.resolved))
        })
        coverGlyphs(gutter)
    }

    /** A click on a mark looks at its comment: where several start on the
     *  line, at the one after the one looked at. */
    private look(mark: HTMLButtonElement) {
        const ids = JSON.parse(mark.dataset.comments ?? '[]') as string[]
        if (!ids.length) return
        const active = commentsKey.getState(this.view.state)?.active ?? ''
        this.editor.commands.focusComment(ids[(ids.indexOf(active) + 1) % ids.length])
    }

    destroy() {
        if (this.frame) cancelAnimationFrame(this.frame)
        this.observer?.disconnect()
        for (const mark of this.marks) mark.remove()
        this.marks.length = 0
    }
}

export const CommentMarks = Extension.create({
    name: 'commentMarks',

    addProseMirrorPlugins() {
        const editor = this.editor
        return [
            new Plugin({
                key: new PluginKey('commentMarks'),
                view: (view) => new CommentGutter(view, editor),
            }),
        ]
    },
})
