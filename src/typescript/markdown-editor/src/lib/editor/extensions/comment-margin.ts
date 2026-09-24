/**
 * The comment margin (comments RFC §4): beside the note, a card for each
 * thread about it, level with the text the thread points at and pushed down
 * so none overlap; the thread being looked at sits at its text, the others
 * moving out of its way. A card has the thread's first message and its
 * replies (Markdown), reactions as chips, and what can be done: reply,
 * react, edit or delete one's own message, resolve or reopen, pin, delete.
 * Resolved threads are folded away until asked for. A thread written in
 * another note says where; a target no longer in the note shows its quote,
 * with a way to anchor it again on the selection.
 *
 * Where a margin would leave the note too narrow, it becomes a popover: only
 * the card of the thread being looked at (click commented text), over the
 * note's edge.
 */
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { isReaction, parseTextFragment, type Message } from '@joinezco/storage'
import { commentsKey, type CommentsStorage, type CommentThreadInfo, type MessagePath } from './comments'

type Mount = HTMLElement | ((editorRoot: HTMLElement) => HTMLElement | null | void)

export interface CommentMarginOptions {
    /** Where the margin goes. `createEditor` gives it the column beside the
     *  note; without a mount it follows the editable. */
    mount?: Mount
}

/** Reactions offered (any emoji reply is one; these are a click away). */
const REACTIONS = ['👍', '❤️', '🎉', '😄', '👀', '✅']
/** The note is not squeezed narrower than this to make room for a margin. */
const NOTE_MIN = 400
const GAP = 8

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    if (className) e.className = className
    if (text !== undefined) e.textContent = text
    return e
}

const button = (label: string, onClick: () => void, className = 'ezco-mde-comment-button', title?: string) => {
    const b = el('button', className, label)
    b.type = 'button'
    if (title) {
        b.title = title
        b.setAttribute('aria-label', title)
    }
    // Clicking a control is not clicking the card, nor taking focus from
    // whatever is being typed in.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', (e) => {
        e.stopPropagation()
        onClick()
    })
    return b
}

/** `2026-09-13T12:04Z` as the reader's clock shows it. */
function when(time: string): string {
    const date = new Date(time)
    if (Number.isNaN(date.getTime())) return time
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ── Rendering a message's Markdown ──────────────────────────────────────────

const ALLOWED = new Set([
    'P', 'BR', 'STRONG', 'EM', 'B', 'I', 'S', 'DEL', 'CODE', 'PRE', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'SPAN', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SUP', 'SUB', 'IMG',
])
const DROPPED = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'LINK', 'META', 'BASE', 'FORM', 'SVG', 'MATH'])
const KEPT_ATTRIBUTES: Record<string, string[]> = {
    A: ['href', 'title'],
    IMG: ['src', 'alt', 'title'],
    SPAN: ['data-wikilink', 'data-target', 'data-fragment', 'data-alias'],
    TH: ['align'],
    TD: ['align'],
    OL: ['start'],
}

/** Only markup that shows text: a message may come from anyone the vault
 *  syncs with, and Markdown lets HTML through. */
