/**
 * Where a note's threads are read and written (comments RFC §4).
 *
 * By default nothing shows beside the note: commented text is marked, and
 * clicking it (or `focusComment`) opens that one thread as a card over the
 * note's edge, by its text; Escape, or a click elsewhere, closes it
 * (`layout: 'float'`). A floating card can be dragged by its head and
 * resized by its corner, and stays where it was put. A host that wants
 * every open thread in view asks for a column (`layout: 'column'`): each
 * thread a card level with its first target, cards pushed apart so none
 * overlap, the one being looked at at its text and the others moved out of
 * its way, resolved threads folded away until asked for. Where a column
 * would leave the note too narrow it floats after all.
 *
 * A card is the thread's messages, each with its author and time and its
 * body rendered as Markdown; replies nested, folding on a click. Under each
 * message, one row: its reactions (the four most given; the rest behind
 * "+n"), then React (the common reactions and recent ones at once, the
 * whole grid on request), Reply, Resolve or Reopen on the thread's first
 * message, and a "more" menu with Edit (in place) and Delete (asked once,
 * in the row). A reply is written right under the message it answers, in
 * the editor itself in small (`Composer`), and what is typed is kept as a
 * draft in this browser until it is posted; "Open in editor" writes the
 * same draft in a full-size view over the note (`Authoring`). Deleting a
 * message others have answered leaves a tombstone so their replies keep
 * their place. A comment is text in the reader's own file, so no message is
 * theirs to read and not to change: authorship is a name written down, not
 * a lock (the RFC's §6, until devices sign what they write).
 */
import { Extension, type AnyExtension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { isReaction, parseTextFragment, type Message } from '@joinezco/storage'
import { DELETED_BODY, commentsKey, messageAt, type CommentsStorage, type CommentThreadInfo, type MessagePath } from './comments'
import { Composer } from './comment-composer'
import { Authoring } from './comment-authoring'
import { clearDraft, draftKey, readDraft, renderMarkdown, when, writeDraft } from './comment-render'
import { openReactionPicker } from './emoji-picker'
import { ContextMenu, type ContextMenuItem } from '../ui/context-menu'
import { scrollerOf } from './rail'
import type { FileSystemStorage } from './filesystem'
import tippy, { type Instance as TippyInstance } from 'tippy.js'

type Mount = HTMLElement | ((editorRoot: HTMLElement) => HTMLElement | null | void)

export interface CommentMarginOptions {
    /** Where a column goes (`createEditor` gives it the column beside the
     *  note; without a mount it follows the editable). */
    mount?: Mount
    /** `float` (default): the thread looked at, over the note's edge.
     *  `column`: every open thread beside the note. */
    layout?: 'float' | 'column'
    /** The extensions a comment is written with (the note's setup without
     *  its chrome, from `createEditor`); `minimalSetup` without. */
    composer?: () => AnyExtension[]
}

/** The note is not squeezed narrower than this to make room for a column. */
const NOTE_MIN = 400
const GAP = 8
/** Reactions shown on a message before the rest fold behind "+n". */
const REACTIONS_SHOWN = 4

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    if (className) e.className = className
    if (text !== undefined) e.textContent = text
    return e
}

const button = (label: string, onClick: (b: HTMLButtonElement) => void, className = 'ezco-mde-comment-button', title?: string) => {
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
        onClick(b)
    })
    return b
}

const pathKey = (path: MessagePath) => path.join('.')

/** The React control's glyph: a face with a plus, as reactions are drawn. */
const REACT_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm0 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM5.5 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM5.3 9.6a.75.75 0 0 1 1.05.15c.4.53 1 .85 1.65.85s1.25-.32 1.65-.85a.75.75 0 1 1 1.2.9A3.55 3.55 0 0 1 8 12.1a3.55 3.55 0 0 1-2.85-1.45.75.75 0 0 1 .15-1.05Z"/></svg>'

/** A menu of `items` under `anchor`; closes on a choice, Escape or a click
 *  elsewhere. */
