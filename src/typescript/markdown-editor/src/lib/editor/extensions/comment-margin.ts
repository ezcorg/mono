/**
 * Where a note's comments are read and answered (comments RFC).
 *
 * By default nothing shows beside the note: commented text is marked, and
 * clicking it (or `focusComment`) opens that one comment as a card over the
 * note's edge, by its text; Escape, or a click elsewhere, closes it
 * (`layout: 'float'`). A host that wants every open comment in view asks
 * for a column (`layout: 'column'`): each a card level with its text, cards
 * pushed apart so none overlap, the one being looked at at its text and the
 * others moved out of its way, resolved ones folded away until asked for.
 * Where a column would leave the note too narrow it floats after all.
 *
 * A card shows a comment as a message: who and when over it, its text in a
 * bubble (the reader's own on the right, in the accent; others' on the
 * left), and under the bubble one quiet row: its reactions, React, how
 * many replies it has, and "…" for the rest (Reply, Resolve, Edit, Delete,
 * Open document). The replies stay out of the way until the count is
 * clicked; then the thread unfolds under the message, each reply a
 * message of its own, a reply with answers of its own folding them with
 * [−]/[+], and a field at the end for the next reply. A reply is written
 * in the editor itself, in small (`Composer`), and kept as a draft in this
 * browser until posted; the open glyph in the field's corner makes the
 * reply's document with the draft and loads it, which is where a longer
 * one is written. Resolving closes the card.
 *
 * A new comment is written in a small composer by the end of the text it
 * is about. It is posted at once, or kept as a draft: drafts are comments
 * only this browser has, marked as such in the note and on their cards,
 * and a bar over the note says how many there are and publishes or
 * discards them all at once.
 */