function sanitize(root: DocumentFragment | Element): void {
    for (const node of [...root.children]) {
        if (DROPPED.has(node.tagName)) {
            node.remove()
            continue
        }
        sanitize(node)
        if (!ALLOWED.has(node.tagName)) {
            node.replaceWith(...node.childNodes)
            continue
        }
        const kept = KEPT_ATTRIBUTES[node.tagName] ?? []
        for (const attr of [...node.attributes]) if (!kept.includes(attr.name)) node.removeAttribute(attr.name)
        const url = node.getAttribute('href') ?? node.getAttribute('src')
        if (url !== null && !/^(?:https?:|mailto:|#|blob:)/i.test(url.trim())) {
            node.removeAttribute('href')
            node.removeAttribute('src')
        }
        if (node.tagName === 'A') {
            node.setAttribute('target', '_blank')
            node.setAttribute('rel', 'noopener noreferrer')
        }
    }
}

function renderMarkdown(editor: Editor, markdown: string): DocumentFragment {
    const md = (editor.storage as any).markdown?.parser?.md
    const template = document.createElement('template')
    if (md) template.innerHTML = md.render(markdown)
    else template.content.append(el('p', undefined, markdown))
    sanitize(template.content)
    return template.content
}

/** What an orphaned target pointed at, to show in its place. */
function quoteOf(fragment: string | null): string {
    if (!fragment) return 'the note'
    if (fragment.startsWith(':~:text=')) {
        const f = parseTextFragment(fragment)
        return f ? `“${f.end === null ? f.start : `${f.start} … ${f.end}`}”` : fragment
    }
    return fragment.startsWith('^') ? `block ^${fragment.slice(1)}` : `“${fragment}”`
}

// ── A card ──────────────────────────────────────────────────────────────────

class Composer {
    readonly dom: HTMLFormElement
    readonly input: HTMLTextAreaElement
    private readonly label: HTMLElement

    constructor(submitLabel: string, onSubmit: (body: string) => void, onCancel: () => void) {
        this.dom = el('form', 'ezco-mde-comment-composer')
        this.label = el('div', 'ezco-mde-comment-composer-label')
        this.input = el('textarea', 'ezco-mde-comment-input')
        this.input.rows = 2
        this.input.placeholder = 'Write a comment…'
        this.input.setAttribute('aria-label', 'Comment')
        const submit = el('button', 'ezco-mde-comment-button is-primary', submitLabel)
        submit.type = 'submit'
        const cancel = button('Cancel', onCancel)
        const row = el('div', 'ezco-mde-comment-composer-actions')
        row.append(cancel, submit)
        this.dom.append(this.label, this.input, row)
        this.dom.addEventListener('submit', (e) => {
            e.preventDefault()
            if (this.input.value.trim()) onSubmit(this.input.value)
        })
        this.dom.addEventListener('mousedown', (e) => e.stopPropagation())
        this.dom.addEventListener('click', (e) => e.stopPropagation())
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                this.dom.requestSubmit()
            }
            e.stopPropagation()
        })
        this.input.addEventListener('input', () => {
            this.input.style.height = 'auto'
            this.input.style.height = `${this.input.scrollHeight}px`
        })
    }

    say(label: string) {
        this.label.textContent = label
        this.label.hidden = !label
    }

    focus() {
        requestAnimationFrame(() => this.input.focus())
    }
}

class Card {
    readonly dom: HTMLElement
    private readonly content: HTMLElement
    private readonly actions: HTMLElement
    private composer: Composer | null = null
    /** What the composer is for: a reply to, or an edit of, a message. */
    private composing: { mode: 'reply' | 'edit'; path: MessagePath } | null = null
    private key = ''
    info!: CommentThreadInfo

    constructor(private readonly margin: Margin, readonly id: string) {
        this.dom = el('article', 'ezco-mde-comment-card')
        this.dom.dataset.thread = id
        this.content = el('div', 'ezco-mde-comment-content')
        this.actions = el('div', 'ezco-mde-comment-actions')
        this.dom.append(this.content, this.actions)
        this.dom.addEventListener('mousedown', (e) => {
            if ((e.target as HTMLElement).closest('a, button, textarea, [data-wikilink]')) return
            if (this.margin.active() !== this.id) this.margin.editor.commands.focusComment(this.id)
        })
        this.dom.addEventListener('click', (e) => {
            const link = (e.target as HTMLElement).closest('[data-wikilink]') as HTMLElement | null
            if (!link) return
            e.preventDefault()
            void (this.margin.editor.storage as any).wikilink?.follow(link.dataset.target ?? '', link.dataset.fragment ?? null)
        })
    }

