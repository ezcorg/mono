/**
 * Where a note's comments are read and answered (comments RFC).
 *
 * By default nothing shows beside the note: commented text is marked, and
 * clicking it (or `focusComment`) opens that one comment as a card over the
 * note's edge, by its text; Escape, or a click elsewhere, closes it
 * (`layout: 'float'`). A floating card's edges can be dragged to size it. A
 * host that wants every open comment in view asks for a column
 * (`layout: 'column'`): each a card level with its text, cards pushed apart
 * so none overlap, the one being looked at at its text and the others moved
 * out of its way, resolved ones folded away until asked for. Where a column
 * would leave the note too narrow it floats after all.
 *
 * A card is a comment and, nested under it, the comments that answer it
 * (each a document referencing the text above it). Every one shows who and
 * when (the document's name says), its text rendered as the note renders
 * text, and one row: its reactions (the four most given; the rest behind
 * "+n"), React, Reply, Resolve or Reopen, and a menu with Edit (in place),
 * Delete and Open (the comment's document, in the editor). A reply is
 * written right under what it answers, in the editor itself in small
 * (`Composer`), and kept as a draft in this browser until posted; "Open in
 * editor" makes the reply's document with the draft and loads it, which is
 * where a longer one is written. Resolving closes the card.
 */
import { Extension, type AnyExtension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { parseTextFragment, type Reaction } from '@joinezco/storage'
import { DELETED_BODY, RESOLVED, commentsKey, type CommentInfo, type CommentsStorage } from './comments'
import { Composer } from './comment-composer'
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
    /** `float` (default): the comment looked at, over the note's edge.
     *  `column`: every open comment beside the note. */
    layout?: 'float' | 'column'
    /** The extensions a comment is written with (the note's setup without
     *  its chrome, from `createEditor`); `minimalSetup` without. */
    composer?: () => AnyExtension[]
}

/** The note is not squeezed narrower than this to make room for a column. */
const NOTE_MIN = 400
const GAP = 8
/** Reactions shown on a comment before the rest fold behind "+n". */
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

/** What an orphaned comment pointed at, to show in its place. */
function quoteOf(fragment: string | null): string {
    if (!fragment) return 'the note'
    if (fragment.startsWith(':~:text=')) {
        const f = parseTextFragment(fragment)
        return f ? `“${f.end === null ? f.start : `${f.start} … ${f.end}`}”` : fragment
    }
    return fragment.startsWith('^') ? `block ^${fragment.slice(1)}` : `“${fragment}”`
}

/** A comment's reactions by emoji, most given first, resolution left out. */
function reactionsOf(c: CommentInfo): [string, Reaction[]][] {
    const by = new Map<string, Reaction[]>()
    for (const r of c.reactions) {
        if (r.emoji === RESOLVED) continue
        by.set(r.emoji, [...(by.get(r.emoji) ?? []), r])
    }
    // The most given first; among equals, the earliest.
    return [...by].sort((a, b) => b[1].length - a[1].length || a[1][0].at.localeCompare(b[1][0].at))
}

/** Who and when, as a card says it. */
function byline(c: CommentInfo): [string, string] {
    return c.time ? [`@${c.author}`, when(c.time)] : [c.author, '']
}

/**
 * Drag any edge of `dom` to size it (floating cards). The left and top
 * edges move the card as they size it, through `offset`, which the layout
 * adds to where it puts the card.
 */
function resizable(dom: HTMLElement, offset: { x: number; y: number }, onResize: () => void): void {
    for (const edge of ['n', 'e', 's', 'w'] as const) {
        const handle = el('div', `ezco-mde-comment-edge is-${edge}`)
        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return
            e.preventDefault()
            e.stopPropagation()
            const start = { x: e.clientX, y: e.clientY, w: dom.offsetWidth, h: dom.offsetHeight, ox: offset.x, oy: offset.y }
            const move = (ev: PointerEvent) => {
                const dx = ev.clientX - start.x
                const dy = ev.clientY - start.y
                if (edge === 'e') dom.style.width = `${Math.max(280, start.w + dx)}px`
                if (edge === 's') dom.style.height = `${Math.max(72, start.h + dy)}px`
                if (edge === 'w') {
                    const w = Math.max(280, start.w - dx)
                    dom.style.width = `${w}px`
                    offset.x = start.ox + (start.w - w)
                }
                if (edge === 'n') {
                    const h = Math.max(72, start.h - dy)
                    dom.style.height = `${h}px`
                    offset.y = start.oy + (start.h - h)
                }
                onResize()
            }
            const up = () => {
                window.removeEventListener('pointermove', move)
                window.removeEventListener('pointerup', up)
                dom.classList.remove('is-resizing')
            }
            dom.classList.add('is-resizing')
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
        })
        dom.append(handle)
    }
}