import { Extension, type AnyExtension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import tippy, { type Instance as TippyInstance } from 'tippy.js'
import { parseTextFragment, type Reaction } from '@joinezco/vault'
import { DELETED_BODY, RESOLVED, commentsKey, type CommentInfo, type CommentsStorage } from './comments'
import { Composer } from './comment-composer'
import { clearDraft, draftKey, readDraft, renderMarkdown, when, writeDraft } from './comment-render'
import { openReactionPicker } from './emoji-picker'
import { ContextMenu, type ContextMenuItem } from '../ui/context-menu'
import { scrollerOf } from './rail'
import type { FileSystemStorage } from './filesystem'

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

/** A control drawn as a glyph. */
const glyph = (icon: string, title: string, onClick: (b: HTMLButtonElement) => void, className = 'ezco-mde-comment-action is-icon') => {
    const b = button('', onClick, className, title)
    b.innerHTML = icon
    return b
}

/** The React control's glyph: a face, as reactions are drawn. */
const REACT_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm0 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM5.5 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM5.3 9.6a.75.75 0 0 1 1.05.15c.4.53 1 .85 1.65.85s1.25-.32 1.65-.85a.75.75 0 1 1 1.2.9A3.55 3.55 0 0 1 8 12.1a3.55 3.55 0 0 1-2.85-1.45.75.75 0 0 1 .15-1.05Z"/></svg>'
/** The replies control's glyph: a speech bubble, the count beside it. */
const REPLIES_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M2.5 3.5h11v7H7.5l-3 2.5v-2.5h-2z"/></svg>'
/** "…": the rest of what can be done, in a menu. */
const MORE_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="12.5" cy="8" r="1.4" fill="currentColor"/></svg>'
/** The way out of a floating card: a cross. */
const CLOSE_ICON =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 4l8 8M12 4l-8 8"/></svg>'

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

/** How many answers `c` has, at every depth. */
function count(c: CommentInfo): number {
    return c.replies.reduce((n, r) => n + 1 + count(r), 0)
}

/**
 * A menu of `items` under `anchor`, in the chrome's menu look, gone on a
 * choice, Escape, or a click elsewhere; `onClose` hears when it is.
 */
function openMenu(anchor: HTMLElement, items: ContextMenuItem[], onClose: () => void): () => void {
    let done = false
    let popup: TippyInstance | null = null
    const outside = (e: MouseEvent) => {
        if (!menu.dom.contains(e.target as Node) && !anchor.contains(e.target as Node)) close()
    }
    const close = () => {
        if (done) return
        done = true
        document.removeEventListener('mousedown', outside, true)
        menu.disable()
        popup?.destroy()
        popup = null
        menu.destroy()
        onClose()
    }
    const menu = new ContextMenu({
        className: 'ezco-mde-comment-menu',
        items: items.map((item) => ({
            ...item,
            onSelect: () => {
                close()
                item.onSelect()
            },
        })),
        onClose: () => close(),
    })
    const created = tippy(anchor, {
        content: menu.dom,
        showOnCreate: true,
        interactive: true,
        trigger: 'manual',
        placement: 'bottom-end',
        theme: 'ezco-mde-block-actions',
        appendTo: () => document.body,
        hideOnClick: false,
        popperOptions: {
            modifiers: [
                { name: 'preventOverflow', options: { padding: 8 } },
                { name: 'flip', options: { fallbackPlacements: ['top-end', 'bottom-start', 'top-start'] } },
            ],
        },
        onShown: () => menu.focus(),
    }) as TippyInstance | TippyInstance[]
    popup = Array.isArray(created) ? created[0] : created
    menu.enable()
    document.addEventListener('mousedown', outside, true)
    return close
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
    /** Comments whose thread is unfolded under them. */
    private open = new Set<string>()
    /** Replies whose own answers are folded away ([+]). */
    private folded = new Set<string>()
    /** Comments whose reactions are all shown, not the first few. */
    private allReactions = new Set<string>()
    /** The "…" menu open, if one is. */
    private menu: (() => void) | null = null
    private key = ''
    info!: CommentInfo

    constructor(private readonly margin: Margin, readonly id: string) {
        this.dom = el('article', 'ezco-mde-comment-card')
        this.dom.dataset.comment = id
        this.dom.tabIndex = 0
        this.context = el('div', 'ezco-mde-comment-context')
        this.messages = el('div', 'ezco-mde-comment-messages')
        // What the card holds scrolls when there is more than fits.
        const inside = el('div', 'ezco-mde-comment-inside')
        inside.append(this.context, this.messages)
        this.dom.append(inside)
        // Looking at the card is looking at its comment.
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
            if (this.menu) {
                this.menu()
                return
            }
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
        this.dom.classList.toggle('is-pending', !!info.draft)
        const [who] = byline(info)
        this.dom.setAttribute('aria-label', `${info.draft ? 'Draft comment' : 'Comment'} by ${who}`)
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
            [...this.open],
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
        if (this.margin.floating) context.push(glyph(CLOSE_ICON, 'Close', () => this.margin.close(), 'ezco-mde-comment-tool is-close'))
        if (info.target.orphaned) {
            const orphan = el('div', 'ezco-mde-comment-orphan')
            orphan.append(el('span', 'ezco-mde-comment-quote', quoteOf(info.target.link.fragment)), el('span', undefined, ' is no longer in the note.'))
            if (author && !info.draft) orphan.append(button('Anchor to selection', () => editor.commands.anchorComment(this.id), 'ezco-mde-comment-link', 'Point this at the selected text instead'))
            context.push(orphan)
        }
        this.context.replaceChildren(...context)
        this.context.hidden = !context.length

        this.messages.replaceChildren(this.message(info, 0, author))
        this.margin.schedule()
    }

    /** A comment as a message: who and when, the bubble, the row under it
     *  (reactions, React, the reply count, "…"), and its thread. */
    private message(c: CommentInfo, depth: number, author: string | null): HTMLElement {
        const { editor } = this.margin
        const deleted = c.body === DELETED_BODY
        const box = el('div', depth ? 'ezco-mde-comment-message is-reply' : 'ezco-mde-comment-message')
        box.dataset.comment = c.id
        box.classList.toggle('is-deleted', deleted)
        box.classList.toggle('is-mine', author !== null && c.author === author)
        box.classList.toggle('is-pending', !!c.draft)

        const head = el('div', 'ezco-mde-comment-head')
        const [who, at] = byline(c)
        if (depth && c.replies.length) {
            // As threads fold on a news site: the answers under a reply.
            const folded = this.folded.has(c.id)
            head.append(
                button(folded ? '[+]' : '[–]', () => {
                    if (folded) this.folded.delete(c.id)
                    else this.folded.add(c.id)
                    this.render()
                }, 'ezco-mde-comment-fold', folded ? `Show ${count(c)} ${count(c) === 1 ? 'answer' : 'answers'}` : 'Fold answers'),
            )
        }
        head.append(el('span', 'ezco-mde-comment-author', who))
        if (at) {
            const time = el('time', 'ezco-mde-comment-time', at)
            time.dateTime = c.time
            head.append(time)
        }
        if (c.draft) head.append(el('span', 'ezco-mde-comment-status is-pending', 'Draft'))
        if (c.resolved) head.append(el('span', 'ezco-mde-comment-status', 'Resolved'))
        box.append(head)

        // The text in its bubble, rendered as the note renders text, or the
        // composer editing it in its place.
        const bubble = el('div', 'ezco-mde-comment-bubble')
        if (this.editing?.id === c.id) {
            bubble.classList.add('is-editing')
            bubble.append(this.editing.composer.dom)
        } else {
            const body = el('div', 'ezco-mde-body ezco-mde-comment-body')
            if (deleted) body.append(el('span', 'ezco-mde-comment-deleted', 'Deleted'))
            else body.append(renderMarkdown(editor, c.body))
            bubble.append(body)
        }
        box.append(bubble)

        // Under the bubble: reactions, React, how many replies, and "…".
        // A deletion is asked about in the same row.
        const row = el('div', 'ezco-mde-comment-under')
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
            const reactions = reactionsOf(c)
            const all = this.allReactions.has(c.id)
            const shown = all || reactions.length <= REACTIONS_SHOWN ? reactions : reactions.slice(0, REACTIONS_SHOWN - 1)
            const me = this.margin.identity()
            for (const [emoji, given] of shown) {
                const chip = button(`${emoji} ${given.length}`, () => editor.commands.reactToComment(c.id, emoji), 'ezco-mde-comment-reaction', given.map((r) => `@${r.by}`).join(', '))
                chip.setAttribute('aria-pressed', String(!!me && given.some((r) => r.by === me)))
                chip.disabled = !me || !!c.draft
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
            if (me && !c.draft) row.append(glyph(REACT_ICON, 'React', (b) => openReactionPicker(b, (emoji) => editor.commands.reactToComment(c.id, emoji))))
            if (!depth) {
                // The count opens the thread; with nothing to open, it
                // starts the first reply.
                const n = count(c)
                const open = this.open.has(c.id)
                const replies = button(String(n), () => {
                    if (!n) {
                        if (author) this.reply(c)
                        return
                    }
                    if (open) this.open.delete(c.id)
                    else this.open.add(c.id)
                    this.render()
                }, 'ezco-mde-comment-action is-replies', n ? (open ? 'Hide replies' : `Show ${n} ${n === 1 ? 'reply' : 'replies'}`) : author ? 'Reply' : 'No replies')
                replies.insertAdjacentHTML('afterbegin', REPLIES_ICON)
                replies.setAttribute('aria-expanded', String(open))
                replies.disabled = !n && !author
                row.append(replies)
            }
            const items = this.menuFor(c, depth, author, deleted)
            if (items.length) {
                const more = glyph(MORE_ICON, 'More', (b) => {
                    if (this.menu) {
                        this.menu()
                        return
                    }
                    more.setAttribute('aria-expanded', 'true')
                    this.menu = openMenu(b, items, () => {
                        this.menu = null
                        more.setAttribute('aria-expanded', 'false')
                    })
                })
                more.setAttribute('aria-haspopup', 'menu')
                more.setAttribute('aria-expanded', 'false')
                row.append(more)
            }
        }
        box.append(row)

        // The thread: a comment's, unfolded on request (or while answering
        // it); a reply's answers, unless folded away.
        const unfolded = depth ? !this.folded.has(c.id) : this.open.has(c.id) || this.replying?.id === c.id
        if (unfolded) {
            const thread = this.thread(c, depth, author)
            if (thread.childElementCount) box.append(thread)
        }
        return box
    }

    /** The replies under `c`, each a message, and the reply being written
     *  or the field for the next one. */
    private thread(c: CommentInfo, depth: number, author: string | null): HTMLElement {
        const list = el('div', 'ezco-mde-comment-thread')
        for (const r of c.replies) list.append(this.message(r, depth + 1, author))
        if (this.replying?.id === c.id) list.append(this.replying.composer.dom)
        else if (!depth && author && this.open.has(c.id) && !(c.body === DELETED_BODY)) {
            const kept = readDraft(this.draftKey(c.id))
            list.append(button(kept ? 'Reply · draft' : 'Reply…', () => this.reply(c), 'ezco-mde-comment-reply-field', 'Reply'))
        }
        return list
    }

    /** What "…" offers for `c`: the rest of what can be done to it. */
    private menuFor(c: CommentInfo, depth: number, author: string | null, deleted: boolean): ContextMenuItem[] {
        const { editor } = this.margin
        const me = this.margin.identity()
        const items: ContextMenuItem[] = []
        if (author && !deleted) items.push({ label: 'Reply', onSelect: () => this.reply(c) })
        if (me && !depth && !c.draft) {
            items.push(
                c.resolved
                    ? { label: 'Reopen', onSelect: () => editor.commands.reopenComment(c.id) }
                    : {
                          label: 'Resolve',
                          onSelect: () => {
                              editor.commands.resolveComment(c.id)
                              this.margin.close()
                          },
                      },
            )
        }
        if (author && !deleted) items.push({ label: 'Edit', onSelect: () => this.edit(c) })
        if (c.draft) {
            if (author) {
                items.push(
                    { label: 'Publish draft', onSelect: () => editor.commands.publishComments([c.id]) },
                    { label: 'Discard draft', onSelect: () => editor.commands.discardComments([c.id]) },
                )
            }
        } else {
            if (author && !deleted) {
                items.push({
                    label: 'Delete',
                    onSelect: () => {
                        this.confirming = c.id
                        this.render()
                    },
                })
            }
            items.push({ label: 'Open document', onSelect: () => editor.commands.openComment(c.id) })
        }
        return items
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
        const posted = () => {
            clearDraft(draft)
            this.stopReplying()
            if (c.id === this.id) this.open.add(c.id)
            this.render()
        }
        const composer = new Composer({
            editor,
            extensions: this.margin.composerExtensions(),
            placeholder: `Reply to ${who}…`,
            // An answer to a draft is a draft until both are published.
            submitLabel: c.draft ? 'Draft' : 'Reply',
            initial: readDraft(draft) ?? '',
            onChange: (markdown) => writeDraft(draft, markdown),
            onSubmit: (body) => {
                if (editor.commands.replyToComment(c.id, body, { draft: !!c.draft })) posted()
            },
            ...(c.draft
                ? {}
                : {
                      secondaryLabel: 'Draft',
                      onSecondary: (body: string) => {
                          if (editor.commands.replyToComment(c.id, body, { draft: true })) posted()
                      },
                      // The reply's document, made with what was written, opened
                      // in the editor: where a longer one is written.
                      onExpand: () => {
                          const body = this.replying?.composer.value() ?? ''
                          if (editor.commands.replyToComment(c.id, body, { open: true })) {
                              clearDraft(draft)
                              this.stopReplying()
                          }
                      },
                  }),
            // Done for now: the draft is kept, the card closes.
            onCancel: () => {
                this.stopReplying()
                this.margin.close()
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
            // The comment's own document, in the editor (a draft has none).
            ...(c.draft
                ? {}
                : {
                      onExpand: () => {
                          this.stopEditing()
                          editor.commands.openComment(c.id)
                      },
                  }),
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
        this.menu?.()
        this.stopEditing()
        this.stopReplying()
        this.dom.remove()
    }
}

/** What a card shows of a comment, for telling whether to draw it again. */
function summary(c: CommentInfo): unknown {
    return [c.ref.source, c.ref.line, c.ref.text, c.body, c.resolved, c.target.orphaned, !!c.draft, c.reactions.map((r) => [r.by, r.emoji]), c.replies.map(summary)]
}

/** The composer for a new comment: small, by the end of the text it is
 *  about; posted at once, or kept as a draft. */
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
        const ranges = () => ((editor.storage as any).comments.draft() as { ranges: { from: number; to: number }[] } | null)?.ranges ?? []
        this.composer = new Composer({
            editor,
            extensions: margin.composerExtensions(),
            placeholder: 'Comment…',
            submitLabel: 'Comment',
            compact: true,
            initial: readDraft(key) ?? '',
            onChange: (markdown) => writeDraft(key, markdown),
            onSubmit: (body) => {
                if (editor.commands.addComment({ body, ranges: ranges() })) clearDraft(key)
            },
            secondaryLabel: 'Draft',
            onSecondary: (body) => {
                if (editor.commands.addComment({ body, ranges: ranges(), draft: true })) clearDraft(key)
            },
            onCancel: () => {
                editor.commands.cancelComment()
                editor.commands.focus()
            },
            onExpand: () => {
                if (editor.commands.addComment({ body: this.composer.value(), ranges: ranges(), open: true })) clearDraft(key)
            },
        })
        const inside = el('div', 'ezco-mde-comment-inside')
        inside.append(head, this.composer.dom)
        this.dom.append(inside)
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
    /** The note's drafts: how many, published or discarded together. */
    private readonly bar: HTMLElement
    private readonly list: HTMLElement
    private readonly cards = new Map<string, Card>()
    private draft: Draft | null = null
    private showResolved = false
    /** Discarding the drafts is being asked about. */
    private discarding = false
    /** Comments float over the note's edge (the default layout, or a column
     *  that would not fit). */
    floating: boolean
    private frame = 0
    private headKey = ''
    private barKey = ''
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
        this.bar = el('div', 'ezco-mde-comment-drafts')
        this.bar.hidden = true
        this.list = el('div', 'ezco-mde-comment-list')
        this.dom.append(this.head, this.bar, this.list)
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
        const drafts = this.comments.drafts().length
        const visible = this.floating
            ? state.comments.filter((c) => c.id === state.active)
            : state.comments.filter((c) => !c.resolved || this.showResolved || c.id === state.active)
        this.dom.hidden = this.floating ? !state.active && !state.draft && !drafts : !state.comments.length && !state.draft && !drafts
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

        // The drafts: published or discarded all at once.
        if (!drafts) this.discarding = false
        const barKey = `${drafts}/${this.discarding}`
        if (barKey !== this.barKey) {
            this.barKey = barKey
            this.bar.hidden = !drafts
            this.bar.replaceChildren()
            if (drafts) {
                this.bar.append(el('span', 'ezco-mde-comment-drafts-count', drafts === 1 ? '1 draft' : `${drafts} drafts`))
                if (this.discarding) {
                    this.bar.append(
                        el('span', 'ezco-mde-comment-question', 'Discard them?'),
                        button('Discard', () => this.editor.commands.discardComments(), 'ezco-mde-comment-action is-danger', 'Discard every draft'),
                        button('Keep', () => {
                            this.discarding = false
                            this.update()
                        }, 'ezco-mde-comment-action', 'Keep them'),
                    )
                } else {
                    this.bar.append(
                        button('Publish', () => this.editor.commands.publishComments(), 'ezco-mde-comment-action is-primary', 'Publish every draft'),
                        button('Discard', () => {
                            this.discarding = true
                            this.update()
                        }, 'ezco-mde-comment-action', 'Discard every draft'),
                    )
                }
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
        const box = this.list.getBoundingClientRect()
        const origin = box.top
        const size = this.view.state.doc.content.size
        // Beside the note, a card is level with its text; over it (floating),
        // just below its text, so the text stays in view. A comment on the
        // whole note sits at the top.
        const at = (range: { from: number; to: number } | null) => {
            if (!range) return 0
            try {
                return this.floating
                    ? this.view.coordsAtPos(Math.min(range.to, size), -1).bottom - origin + GAP
                    : this.view.coordsAtPos(Math.min(range.from, size)).top - origin
            } catch {
                return 0
            }
        }
        // Over the note, the composer for a new comment stands at the end of
        // the text it is about, as far left as that is (but on the note).
        const endX = (range: { from: number; to: number } | null, dom: HTMLElement): number | null => {
            if (!range || !this.floating) return null
            try {
                const end = this.view.coordsAtPos(Math.min(range.to, size), -1)
                return Math.max(0, Math.min(end.left - box.left, box.width - dom.offsetWidth))
            } catch {
                return null
            }
        }
        type Placed = { dom: HTMLElement; want: number; height: number; top: number; fixed: boolean; range: { from: number; to: number } | null; x: number | null }
        const placed: Placed[] = []
        for (const info of state.comments) {
            const card = this.cards.get(info.id)
            if (!card || card.dom.hidden) continue
            const range = info.target.whole ? null : info.target.range
            placed.push({ dom: card.dom, want: at(range), height: card.dom.offsetHeight, top: 0, fixed: info.id === state.active && !state.draft, range, x: null })
        }
        if (this.draft && state.draft) {
            const range = state.draft.ranges[0] ?? null
            placed.push({ dom: this.draft.dom, want: at(range), height: this.draft.dom.offsetHeight, top: 0, fixed: true, range, x: endX(range, this.draft.dom) })
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
                    if (p.range) above = this.view.coordsAtPos(Math.min(p.range.from, size)).top - origin - GAP - p.height
                } catch {
                    above = -1
                }
                p.top = above >= 0 ? above : Math.max(0, limit - p.height)
            }
        }
        // Placed with `top` (and `left` for the composer), not a transform:
        // text on a transformed layer renders soft in some engines.
        let bottom = 0
        for (const p of placed) {
            p.dom.style.top = `${Math.round(p.top)}px`
            p.dom.style.left = p.x === null ? '' : `${Math.round(p.x)}px`
            p.dom.style.right = p.x === null ? '' : 'auto'
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