    update(info: CommentThreadInfo, active: boolean, author: string | null) {
        this.info = info
        const t = info.thread
        this.dom.classList.toggle('is-active', active)
        this.dom.classList.toggle('is-resolved', t.status === 'resolved')
        this.dom.classList.toggle('is-orphaned', info.orphaned)
        this.dom.classList.toggle('is-elsewhere', !!info.ref)
        this.dom.setAttribute('aria-label', `Comment by @${t.author}`)
        const key = JSON.stringify([t, info.targets.map((x) => [x.orphaned, x.elsewhere]), info.ref?.source, active, author])
        if (key === this.key) return
        this.key = key
        this.render(author, active)
    }

    private render(author: string | null, active: boolean) {
        const { editor } = this.margin
        const info = this.info
        const t = info.thread
        const parts: Node[] = []
        if (info.ref) {
            const where = el('div', 'ezco-mde-comment-where', 'In ')
            where.append(
                button(info.ref.source, () => void (editor.storage as any).wikilink?.follow(info.ref!.source.replace(/\.md$/i, ''), null), 'ezco-mde-comment-link'),
            )
            parts.push(where)
        }
        info.targets.forEach((target, i) => {
            if (!target.orphaned) return
            const orphan = el('div', 'ezco-mde-comment-orphan')
            orphan.append(el('span', 'ezco-mde-comment-quote', quoteOf(target.link.fragment)), el('span', undefined, ' is no longer in the note.'))
            if (author && info.pos !== null) {
                orphan.append(
                    button('Anchor to selection', () => editor.commands.anchorComment(this.id, i), 'ezco-mde-comment-link', 'Point this at the selected text instead'),
                )
            }
            parts.push(orphan)
        })
        parts.push(this.message(t, [], author))
        this.content.replaceChildren(...parts)

        // What can be done, on the card being looked at.
        const actions: Node[] = []
        if (author && active) {
            actions.push(button('Reply', () => this.compose('reply', [])))
            actions.push(
                t.status === 'open'
                    ? button('Resolve', () => editor.commands.resolveComment(this.id), 'ezco-mde-comment-button', 'Resolve this thread')
                    : button('Reopen', () => editor.commands.reopenComment(this.id)),
            )
            if (info.pos !== null && info.targets.some((x) => x.range && x.link.fragment?.startsWith(':~:text='))) {
                actions.push(button('Pin', () => editor.commands.pinComment(this.id), 'ezco-mde-comment-button', 'Mark the text in the note, so the comment moves with it'))
            }
            if (t.author === author) actions.push(button('Delete', () => editor.commands.deleteComment(this.id), 'ezco-mde-comment-button is-danger', 'Delete this thread'))
        }
        if (this.margin.narrow) actions.push(button('×', () => editor.commands.focusComment(null), 'ezco-mde-comment-button is-close', 'Close'))
        this.actions.replaceChildren(...actions)
        if (this.composer) this.dom.append(this.composer.dom)
    }