function openMenu(anchor: HTMLElement, items: ContextMenuItem[]): void {
    let popup: TippyInstance | null = null
    let outside: ((e: MouseEvent) => void) | null = null
    const close = () => {
        if (outside) document.removeEventListener('mousedown', outside)
        outside = null
        menu.disable()
        popup?.destroy()
        popup = null
        menu.destroy()
    }
    const menu = new ContextMenu({
        className: 'ezco-mde-comment-menu',
        items: items.map((item) => ({ ...item, onSelect: () => (close(), item.onSelect()) })),
        onClose: () => (close(), anchor.focus()),
    })
    const created = tippy(anchor, {
        appendTo: () => document.body,
        content: menu.dom,
        showOnCreate: true,
        interactive: true,
        trigger: 'manual',
        placement: 'bottom-start',
        theme: 'ezco-mde-block-actions',
        maxWidth: 'none',
        onMount: () => requestAnimationFrame(() => menu.enable()),
    }) as TippyInstance | TippyInstance[]
    popup = Array.isArray(created) ? created[0] : created
    outside = (e: MouseEvent) => {
        if (!menu.dom.contains(e.target as Node) && !anchor.contains(e.target as Node)) close()
    }
    setTimeout(() => { if (outside) document.addEventListener('mousedown', outside) }, 0)
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

/** A message's reactions (emoji-only replies), by emoji, most given first. */
function reactionsOf(m: Message): [string, string[]][] {
    const by = new Map<string, string[]>()
    for (const r of m.replies) {
        if (!isReaction(r.body) || r.replies.length) continue
        const emoji = r.body.trim()
        by.set(emoji, [...(by.get(emoji) ?? []), r.author])
    }
    return [...by].sort((a, b) => b[1].length - a[1].length)
}

// ── A card ──────────────────────────────────────────────────────────────────

class Card {
    readonly dom: HTMLElement
    private readonly context: HTMLElement
    private readonly messages: HTMLElement
    /** The message a reply is being written under, and its composer. */
    private replying: { key: string; path: MessagePath; composer: Composer } | null = null
    /** A message being edited: its composer stands where its body was. */
    private editing: { key: string; composer: Composer } | null = null
    /** The message whose deletion is being asked about. */
    private confirming: string | null = null
    /** Replies folded away, by the message they are under. */
    private folded = new Set<string>()
    /** Messages whose reactions are all shown, not the first few. */
    private allReactions = new Set<string>()
    /** Where the reader dragged the card to, and left it. */
    placed: { x: number; y: number } | null = null
    private key = ''
    info!: CommentThreadInfo

    constructor(private readonly margin: Margin, readonly id: string) {
        this.dom = el('article', 'ezco-mde-comment-card')
        this.dom.dataset.thread = id
        this.dom.tabIndex = 0
        this.context = el('div', 'ezco-mde-comment-context')
        this.messages = el('div', 'ezco-mde-comment-messages')
        this.dom.append(this.context, this.messages)
        // Looking at the card is looking at its thread.
        this.dom.addEventListener('mousedown', (e) => {
            if ((e.target as HTMLElement).closest('a, button, [data-wikilink], .ezco-mde-comment-composer')) return
            this.lookAt()
        })
        this.dom.addEventListener('focusin', () => this.lookAt())
        this.dom.addEventListener('click', (e) => {
            const link = (e.target as HTMLElement).closest('[data-wikilink]') as HTMLElement | null
            if (!link) return
            e.preventDefault()
            void (this.margin.editor.storage as any).wikilink?.follow(link.dataset.target ?? '', link.dataset.fragment ?? null)
        })
        this.dom.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            if (this.editing || this.confirming || this.replying) {
                this.stopEditing()
                this.stopReplying()
                this.confirming = null
                this.render()
                return
            }
            this.margin.editor.commands.focusComment(null)
            this.margin.editor.commands.focus()
        })
        // Floating, the card goes where it is dragged by its head, and stays.
        this.dom.addEventListener('pointerdown', (e) => this.drag(e))
    }

    private lookAt() {
        if (this.margin.active() !== this.id) this.margin.editor.commands.focusComment(this.id)
    }

    /** Drag by a message head (not its controls) while floating. */
    private drag(e: PointerEvent) {
        if (!this.margin.floating || e.button !== 0) return
        const target = e.target as HTMLElement
        if (!target.closest('.ezco-mde-comment-head') || target.closest('a, button, time')) return
        const start = { x: e.clientX, y: e.clientY }
        const from = this.placed ?? this.margin.positionOf(this)
        const move = (ev: PointerEvent) => {
            this.placed = { x: from.x + ev.clientX - start.x, y: Math.max(0, from.y + ev.clientY - start.y) }
            this.dom.style.transform = `translate(${Math.round(this.placed.x)}px, ${Math.round(this.placed.y)}px)`
        }
        const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            this.dom.classList.remove('is-dragging')
        }
        e.preventDefault()
        this.dom.classList.add('is-dragging')
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    update(info: CommentThreadInfo, active: boolean) {
        this.info = info
        const t = info.thread
        this.dom.classList.toggle('is-active', active)
        this.dom.classList.toggle('is-resolved', t.status === 'resolved')
        this.dom.classList.toggle('is-orphaned', info.orphaned)
        this.dom.classList.toggle('is-elsewhere', !!info.ref)
        this.dom.setAttribute('aria-label', `Comment by @${t.author}`)
        if (!active) {
            this.stopEditing()
            this.stopReplying()
            this.confirming = null
        }
        const key = JSON.stringify([
            info.ref?.source ?? null,
            info.pos === null,
            info.targets.map((x) => [x.orphaned, x.elsewhere]),
            info.pos === null ? JSON.stringify(t) : (this.margin.view.state.doc.nodeAt(info.pos)?.attrs.source ?? JSON.stringify(t)),
            active,
            this.margin.author(),
            this.margin.floating,
            this.editing?.key ?? null,
            this.replying?.key ?? null,
            this.confirming,
            [...this.folded],
            [...this.allReactions],
        ])
        if (key === this.key) return
        this.key = key
        this.render()
    }

    private render() {
        const { editor } = this.margin
        const info = this.info
        const t = info.thread
        const author = this.margin.author()

        const context: Node[] = []
        if (this.margin.floating) {
            context.push(button('×', () => (editor.commands.focusComment(null), editor.commands.focus()), 'ezco-mde-comment-tool is-close', 'Close'))
        }
        if (info.ref) {
            const where = el('div', 'ezco-mde-comment-where', 'In ')
            where.append(button(info.ref.source, () => void (editor.storage as any).wikilink?.follow(info.ref!.source.replace(/\.md$/i, ''), null), 'ezco-mde-comment-link'))
            context.push(where)
        }
        info.targets.forEach((target, i) => {
            if (!target.orphaned) return
            const orphan = el('div', 'ezco-mde-comment-orphan')
            orphan.append(el('span', 'ezco-mde-comment-quote', quoteOf(target.link.fragment)), el('span', undefined, ' is no longer in the note.'))
            if (author && info.pos !== null) {
                orphan.append(button('Anchor to selection', () => editor.commands.anchorComment(this.id, i), 'ezco-mde-comment-link', 'Point this at the selected text instead'))
            }
            context.push(orphan)
        })
        this.context.replaceChildren(...context)
        this.context.hidden = !context.length

        this.messages.replaceChildren(this.message(t, [], author))
        this.margin.schedule()
    }

    /** A message, its reactions and actions, the reply being written under
     *  it, and its replies (nested). */
    private message(m: Message, path: MessagePath, author: string | null): HTMLElement {
        const { editor } = this.margin
        const key = pathKey(path)
        const root = !path.length
        const deleted = m.body === DELETED_BODY
        const box = el('div', root ? 'ezco-mde-comment-message' : 'ezco-mde-comment-message is-reply')
        box.dataset.path = key
        box.classList.toggle('is-deleted', deleted)
        const head = el('div', 'ezco-mde-comment-head')
        const time = el('time', 'ezco-mde-comment-time', when(m.time))
        time.dateTime = m.time
        time.title = m.time
        head.append(el('span', 'ezco-mde-comment-author', `@${m.author}`), time)
        if (root && this.info.thread.status === 'resolved') head.append(el('span', 'ezco-mde-comment-status', 'Resolved'))
        box.append(head)

        // The body, or the composer editing it in its place.
        if (this.editing?.key === key) {
            box.append(this.editing.composer.dom)
        } else {
            const body = el('div', 'ezco-mde-comment-body')
            if (deleted) body.append(el('span', 'ezco-mde-comment-deleted', 'Deleted'))
            else body.append(renderMarkdown(editor, m.body))
            box.append(body)
        }

        // One row: reactions, then what can be done. A deletion is asked
        // about in the same row.
        const reactions = reactionsOf(m)
        const row = el('div', 'ezco-mde-comment-actions')
        if (this.confirming === key) {
            row.classList.add('is-confirming')
            row.append(
                el('span', 'ezco-mde-comment-question', 'Delete this comment?'),
                button('Delete', () => {
                    this.confirming = null
                    editor.commands.deleteComment(this.id, path)
                }, 'ezco-mde-comment-action is-danger', 'Delete this comment'),
                button('Keep', () => {
                    this.confirming = null
                    this.render()
                }, 'ezco-mde-comment-action', 'Keep it'),
            )
        } else {
            const all = this.allReactions.has(key)
            const shown = all || reactions.length <= REACTIONS_SHOWN ? reactions : reactions.slice(0, REACTIONS_SHOWN - 1)
            for (const [emoji, who] of shown) {
                const chip = button(`${emoji} ${who.length}`, () => author && editor.commands.reactToComment(this.id, emoji, path), 'ezco-mde-comment-reaction', who.map((a) => `@${a}`).join(', '))
                chip.setAttribute('aria-pressed', String(!!author && who.includes(author)))
                row.append(chip)
            }
            if (reactions.length > REACTIONS_SHOWN) {
                const rest = reactions.length - shown.length
                row.append(
                    button(all ? 'fewer' : `+${rest}`, () => {
                        if (all) this.allReactions.delete(key)
                        else this.allReactions.add(key)
                        this.render()
                    }, 'ezco-mde-comment-reaction is-more', all ? 'Show fewer reactions' : `Show all ${reactions.length} reactions`),
                )
            }
            if (author) {
                const react = button('', (b) => openReactionPicker(b, (emoji) => editor.commands.reactToComment(this.id, emoji, path)), 'ezco-mde-comment-action is-icon', 'React')
                react.innerHTML = REACT_ICON
                const draft = readDraft(this.draftKey(key))
                row.append(
                    react,
                    button(draft ? 'Reply · draft' : 'Reply', () => this.reply(path), 'ezco-mde-comment-action', root ? 'Reply' : `Reply to @${m.author}`),
                )
                if (root) {
                    row.append(
                        this.info.thread.status === 'open'
                            ? button('Resolve', () => editor.commands.resolveComment(this.id), 'ezco-mde-comment-action', 'Resolve')
                            : button('Reopen', () => editor.commands.reopenComment(this.id), 'ezco-mde-comment-action', 'Reopen'),
                    )
                }
                if (!deleted) {
                    row.append(
                        button('···', (b) => openMenu(b, [
                            { label: 'Edit', onSelect: () => this.edit(path, m) },
                            { label: 'Delete', onSelect: () => {
                                this.confirming = key
                                this.render()
                            } },
                        ]), 'ezco-mde-comment-action is-icon', 'More'),
                    )
                }
            }
        }
        if (row.childElementCount) box.append(row)

        // The reply being written, right under what it answers.
        if (this.replying?.key === key) box.append(this.replying.composer.dom)

        const replies: [Message, number][] = []
        m.replies.forEach((r, i) => {
            if (!(isReaction(r.body) && !r.replies.length)) replies.push([r, i])
        })
        if (replies.length) {
            const folded = this.folded.has(key)
            const toggle = button(`${folded ? '▸' : '▾'} ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`, () => {
                if (folded) this.folded.delete(key)
                else this.folded.add(key)
                this.render()
            }, 'ezco-mde-comment-fold', folded ? 'Show replies' : 'Hide replies')
            toggle.setAttribute('aria-expanded', String(!folded))
            box.append(toggle)
            if (!folded) {
                const list = el('div', 'ezco-mde-comment-replies')
                for (const [r, i] of replies) list.append(this.message(r, [...path, i], author))
                box.append(list)
            }
        }
        return box
    }

    private draftKey(key: string) {
        return draftKey(this.margin.notePath(), this.id, key)
    }

    /** Write a reply under the message at `path`, from its draft if one was kept. */
    private reply(path: MessagePath) {
        const { editor } = this.margin
        this.lookAt()
        const key = pathKey(path)
        if (this.replying?.key === key) {
            this.replying.composer.focus()
            return
        }
        this.stopReplying()
        this.stopEditing()
        const target = path.length ? messageAt(this.info.thread, path) : null
        const draft = this.draftKey(key)
        const composer = new Composer({
            editor,
            extensions: this.margin.composerExtensions(),
            placeholder: target ? `Reply to @${target.author}…` : 'Reply…',
            submitLabel: 'Reply',
            initial: readDraft(draft) ?? '',
            onChange: (markdown) => writeDraft(draft, markdown),
            onSubmit: (body) => {
                if (editor.commands.replyToComment(this.id, body, path)) {
                    clearDraft(draft)
                    this.stopReplying()
                    this.render()
                }
            },
            // Done with the thread for now: the draft is kept, the card closes.
            onCancel: () => {
                this.stopReplying()
                editor.commands.focusComment(null)
                editor.commands.focus()
            },
            onExpand: () =>
                this.margin.openAuthoring({
                    thread: this.info,
                    title: target ? `Replying to @${target.author}` : `Replying to @${this.info.thread.author}`,
                    draft,
                    initial: this.replying?.composer.value() ?? '',
                    submitLabel: 'Reply',
                    onSubmit: (body) => {
                        if (editor.commands.replyToComment(this.id, body, path)) {
                            clearDraft(draft)
                            this.stopReplying()
                            this.render()
                            return true
                        }
                        return false
                    },
                    onClose: (kept) => {
                        // Back in the card, with what was written there.
                        if (this.replying?.key === key) this.replying.composer.set(kept)
                    },
                }),
        })
        this.replying = { key, path, composer }
        this.render()
        composer.focus()
    }

    private stopReplying() {
        this.replying?.composer.destroy()
        this.replying = null
    }

    /** Edit a message where it is: its body gives way to a composer. */
    private edit(path: MessagePath, m: Message) {
        this.lookAt()
        this.stopEditing()
        this.stopReplying()
        const { editor } = this.margin
        const composer = new Composer({
            editor,
            extensions: this.margin.composerExtensions(),
            placeholder: 'Comment…',
            submitLabel: 'Save',
            initial: m.body,
            onSubmit: (body) => {
                if (editor.commands.editComment(this.id, body, path)) {
                    this.stopEditing()
                    this.render()
                }
            },
            onCancel: () => {
                this.stopEditing()
                this.render()
                this.dom.focus()
            },
            onExpand: () =>
                this.margin.openAuthoring({
                    thread: this.info,
                    title: 'Editing',
                    draft: null,
                    initial: this.editing?.composer.value() ?? m.body,
                    submitLabel: 'Save',
                    onSubmit: (body) => {
                        if (editor.commands.editComment(this.id, body, path)) {
                            this.stopEditing()
                            this.render()
                            return true
                        }
                        return false
                    },
                    onClose: (kept) => {
                        if (this.editing?.key === pathKey(path)) this.editing.composer.set(kept)
                    },
                }),
        })
        this.editing = { key: pathKey(path), composer }
        this.render()
        composer.focus()
    }

    private stopEditing() {
        this.editing?.composer.destroy()
        this.editing = null
    }

    destroy() {
        this.stopEditing()
        this.stopReplying()
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
        const key = draftKey(margin.notePath(), 'new', '')
        this.composer = new Composer({
            editor,
            extensions: margin.composerExtensions(),
            placeholder: 'Comment…',
            submitLabel: 'Comment',
            initial: readDraft(key) ?? '',
            onChange: (markdown) => writeDraft(key, markdown),
            onSubmit: (body) => {
                const draft = (editor.storage as any).comments.draft() as { ranges: { from: number; to: number }[] } | null
                if (editor.commands.addComment({ body, ranges: draft?.ranges ?? [] })) clearDraft(key)
            },
            onCancel: () => {
                editor.commands.cancelComment()
                editor.commands.focus()
            },
        })
        this.dom.append(head, this.composer.dom)
        this.composer.focus()
    }

    destroy() {
        this.composer.destroy()
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
    private authoring: Authoring | null = null
    private showResolved = false
    /** Threads float over the note's edge (the default layout, or a column
     *  that would not fit). */
    floating: boolean
    private frame = 0
    private headKey = ''
    private readonly observer: ResizeObserver | null
    private extensions: AnyExtension[] | null = null

    constructor(
        readonly editor: Editor,
        readonly view: EditorView,
        private readonly options: CommentMarginOptions,
    ) {
        this.floating = options.layout !== 'column'
        this.dom = el('section', 'ezco-mde-comment-margin')
        this.dom.setAttribute('aria-label', 'Comments')
        this.head = el('header', 'ezco-mde-comment-margin-head')
        this.list = el('div', 'ezco-mde-comment-list')
        this.dom.append(this.head, this.list)
        const root = (view.dom.closest('.ezco-mde') as HTMLElement | null) ?? view.dom
        const mount = options.mount
        const host = mount instanceof HTMLElement ? mount : typeof mount === 'function' ? mount(root) ?? null : null
        if (host && !this.floating) host.appendChild(this.dom)
        else view.dom.after(this.dom)
        // Cards change size (a reply typed, replies folded): they are laid out
        // again when they do, as when the note is.
        this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule())
        this.observer?.observe(view.dom)
        if (view.dom.parentElement) this.observer?.observe(view.dom.parentElement)
        this.update()
    }

    private get comments(): CommentsStorage {
        return (this.editor.storage as any).comments as CommentsStorage
    }

    author(): string | null {
        return this.comments.author()
    }

    active(): string | null {
        return commentsKey.getState(this.view.state)?.active ?? null
    }

    /** The open note's path (drafts are kept per note). */
    notePath(): string | null {
        return ((this.editor.storage as any).persistence as FileSystemStorage | undefined)?.options?.filepath ?? null
    }

    /** What a comment is written with; the host's list, made once. */
    composerExtensions(): AnyExtension[] | undefined {
        if (!this.options.composer) return undefined
        return (this.extensions ??= this.options.composer())
    }

    /** Where a card is now, as an offset from where it would be laid out. */
    positionOf(card: Card): { x: number; y: number } {
        const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(card.dom.style.transform) ?? /translateY\((-?[\d.]+)px\)/.exec(card.dom.style.transform)
        if (!m) return { x: 0, y: 0 }
        return m.length === 3 ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: Number(m[1]) }
    }

    /** The full-size view for writing, over the note. */
    openAuthoring(spec: {
        thread: CommentThreadInfo
        title: string
        draft: string | null
        initial: string
        submitLabel: string
        onSubmit: (markdown: string) => boolean
        onClose: (kept: string) => void
    }) {
        this.authoring?.destroy()
        const target = spec.thread.targets.find((t) => t.range)?.range ?? null
        const quote = target ? this.view.state.doc.textBetween(target.from, target.to, ' ') : null
        // The cards step back while the view is up.
        this.dom.classList.add('is-behind')
        const done = () => {
            this.authoring?.destroy()
            this.authoring = null
            this.dom.classList.remove('is-behind')
        }
        const close = () => {
            const kept = this.authoring?.value() ?? ''
            done()
            spec.onClose(kept)
        }
        this.authoring = new Authoring({
            editor: this.editor,
            extensions: this.composerExtensions(),
            quote,
            thread: spec.thread.thread,
            title: spec.title,
            initial: spec.initial,
            submitLabel: spec.submitLabel,
            onChange: (markdown) => spec.draft && writeDraft(spec.draft, markdown),
            onSubmit: (markdown) => {
                if (spec.onSubmit(markdown)) done()
            },
            onClose: close,
        })
    }

    update() {
        const state = commentsKey.getState(this.view.state)
        if (!state) return
        const resolved = state.threads.filter((t) => t.thread.status === 'resolved').length
        const visible = this.floating
            ? state.threads.filter((t) => t.id === state.active)
            : state.threads.filter((t) => t.thread.status === 'open' || this.showResolved || t.id === state.active)
        this.dom.hidden = this.floating ? !state.active && !state.draft : !state.threads.length && !state.draft
        this.dom.classList.toggle('is-floating', this.floating)

        // The column's head: how many, and the resolved ones on request.
        const open = state.threads.length - resolved
        const headKey = `${this.floating}/${open}/${resolved}/${this.showResolved}`
        if (headKey !== this.headKey) {
            this.headKey = headKey
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
        }

        const seen = new Set<string>()
        for (const info of visible) {
            let card = this.cards.get(info.id)
            if (!card) {
                card = new Card(this, info.id)
                this.cards.set(info.id, card)
                this.list.append(card.dom)
                this.observer?.observe(card.dom)
            }
            card.update(info, state.active === info.id)
            seen.add(info.id)
        }
        for (const [id, card] of this.cards) {
            if (seen.has(id)) continue
            this.observer?.unobserve(card.dom)
            card.destroy()
            this.cards.delete(id)
        }
        const author = this.author()
        if (state.draft && author) {
            if (!this.draft) {
                this.draft = new Draft(this, author)
                this.list.append(this.draft.dom)
                this.observer?.observe(this.draft.dom)
            }
        } else if (this.draft) {
            this.observer?.unobserve(this.draft.dom)
            this.draft.destroy()
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

    /** Where each card goes: level with its text, none overlapping, the one
     *  being written or looked at exactly at its text; a card the reader
     *  dragged stays where it was left. */
    layout() {
        if (this.dom.hidden || !this.view.dom.isConnected) return
        // A column that would squeeze the note below NOTE_MIN floats instead.
        const host = this.view.dom.parentElement
        if (this.options.layout === 'column' && host) {
            const width = this.dom.offsetWidth || 256
            const room = host.clientWidth - (this.floating ? width : 0)
            const floating = room < NOTE_MIN
            if (floating !== this.floating) {
                this.floating = floating
                if (floating) this.view.dom.after(this.dom)
                else {
                    const root = (this.view.dom.closest('.ezco-mde') as HTMLElement | null) ?? this.view.dom
                    const mount = this.options.mount
                    const column = mount instanceof HTMLElement ? mount : typeof mount === 'function' ? mount(root) ?? null : null
                    if (column) column.appendChild(this.dom)
                }
                this.update()
                return
            }
        }
        const state = commentsKey.getState(this.view.state)
        if (!state) return
        const origin = this.list.getBoundingClientRect().top
        // Beside the note, a card is level with its text; over it (floating),
        // just below its text, so the text stays in view.
        const at = (range: { from: number; to: number } | null) => {
            if (!range) return 0
            try {
                const size = this.view.state.doc.content.size
                return this.floating
                    ? this.view.coordsAtPos(Math.min(range.to, size), -1).bottom - origin + GAP
                    : this.view.coordsAtPos(Math.min(range.from, size)).top - origin
            } catch {
                return 0
            }
        }
        const placed: { dom: HTMLElement; want: number; height: number; top: number; fixed: boolean; range: { from: number; to: number } | null }[] = []
        // The draft, when there is one, is what is being written: it stays at
        // its text and the active card gives way.
        for (const info of state.threads) {
            const card = this.cards.get(info.id)
            if (!card || card.dom.hidden) continue
            if (card.placed) {
                card.dom.style.transform = `translate(${Math.round(card.placed.x)}px, ${Math.round(card.placed.y)}px)`
                card.dom.classList.add('is-placed')
                continue
            }
            const anchored = info.targets.find((t) => t.range)?.range ?? null
            placed.push({ dom: card.dom, want: at(anchored), height: card.dom.offsetHeight, top: 0, fixed: info.id === state.active && !state.draft, range: anchored })
        }
        if (this.draft && state.draft) {
            const range = state.draft.ranges[0] ?? null
            placed.push({ dom: this.draft.dom, want: at(range), height: this.draft.dom.offsetHeight, top: 0, fixed: true, range })
        }
        placed.sort((a, b) => a.want - b.want || Number(b.fixed) - Number(a.fixed))
        const pin = placed.findIndex((p) => p.fixed)
        if (pin < 0) {
            let y = 0
            for (const p of placed) y = (p.top = Math.max(p.want, y)) + p.height + GAP
        } else {
            // The pinned card at its text; those above it moved up out of its
            // way, those below down.
            placed[pin].top = Math.max(0, placed[pin].want)
            let limit = placed[pin].top - GAP
            for (let i = pin - 1; i >= 0; i--) limit = (placed[i].top = Math.min(placed[i].want, limit - placed[i].height)) - GAP
            // Nothing above the margin's top: push everything down if needed.
            const overflow = Math.min(0, ...placed.slice(0, pin + 1).map((p) => p.top))
            if (overflow < 0) for (let i = 0; i <= pin; i++) placed[i].top -= overflow
            let y = placed[pin].top + placed[pin].height + GAP
            for (let i = pin + 1; i < placed.length; i++) y = (placed[i].top = Math.max(placed[i].want, y)) + placed[i].height + GAP
        }
        // Floating over the note, a card never extends the scroll (so opening
        // or closing one never moves the page): under its text when there is
        // room before the scroll area's end, else above its text, else as
        // low as fits.
        if (this.floating) {
            const scroller = scrollerOf(this.list)
            const listTop = scroller
                ? origin - scroller.getBoundingClientRect().top + scroller.scrollTop
                : origin + window.scrollY
            const limit = (scroller ? scroller.scrollHeight : document.documentElement.scrollHeight) - listTop
            for (const p of placed) {
                if (p.top + p.height <= limit) continue
                let above = -1
                try {
                    if (p.range) above = this.view.coordsAtPos(Math.min(p.range.from, this.view.state.doc.content.size)).top - origin - GAP - p.height
                } catch {
                    above = -1
                }
                p.top = above >= 0 ? above : Math.max(0, limit - p.height)
            }
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
        this.list.style.minHeight = this.floating ? '' : `${Math.ceil(bottom)}px`
    }

    destroy() {
        if (this.frame) cancelAnimationFrame(this.frame)
        this.observer?.disconnect()
        this.authoring?.destroy()
        for (const card of this.cards.values()) card.destroy()
        this.cards.clear()
        this.draft?.destroy()
        this.dom.remove()
    }
}

export const CommentMargin = Extension.create<CommentMarginOptions>({
    name: 'commentMargin',

    addOptions() {
        return { mount: undefined, layout: 'float', composer: undefined }
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
