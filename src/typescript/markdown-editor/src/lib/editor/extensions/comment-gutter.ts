/**
 * The annotation column: a narrow column right of the note (between it
 * and the comments panel, `.ezco-mde-annotations`) for what is said about
 * a line from beside it. For now that is each comment's mark: a speech
 * bubble in the comment colour on the first line of the comment's text, so
 * where the comments are can be seen at a glance, and a resolved one,
 * whose text reads as text again, can still be found. The comment looked
 * at has the fuller bubble, a resolved one an empty grey one. A line two
 * comments start on has one mark. (Reactions on a line, suggested changes
 * and the like would stand in the same column.)
 *
 * The mark is the way to a comment where nothing beside the note shows
 * them: a click opens the mark's comments over the note, all of them, and
 * a second click closes them. With a panel or column beside the note the
 * click looks at the comment, or at each in turn.
 */
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { commentsKey, type CommentInfo } from './comments'
import { byline } from './comment-render'
import { button, labelled, pressable } from '../ui/dom'
import { observeResize, rafThrottle } from '../ui/layout'

/** The mark: a speech bubble, filled by how much it is looked at (CSS). */
const MARK_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H8l-3.5 2.75V11.5h-2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'

class CommentGutter {
    private readonly marks: HTMLButtonElement[] = []
    private readonly pass = rafThrottle(() => this.layout())
    private readonly unobserve: () => void

    constructor(private readonly view: EditorView, private readonly editor: Editor) {
        this.unobserve = observeResize(view.dom, this.pass.schedule)
        this.pass.schedule()
    }

    /** The column beside the note, when the layout has one. */
    private column(): HTMLElement | null {
        const row = this.view.dom.parentElement?.parentElement
        return row?.classList.contains('ezco-mde-content') ? row.querySelector<HTMLElement>(':scope > .ezco-mde-annotations') : null
    }

    update() {
        this.pass.schedule()
    }

    private layout() {
        const column = this.column()
        if (!column || !this.view.dom.isConnected) return
        const state = commentsKey.getState(this.view.state)
        const comments = (state?.comments ?? []).filter((c) => c.target.range && !c.target.whole && c.target.range.to > c.target.range.from)
        const box = column.getBoundingClientRect()
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
                mark = pressable(button('ezco-mde-comment-mark'), (b, e) => {
                    e.preventDefault()
                    this.press(b)
                })
                mark.contentEditable = 'false'
                mark.innerHTML = MARK_ICON
                column.appendChild(mark)
                this.marks.push(mark)
            }
            // (As JSON: an id has spaces in it.)
            const ids = JSON.stringify(line.comments.map((c) => c.id))
            if (mark.dataset.comments !== ids) mark.dataset.comments = ids
            const [first] = line.comments
            const title =
                line.comments.length === 1
                    ? `${first.resolved ? 'Resolved comment' : 'Comment'} by ${byline(first)}`
                    : `${line.comments.length} comments`
            if (mark.title !== title) labelled(mark, title)
            const top = `${line.top.toFixed(2)}px`
            const height = `${line.height.toFixed(2)}px`
            if (mark.style.top !== top) mark.style.top = top
            if (mark.style.height !== height) mark.style.height = height
            mark.classList.toggle('is-active', line.comments.some((c) => c.id === state?.active))
            mark.classList.toggle('is-open', line.comments.some((c) => state?.open.includes(c.id)))
            mark.classList.toggle('is-resolved', line.comments.every((c) => c.resolved))
        })
    }

    /** Whether the comments float over the note (nothing beside it shows them). */
    private floating(): boolean {
        const margin = (this.editor.storage as Record<string, any>).commentMargin as { floating?: () => boolean } | undefined
        return margin?.floating?.() ?? true
    }

    /** A mark pressed: over the note, its comments opened, or closed when
     *  they all are; beside the note, its comment looked at, and where
     *  several start on the line, the one after the one looked at. */
    private press(mark: HTMLButtonElement) {
        const ids = JSON.parse(mark.dataset.comments ?? '[]') as string[]
        if (!ids.length) return
        if (this.floating()) {
            this.editor.commands.toggleComments(ids)
            return
        }
        const active = commentsKey.getState(this.view.state)?.active ?? ''
        this.editor.commands.focusComment(ids[(ids.indexOf(active) + 1) % ids.length])
    }

    destroy() {
        this.pass.cancel()
        this.unobserve()
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