    /** A message, its reactions, and its replies (nested). */
    private message(m: Message, path: MessagePath, author: string | null): HTMLElement {
        const { editor } = this.margin
        const box = el('div', path.length ? 'ezco-mde-comment-message is-reply' : 'ezco-mde-comment-message')
        const head = el('div', 'ezco-mde-comment-head')
        const time = el('time', 'ezco-mde-comment-time', when(m.time))
        time.dateTime = m.time
        time.title = m.time
        head.append(el('span', 'ezco-mde-comment-author', `@${m.author}`), time)
        if (!path.length && this.info.thread.status === 'resolved') head.append(el('span', 'ezco-mde-comment-status', 'Resolved'))
        const body = el('div', 'ezco-mde-comment-body')
        body.append(renderMarkdown(editor, m.body))
        box.append(head, body)

        // Reactions: emoji-only replies, gathered per emoji.
        const reactions = new Map<string, string[]>()
        const replies: [Message, number][] = []
        m.replies.forEach((r, i) => {
            if (isReaction(r.body) && !r.replies.length) reactions.set(r.body.trim(), [...(reactions.get(r.body.trim()) ?? []), r.author])
            else replies.push([r, i])
        })
        const chips = el('div', 'ezco-mde-comment-reactions')
        for (const [emoji, who] of reactions) {
            const chip = button(`${emoji} ${who.length}`, () => author && editor.commands.reactToComment(this.id, emoji, path), 'ezco-mde-comment-reaction', who.map((a) => `@${a}`).join(', '))
            chip.setAttribute('aria-pressed', String(!!author && who.includes(author)))
            chips.append(chip)
        }
        if (author) {
            const picker = el('div', 'ezco-mde-comment-picker')
            picker.hidden = true
            for (const emoji of REACTIONS) picker.append(button(emoji, () => editor.commands.reactToComment(this.id, emoji, path), 'ezco-mde-comment-emoji', `React ${emoji}`))
            const tools = el('div', 'ezco-mde-comment-tools')
            tools.append(button('☺', () => (picker.hidden = !picker.hidden), 'ezco-mde-comment-tool', 'React'))
            if (path.length) tools.append(button('Reply', () => this.compose('reply', path), 'ezco-mde-comment-tool'))
            if (m.author === author) {
                tools.append(button('Edit', () => this.compose('edit', path), 'ezco-mde-comment-tool'))
                if (path.length) tools.append(button('Delete', () => editor.commands.deleteComment(this.id, path), 'ezco-mde-comment-tool'))
            }
            head.append(tools)
            chips.append(picker)
        }
        if (chips.childElementCount) box.append(chips)
        if (replies.length) {
            const list = el('div', 'ezco-mde-comment-replies')
            for (const [r, i] of replies) list.append(this.message(r, [...path, i], author))
            box.append(list)
        }
        return box
    }

    private compose(mode: 'reply' | 'edit', path: MessagePath) {
        const { editor } = this.margin
        if (this.margin.active() !== this.id) editor.commands.focusComment(this.id)
        this.composing = { mode, path }
        if (!this.composer) {
            this.composer = new Composer(
                'Send',
                (body) => {
                    const c = this.composing
                    if (!c) return
                    const done = c.mode === 'edit' ? editor.commands.editComment(this.id, body, c.path) : editor.commands.replyToComment(this.id, body, c.path)
                    if (done) this.closeComposer()
                },
                () => this.closeComposer(),
            )
            this.dom.append(this.composer.dom)
        }
        const target = path.length ? this.messageAt(path) : null
        this.composer.say(mode === 'edit' ? 'Editing' : target ? `Replying to @${target.author}` : '')
        this.composer.input.value = mode === 'edit' ? this.messageAt(path)?.body ?? '' : ''
        this.composer.input.dispatchEvent(new Event('input'))
        this.composer.focus()
        this.margin.schedule()
    }

    private messageAt(path: MessagePath): Message | null {
        let at: Message | undefined = this.info.thread
        for (const i of path) at = at?.replies[i]
        return at ?? null
    }

    private closeComposer() {
        this.composer?.dom.remove()
        this.composer = null
        this.composing = null
        this.margin.schedule()
    }

    destroy() {
        this.dom.remove()
    }
}

class Draft {
    readonly dom: HTMLElement
    private readonly composer: Composer

    constructor(margin: Margin, author: string) {
        const { editor } = margin
        this.dom = el('article', 'ezco-mde-comment-card is-draft is-active')
        this.dom.setAttribute('aria-label', 'New comment')
        const head = el('div', 'ezco-mde-comment-head')
        head.append(el('span', 'ezco-mde-comment-author', `@${author}`), el('span', 'ezco-mde-comment-time', 'New comment'))
        this.composer = new Composer(
            'Comment',
            (body) => {
                const draft = (editor.storage as any).comments.draft() as { ranges: { from: number; to: number }[] } | null
                editor.commands.addComment({ body, ranges: draft?.ranges ?? [] })
            },
            () => {
                editor.commands.cancelComment()
                editor.commands.focus()
            },
        )
        this.dom.append(head, this.composer.dom)
        this.composer.focus()
    }