// ── A card ──────────────────────────────────────────────────────────────────

class Card {
    readonly dom: HTMLElement
    private readonly context: HTMLElement
    private readonly messages: HTMLElement
    /** The comment a reply is being written under, and its composer. */
    private replying: { id: string; composer: Composer } | null = null
    /** A comment being edited: its composer stands where its text was. */
    private editing: { id: string; composer: Composer } | null = null
    /** The comment whose deletion is being asked about. */
    private confirming: string | null = null
    /** Replies folded away, by the comment they are under. */
    private folded = new Set<string>()
    /** Comments whose reactions are all shown, not the first few. */
    private allReactions = new Set<string>()
    /** How far the reader's sizing moved the card. */
    readonly offset = { x: 0, y: 0 }
    private key = ''
    info!: CommentInfo

    constructor(private readonly margin: Margin, readonly id: string) {
        this.dom = el('article', 'ezco-mde-comment-card')
        this.dom.dataset.comment = id
        this.dom.tabIndex = 0
        this.context = el('div', 'ezco-mde-comment-context')
        this.messages = el('div', 'ezco-mde-comment-messages')
        this.dom.append(this.context, this.messages)
        resizable(this.dom, this.offset, () => this.margin.schedule())
        // Looking at the card is looking at its comment.
        this.dom.addEventListener('mousedown', (e) => {
            if ((e.target as HTMLElement).closest('a, button, [data-wikilink], .ezco-mde-comment-composer, .ezco-mde-comment-edge')) return
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
            this.margin.close()
        })
    }

    private lookAt() {
        if (this.margin.active() !== this.id) this.margin.editor.commands.focusComment(this.id)
    }

