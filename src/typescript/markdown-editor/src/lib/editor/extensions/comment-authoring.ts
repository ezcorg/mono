/**
 * The full-size view for writing a comment: over the note, the thread and
 * the passage it is about on one side, a full-height editor of the note's
 * own make on the other. Opened from a card's composer ("Open in editor"),
 * it takes that composer's draft and gives it back on close; posting works
 * as it does in the card. Escape closes it.
 */
import type { AnyExtension, Editor } from '@tiptap/core'
import { isReaction, type Message } from '@joinezco/storage'
import { Composer } from './comment-composer'
import { renderMarkdown, when } from './comment-render'
import { scrollerOf } from './rail'

export interface AuthoringOptions {
    editor: Editor
    extensions?: AnyExtension[]
    /** The words the thread is about, shown above it. */
    quote: string | null
    /** The thread, shown as it is. */
    thread: Message
    /** What the editor is for ("Replying to @bob", "Editing"). */
    title: string
    initial: string
    submitLabel: string
    onChange: (markdown: string) => void
    onSubmit: (markdown: string) => void
    onClose: () => void
}

export class Authoring {
    readonly dom: HTMLElement
    private readonly composer: Composer

    constructor(private readonly options: AuthoringOptions) {
        const { editor } = options
        this.dom = document.createElement('section')
        this.dom.className = 'ezco-mde-comment-authoring'
        this.dom.setAttribute('role', 'dialog')
        this.dom.setAttribute('aria-label', options.title)

        const side = document.createElement('aside')
        side.className = 'ezco-mde-comment-authoring-thread'
        if (options.quote) {
            const quote = document.createElement('blockquote')
            quote.className = 'ezco-mde-comment-authoring-quote'
            quote.textContent = options.quote
            side.append(quote)
        }
        side.append(this.message(options.thread, 0))

        const main = document.createElement('div')
        main.className = 'ezco-mde-comment-authoring-main'
        const head = document.createElement('header')
        head.className = 'ezco-mde-comment-authoring-head'
        const title = document.createElement('span')
        title.textContent = options.title
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'ezco-mde-comment-tool is-close'
        close.textContent = '×'
        close.title = 'Back to the note'
        close.setAttribute('aria-label', 'Back to the note')
        close.addEventListener('click', () => options.onClose())
        head.append(title, close)
        this.composer = new Composer({
            editor,
            extensions: options.extensions,
            placeholder: 'Write…',
            submitLabel: options.submitLabel,
            initial: options.initial,
            full: true,
            onChange: options.onChange,
            onSubmit: options.onSubmit,
            onCancel: options.onClose,
        })
        main.append(head, this.composer.dom)
        this.dom.append(side, main)
        this.dom.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                options.onClose()
            }
        })
        const host = (editor.view.dom.closest('.ezco-mde-content') as HTMLElement | null) ?? editor.view.dom.parentElement ?? document.body
        host.append(this.dom)
        // At least the scroll area's height, from where the reader is.
        const scroller = scrollerOf(host)
        const viewport = scroller ? scroller.clientHeight : window.innerHeight
        const top = scroller ? Math.max(0, scroller.scrollTop - (host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop)) : 0
        this.dom.style.top = `${top}px`
        this.dom.style.minHeight = `${viewport}px`
        this.composer.focus()
    }

    private message(m: Message, depth: number): HTMLElement {
        const box = document.createElement('div')
        box.className = 'ezco-mde-comment-message' + (depth ? ' is-reply' : '')
        const head = document.createElement('div')
        head.className = 'ezco-mde-comment-head'
        const author = document.createElement('span')
        author.className = 'ezco-mde-comment-author'
        author.textContent = `@${m.author}`
        const time = document.createElement('time')
        time.className = 'ezco-mde-comment-time'
        time.textContent = when(m.time)
        head.append(author, time)
        const body = document.createElement('div')
        body.className = 'ezco-mde-comment-body'
        body.append(renderMarkdown(this.options.editor, m.body))
        box.append(head, body)
        const replies = m.replies.filter((r) => !isReaction(r.body))
        if (replies.length) {
            const list = document.createElement('div')
            list.className = 'ezco-mde-comment-replies'
            for (const r of replies) list.append(this.message(r, depth + 1))
            box.append(list)
        }
        return box
    }

    value(): string {
        return this.composer.value()
    }

    destroy() {
        this.composer.destroy()
        this.dom.remove()
    }
}