    destroy() {
        this.dom.remove()
    }
}

// ── The margin ──────────────────────────────────────────────────────────────

class Margin {
    readonly dom: HTMLElement
    private readonly head: HTMLElement
    private readonly list: HTMLElement
    private readonly cards = new Map<string, Card>()
    private draft: Draft | null = null
    private showResolved = false
    narrow = false
    private frame = 0
    private readonly observer: ResizeObserver | null
    private readonly onScroll = () => this.schedule()

    constructor(
        readonly editor: Editor,
        private readonly view: EditorView,
        options: CommentMarginOptions,
    ) {
        this.dom = el('section', 'ezco-mde-comment-margin')
        this.dom.setAttribute('aria-label', 'Comments')
        this.head = el('header', 'ezco-mde-comment-margin-head')
        this.list = el('div', 'ezco-mde-comment-list')
        this.dom.append(this.head, this.list)
        const root = (view.dom.closest('.ezco-mde') as HTMLElement | null) ?? view.dom
        const mount = options.mount
        const host = mount instanceof HTMLElement ? mount : typeof mount === 'function' ? mount(root) ?? null : null
        if (host) host.appendChild(this.dom)
        else view.dom.after(this.dom)
        this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule())
        this.observer?.observe(view.dom)
        if (view.dom.parentElement) this.observer?.observe(view.dom.parentElement)
        document.addEventListener('scroll', this.onScroll, true)
        this.update()
    }

    private get comments(): CommentsStorage {
        return (this.editor.storage as any).comments as CommentsStorage
    }

    active(): string | null {
        return commentsKey.getState(this.view.state)?.active ?? null
    }

    update() {
        const state = commentsKey.getState(this.view.state)
        if (!state) return
        const author = this.comments.author()
        const resolved = state.threads.filter((t) => t.thread.status === 'resolved').length
        const visible = state.threads.filter((t) => t.thread.status === 'open' || this.showResolved || t.id === state.active)
        this.dom.hidden = !state.threads.length && !state.draft
        this.dom.classList.toggle('is-narrow', this.narrow)

        const open = state.threads.length - resolved
        const title = el('span', 'ezco-mde-comment-margin-title', open === 1 ? '1 comment' : `${open} comments`)
        this.head.replaceChildren(title)
        if (resolved) {
            this.head.append(
                button(this.showResolved ? 'Hide resolved' : `Show resolved (${resolved})`, () => {
                    this.showResolved = !this.showResolved
                    this.update()
                }, 'ezco-mde-comment-link'),
            )
        }

        const seen = new Set<string>()
        for (const info of visible) {
            let card = this.cards.get(info.id)
            if (!card) {
                card = new Card(this, info.id)
                this.cards.set(info.id, card)
                this.list.append(card.dom)
            }
            card.update(info, state.active === info.id, author)
            card.dom.hidden = this.narrow && state.active !== info.id
            seen.add(info.id)
        }
        for (const [id, card] of this.cards) {
            if (seen.has(id)) continue
            card.destroy()
            this.cards.delete(id)
        }
        if (state.draft && author) {
            if (!this.draft) {
                this.draft = new Draft(this, author)
                this.list.append(this.draft.dom)
            }
        } else {
            this.draft?.destroy()
            this.draft = null
        }
        this.schedule()
    }

    schedule() {
        if (this.frame) return
        this.frame = requestAnimationFrame(() => {
            this.frame = 0
            this.layout()
        })
    }

    /** Where each card goes: level with its text, none overlapping, the
     *  active one (or the draft) exactly at its text. */
    layout() {
        if (this.dom.hidden || !this.view.dom.isConnected) return
        // Narrow: the note would be squeezed below NOTE_MIN beside the margin.
        const host = this.view.dom.parentElement
        if (host) {
            const width = this.dom.offsetWidth || 256
            const room = host.clientWidth - (this.narrow ? width : 0)
            const narrow = room < NOTE_MIN
            if (narrow !== this.narrow) {
                this.narrow = narrow
                for (const card of this.cards.values()) card.update(card.info, this.active() === card.id, this.comments.author())
                this.update()
                return
            }
        }
        const state = commentsKey.getState(this.view.state)
        if (!state) return
        const origin = this.list.getBoundingClientRect().top
        // Beside the note, a card is level with its text; over it (narrow),
        // just below its text, so the text stays in view.
        const at = (range: { from: number; to: number } | null) => {
            if (!range) return 0
            try {
                const size = this.view.state.doc.content.size
                return this.narrow
                    ? this.view.coordsAtPos(Math.min(range.to, size), -1).bottom - origin + GAP
                    : this.view.coordsAtPos(Math.min(range.from, size)).top - origin
            } catch {
                return 0
            }
        }
        const placed: { dom: HTMLElement; want: number; height: number; top: number; fixed: boolean }[] = []
        for (const info of state.threads) {
            const card = this.cards.get(info.id)
            if (!card || card.dom.hidden) continue
            const anchored = info.targets.find((t) => t.range)?.range ?? null
            placed.push({ dom: card.dom, want: at(anchored), height: card.dom.offsetHeight, top: 0, fixed: info.id === state.active })
        }
        if (this.draft && state.draft) {
            placed.push({ dom: this.draft.dom, want: at(state.draft.ranges[0] ?? null), height: this.draft.dom.offsetHeight, top: 0, fixed: true })
        }
        placed.sort((a, b) => a.want - b.want || Number(b.fixed) - Number(a.fixed))
        const pin = placed.findIndex((p) => p.fixed)
        if (pin < 0) {
            let y = 0
            for (const p of placed) y = (p.top = Math.max(p.want, y)) + p.height + GAP
        } else {
            // The active card at its text; those above it moved up out of
            // its way, those below down.
            placed[pin].top = Math.max(0, placed[pin].want)
            let limit = placed[pin].top - GAP
            for (let i = pin - 1; i >= 0; i--) limit = (placed[i].top = Math.min(placed[i].want, limit - placed[i].height)) - GAP
            // Nothing above the margin's top: push everything down if needed.
            const overflow = Math.min(0, ...placed.slice(0, pin + 1).map((p) => p.top))
            if (overflow < 0) for (let i = 0; i <= pin; i++) placed[i].top -= overflow
            let y = placed[pin].top + placed[pin].height + GAP
            for (let i = pin + 1; i < placed.length; i++) y = (placed[i].top = Math.max(placed[i].want, y)) + placed[i].height + GAP
        }
        let bottom = 0
        for (const p of placed) {
            p.dom.style.transform = `translateY(${Math.round(p.top)}px)`
            // A card's first place is taken at once; later moves glide.
            if (!p.dom.classList.contains('is-placed')) {
                void p.dom.offsetHeight
                p.dom.classList.add('is-placed')
            }
            bottom = Math.max(bottom, p.top + p.height)
        }
        this.list.style.minHeight = `${Math.ceil(bottom)}px`
    }

    destroy() {
        if (this.frame) cancelAnimationFrame(this.frame)
        this.observer?.disconnect()
        document.removeEventListener('scroll', this.onScroll, true)
        this.dom.remove()
    }
}

export const CommentMargin = Extension.create<CommentMarginOptions>({
    name: 'commentMargin',

    addOptions() {
        return { mount: undefined }
    },

    addProseMirrorPlugins() {
        const editor = this.editor
        const options = this.options
        return [
            new Plugin({
                key: new PluginKey('commentMargin'),
                view: (view) => {
                    const margin = new Margin(editor, view, options)
                    return {
                        update: (_view, previous) => {
                            if (commentsKey.getState(view.state) !== commentsKey.getState(previous)) margin.update()
                        },
                        destroy: () => margin.destroy(),
                    }
                },
            }),
        ]
    },
})