    update(info: CommentInfo, active: boolean) {
        this.info = info
        this.dom.classList.toggle('is-active', active)
        this.dom.classList.toggle('is-resolved', info.resolved)
        this.dom.classList.toggle('is-orphaned', info.target.orphaned)
        const [who] = byline(info)
        this.dom.setAttribute('aria-label', `Comment by ${who}`)
        if (!active) {
            this.stopEditing()
            this.stopReplying()
            this.confirming = null
        }
        const key = JSON.stringify([
            summary(info),
            active,
            this.margin.author(),
            this.margin.floating,
            this.editing?.id ?? null,
            this.replying?.id ?? null,
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
        const author = this.margin.author()

        const context: Node[] = []
        if (this.margin.floating) context.push(button('×', () => this.margin.close(), 'ezco-mde-comment-tool is-close', 'Close'))
        if (info.target.orphaned) {
            const orphan = el('div', 'ezco-mde-comment-orphan')
            orphan.append(el('span', 'ezco-mde-comment-quote', quoteOf(info.target.link.fragment)), el('span', undefined, ' is no longer in the note.'))
            if (author) orphan.append(button('Anchor to selection', () => editor.commands.anchorComment(this.id), 'ezco-mde-comment-link', 'Point this at the selected text instead'))
            context.push(orphan)
        }
        this.context.replaceChildren(...context)
        this.context.hidden = !context.length

        this.messages.replaceChildren(this.message(info, 0, author))
        this.margin.schedule()
    }

    /** A comment, its reactions and actions, the reply being written under
     *  it, and the comments that answer it (nested). */
    private message(c: CommentInfo, depth: number, author: string | null): HTMLElement {
        const { editor } = this.margin
        const deleted = c.body === DELETED_BODY
        const box = el('div', depth ? 'ezco-mde-comment-message is-reply' : 'ezco-mde-comment-message')
        box.dataset.comment = c.id
        box.classList.toggle('is-deleted', deleted)
        const head = el('div', 'ezco-mde-comment-head')
        const [who, at] = byline(c)
        head.append(el('span', 'ezco-mde-comment-author', who))
        if (at) {
            const time = el('time', 'ezco-mde-comment-time', at)
            time.dateTime = c.time
            head.append(time)
        }
        if (c.resolved) head.append(el('span', 'ezco-mde-comment-status', 'Resolved'))
        box.append(head)

        // The text, rendered as the note renders text, or the composer
        // editing it in its place.
        if (this.editing?.id === c.id) {
            box.append(this.editing.composer.dom)
        } else {
            const body = el('div', 'ezco-mde-body ezco-mde-comment-body')
            if (deleted) body.append(el('span', 'ezco-mde-comment-deleted', 'Deleted'))
            else body.append(renderMarkdown(editor, c.body))
            box.append(body)
        }

        // One row: reactions, then what can be done. A deletion is asked
        // about in the same row.
        const reactions = reactionsOf(c)
        const row = el('div', 'ezco-mde-comment-actions')
        if (this.confirming === c.id) {
            row.classList.add('is-confirming')
            row.append(
                el('span', 'ezco-mde-comment-question', 'Delete this comment?'),
                button('Delete', () => {
                    this.confirming = null
                    editor.commands.deleteComment(c.id)
                }, 'ezco-mde-comment-action is-danger', 'Delete this comment'),
                button('Keep', () => {
                    this.confirming = null
                    this.render()
                }, 'ezco-mde-comment-action', 'Keep it'),
            )
        } else {
            const all = this.allReactions.has(c.id)
            const shown = all || reactions.length <= REACTIONS_SHOWN ? reactions : reactions.slice(0, REACTIONS_SHOWN - 1)
            const me = this.margin.identity()
            for (const [emoji, who] of shown) {
                const chip = button(`${emoji} ${who.length}`, () => editor.commands.reactToComment(c.id, emoji), 'ezco-mde-comment-reaction', who.map((r) => `@${r.by}`).join(', '))
                chip.setAttribute('aria-pressed', String(!!me && who.some((r) => r.by === me)))
                chip.disabled = !me
                row.append(chip)
            }
            if (reactions.length > REACTIONS_SHOWN) {
                row.append(
                    button(all ? 'fewer' : `+${reactions.length - shown.length}`, () => {
                        if (all) this.allReactions.delete(c.id)
                        else this.allReactions.add(c.id)
                        this.render()
                    }, 'ezco-mde-comment-reaction is-more', all ? 'Show fewer reactions' : `Show all ${reactions.length} reactions`),
                )
            }
            if (me) {
                const react = button('', (b) => openReactionPicker(b, (emoji) => editor.commands.reactToComment(c.id, emoji)), 'ezco-mde-comment-action is-icon', 'React')
                react.innerHTML = REACT_ICON
                row.append(react)
            }
            if (author) {
                const draft = readDraft(this.draftKey(c.id))
                row.append(button(draft ? 'Reply · draft' : 'Reply', () => this.reply(c), 'ezco-mde-comment-action', depth ? `Reply to ${who}` : 'Reply'))
            }
            if (me && !depth) {
                row.append(
                    c.resolved
                        ? button('Reopen', () => editor.commands.reopenComment(c.id), 'ezco-mde-comment-action', 'Reopen')
                        : button('Resolve', () => {
                            editor.commands.resolveComment(c.id)
                            this.margin.close()
                        }, 'ezco-mde-comment-action', 'Resolve'),
                )
            }
            const items: ContextMenuItem[] = [{ label: 'Open document', onSelect: () => editor.commands.openComment(c.id) }]
            if (author && !deleted) {
                items.unshift({ label: 'Edit', onSelect: () => this.edit(c) })
                items.push({ label: 'Delete', onSelect: () => {
                    this.confirming = c.id
                    this.render()
                } })
            }
            row.append(button('···', (b) => openMenu(b, items), 'ezco-mde-comment-action is-icon', 'More'))
        }
        box.append(row)

        // The reply being written, right under what it answers.
        if (this.replying?.id === c.id) box.append(this.replying.composer.dom)

        if (c.replies.length) {
            const folded = this.folded.has(c.id)
            const toggle = button(`${folded ? '▸' : '▾'} ${c.replies.length} ${c.replies.length === 1 ? 'reply' : 'replies'}`, () => {
                if (folded) this.folded.delete(c.id)
                else this.folded.add(c.id)
                this.render()
            }, 'ezco-mde-comment-fold', folded ? 'Show replies' : 'Hide replies')
            toggle.setAttribute('aria-expanded', String(!folded))
            box.append(toggle)
            if (!folded) {
                const list = el('div', 'ezco-mde-comment-replies')
                for (const r of c.replies) list.append(this.message(r, depth + 1, author))
                box.append(list)
            }
        }
        return box
    }

    private draftKey(id: string) {
        return draftKey(this.margin.notePath(), id, 'reply')
    }

    /** Write a reply under comment `c`, from its draft if one was kept. */
    private reply(c: CommentInfo) {
        const { editor } = this.margin
        this.lookAt()
        if (this.replying?.id === c.id) {
            this.replying.composer.focus()
            return
        }
        this.stopReplying()
        this.stopEditing()
        const [who] = byline(c)
        const draft = this.draftKey(c.id)
        const composer = new Composer({
            editor,
            extensions: this.margin.composerExtensions(),
            placeholder: `Reply to ${who}…`,
            submitLabel: 'Reply',
            initial: readDraft(draft) ?? '',
            onChange: (markdown) => writeDraft(draft, markdown),
            onSubmit: (body) => {
                if (editor.commands.replyToComment(c.id, body)) {
                    clearDraft(draft)
                    this.stopReplying()
                    this.render()
                }
            },
            // Done for now: the draft is kept, the card closes.
            onCancel: () => {
                this.stopReplying()
                this.margin.close()
            },
            // The reply's document, made with what was written, opened in the
            // editor: where a longer one is written.
            onExpand: () => {
                const body = this.replying?.composer.value() ?? ''
                if (editor.commands.replyToComment(c.id, body, { open: true })) {
                    clearDraft(draft)
                    this.stopReplying()
                }
            },
        })
        this.replying = { id: c.id, composer }
        this.render()
        composer.focus()
    }

    private stopReplying() {
        this.replying?.composer.destroy()
        this.replying = null
    }

    /** Edit a comment where it is: its text gives way to a composer. */
    private edit(c: CommentInfo) {
        this.lookAt()
        this.stopEditing()
        this.stopReplying()
        const { editor } = this.margin
        const composer = new Composer({
            editor,
            extensions: this.margin.composerExtensions(),
            placeholder: 'Comment…',
            submitLabel: 'Save',
            initial: c.body,
            onSubmit: (body) => {
                if (editor.commands.editComment(c.id, body)) {
                    this.stopEditing()
                    this.render()
                }
            },
            onCancel: () => {
                this.stopEditing()
                this.render()
                this.dom.focus()
            },
            // The comment's own document, in the editor.
            onExpand: () => {
                this.stopEditing()
                editor.commands.openComment(c.id)
            },
        })
        this.editing = { id: c.id, composer }
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

/** What a card shows of a comment, for telling whether to draw it again. */
function summary(c: CommentInfo): unknown {
    return [c.ref.source, c.ref.line, c.ref.text, c.body, c.resolved, c.target.orphaned, c.reactions.map((r) => [r.by, r.emoji]), c.replies.map(summary)]
}

class Draft {
    readonly dom: HTMLElement
    private readonly composer: Composer
    readonly offset = { x: 0, y: 0 }

    constructor(margin: Margin, author: string) {
        const { editor } = margin
        this.dom = el('article', 'ezco-mde-comment-card is-draft is-active')
        this.dom.setAttribute('aria-label', 'New comment')
        const head = el('div', 'ezco-mde-comment-head')
        head.append(el('span', 'ezco-mde-comment-author', `@${author}`), el('span', 'ezco-mde-comment-time', 'New comment'))
        const key = draftKey(margin.notePath(), 'new', '')
        const ranges = () => ((editor.storage as any).comments.draft() as { ranges: { from: number; to: number }[] } | null)?.ranges ?? []
        this.composer = new Composer({
            editor,
            extensions: margin.composerExtensions(),
            placeholder: 'Comment…',
            submitLabel: 'Comment',
            initial: readDraft(key) ?? '',
            onChange: (markdown) => writeDraft(key, markdown),
            onSubmit: (body) => {
                if (editor.commands.addComment({ body, ranges: ranges() })) clearDraft(key)
            },
            onCancel: () => {
                editor.commands.cancelComment()
                editor.commands.focus()
            },
            onExpand: () => {
                if (editor.commands.addComment({ body: this.composer.value(), ranges: ranges(), open: true })) clearDraft(key)
            },
        })
        this.dom.append(head, this.composer.dom)
        resizable(this.dom, this.offset, () => margin.schedule())
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
    private showResolved = false
    /** Comments float over the note's edge (the default layout, or a column
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

    /** Who reacts (null: reactions cannot be made). */
    identity(): string | null {
        return this.comments.canReact() ? this.author() : null
    }

    active(): string | null {
        return commentsKey.getState(this.view.state)?.active ?? null
    }

    /** Done looking: no card, the caret back in the note. */
    close() {
        this.editor.commands.focusComment(null)
        this.editor.commands.focus()
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

    update() {
        const state = commentsKey.getState(this.view.state)
        if (!state) return
        const resolved = state.comments.filter((c) => c.resolved).length
        const visible = this.floating
            ? state.comments.filter((c) => c.id === state.active)
            : state.comments.filter((c) => !c.resolved || this.showResolved || c.id === state.active)
        this.dom.hidden = this.floating ? !state.active && !state.draft : !state.comments.length && !state.draft
        this.dom.classList.toggle('is-floating', this.floating)

        // The column's head: how many, and the resolved ones on request.
        const open = state.comments.length - resolved
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
     *  being written or looked at exactly at its text. */
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
        type Placed = { dom: HTMLElement; want: number; height: number; top: number; fixed: boolean; range: { from: number; to: number } | null; offset: { x: number; y: number } }
        const placed: Placed[] = []
        for (const info of state.comments) {
            const card = this.cards.get(info.id)
            if (!card || card.dom.hidden) continue
            placed.push({ dom: card.dom, want: at(info.target.range), height: card.dom.offsetHeight, top: 0, fixed: info.id === state.active && !state.draft, range: info.target.range, offset: card.offset })
        }
        if (this.draft && state.draft) {
            const range = state.draft.ranges[0] ?? null
            placed.push({ dom: this.draft.dom, want: at(range), height: this.draft.dom.offsetHeight, top: 0, fixed: true, range, offset: this.draft.offset })
        }
        placed.sort((a, b) => a.want - b.want || Number(b.fixed) - Number(a.fixed))
        const pin = placed.findIndex((p) => p.fixed)
        if (pin < 0) {
            let y = 0
            for (const p of placed) y = (p.top = Math.max(p.want, y)) + p.height + GAP
        } else {
            placed[pin].top = Math.max(0, placed[pin].want)
            let limit = placed[pin].top - GAP
            for (let i = pin - 1; i >= 0; i--) limit = (placed[i].top = Math.min(placed[i].want, limit - placed[i].height)) - GAP
            const overflow = Math.min(0, ...placed.slice(0, pin + 1).map((p) => p.top))
            if (overflow < 0) for (let i = 0; i <= pin; i++) placed[i].top -= overflow
            let y = placed[pin].top + placed[pin].height + GAP
            for (let i = pin + 1; i < placed.length; i++) y = (placed[i].top = Math.max(placed[i].want, y)) + placed[i].height + GAP
        }
        // Floating over the note, a card never extends the scroll: under its
        // text when there is room before the scroll area's end, else above
        // its text, else as low as fits.
        if (this.floating) {
            const scroller = scrollerOf(this.list)
            const listTop = scroller ? origin - scroller.getBoundingClientRect().top + scroller.scrollTop : origin + window.scrollY
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
            p.dom.style.transform = `translate(${Math.round(p.offset.x)}px, ${Math.round(p.top + p.offset.y)}px)`
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
