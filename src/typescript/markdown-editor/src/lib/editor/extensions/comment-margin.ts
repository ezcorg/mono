/**
 * Where a note's comments are read and answered (comments RFC).
 *
 * By default nothing shows beside the note: commented text is marked, and
 * clicking it (or `focusComment`) opens that one comment over the note's
 * edge, under its text (above it when there is no room under); Escape,
 * Dismiss in its menu, or a click elsewhere closes it (`layout: 'float'`).
 * Every comment can be had in view instead: a column beside the note, each
 * level with its text (`layout: 'column'`), or a panel, a list beside the
 * note that scrolls on its own (`layout: 'panel'`), which the reader can
 * also ask for from a bubble's menu or ⌘⇧M and put away again. Where a
 * column or a panel would leave the note too narrow, the comments float
 * after all.
 *
 * A comment is a bubble: who and when, its text as the note shows text (a
 * read-only editor of the note's make, so a fence in a fence shows as the
 * note shows it), and under the bubble, standing on their own, its
 * reactions and the reply count. A chevron in the bubble's corner holds
 * the rest: first the reactions to give (the common and recent ones, and
 * the whole grid behind the last), then the actions in groups: Edit and
 * Reply, Resolve, the composer panel and the file, Delete, the comments
 * panel and Dismiss. Long text folds after a few lines, with the fold to
 * open it. [−] after a byline collapses that message and everything under
 * it to the byline; [+] brings it back. Replies are bubbles indented under
 * their comment: the indentation is the thread. A comment's first replies
 * are shown; a reply's own are behind its count. In a panel, a click on a
 * comment takes the note to its text.
 *
 * Writing happens in a bubble: a reply in a composer right under the
 * comment it answers, an edit in the bubble itself, which keeps its shape
 * and takes the accent while it is written in; the composer's Cancel and
 * its one filled button stand under the bubble. What is typed is a draft,
 * kept in this browser until posted; nothing has to be asked for. A comment
 * written in full goes to the sheet (`comment-sheet.ts`), beside the note,
 * from the composer's menu or ⌘⇧↩.
 */
import { Extension, type AnyExtension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import tippy, { type Instance as TippyInstance } from 'tippy.js'
import type { FileOperations } from '@joinezco/storage'
import { parseTextFragment, type Reaction, type Wikilink } from '@joinezco/vault'
import { DELETED_BODY, RESOLVED, commentsKey, type CommentInfo, type CommentsStorage } from './comments'
import { Composer } from './comment-composer'
import { clearDraft, draftKey, readDraft, renderReadOnly, when, writeDraft, type ReadOnlyView } from './comment-render'
import { Sheet } from './comment-sheet'
import { QUICK_REACTIONS, openEmojiPicker, recentEmoji, rememberEmoji } from './emoji-picker'
import { ContextMenu, isSeparator, type ContextMenuEntry, type ContextMenuItem } from '../ui/context-menu'
import { scrollerOf } from './rail'
import type { FileSystemStorage } from './filesystem'

type Mount = HTMLElement | ((editorRoot: HTMLElement) => HTMLElement | null | void)

export type CommentLayout = 'float' | 'column' | 'panel'

export interface CommentMarginOptions {
    /** Where a column or a panel goes (`createEditor` gives it the column
     *  beside the note; without a mount the margin makes one). */
    mount?: Mount
    /** `float` (default): the comment looked at, over the note's edge.
     *  `column`: every comment beside the note, level with its text.
     *  `panel`: every comment in a list beside the note that scrolls on
     *  its own. */
    layout?: CommentLayout
    /** The extensions a comment is written and shown with (the note's setup
     *  without its chrome, from `createEditor`); `minimalSetup` without. */
    composer?: () => AnyExtension[]
}

export interface CommentMarginStorage {
    /** Open the comment document at `path` in the sheet beside the note. */
    open: (path: string) => void
    /** The sheet, while one is open: where a quoted selection goes. */
    sheet: { readonly path: string; quote(link: Wikilink): void } | null
    /** Every comment in a panel beside the note, or back to how the host
     *  had them. */
    togglePanel: () => boolean
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        commentMargin: {
            /** Show every comment in a panel beside the note, or put the panel away. */
            toggleCommentsPanel: () => ReturnType
        }
    }
}

/** The note is not squeezed narrower than this to make room beside it. */
const NOTE_MIN = 400
/** A column or panel beside the note: this wide, narrower when the note
 *  would otherwise be squeezed, never narrower than the least. */
const SIDE_WIDTH = 360
const SIDE_MIN = 240
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

const svg = (body: string) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${body}</svg>`
const stroke = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
/** The React control's glyph: a face, as reactions are drawn. */
const REACT_ICON = svg(
    '<path fill="currentColor" d="M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1Zm0 1.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM5.5 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm5 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM5.3 9.6a.75.75 0 0 1 1.05.15c.4.53 1 .85 1.65.85s1.25-.32 1.65-.85a.75.75 0 1 1 1.2.9A3.55 3.55 0 0 1 8 12.1a3.55 3.55 0 0 1-2.85-1.45.75.75 0 0 1 .15-1.05Z"/>',
)
/** The replies control's glyph: a speech bubble, the count beside it. */
const REPLIES_ICON = svg(`<path ${stroke} d="M2.5 3.5h11v7H7.5l-3 2.5v-2.5h-2z"/>`)
/** The menu's glyph, in a bubble's corner: a chevron. */
const CHEVRON_ICON = svg(`<path ${stroke} stroke-width="1.6" d="M4 6.5 8 10.5l4-4"/>`)
// The menu's glyphs, one per thing to do.
const REPLY_ICON = svg(`<path ${stroke} d="M6.5 4.5 3 8l3.5 3.5M3 8h6a4 4 0 0 1 4 4v.5"/>`)
const RESOLVE_ICON = svg(`<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path ${stroke} d="m5.5 8 1.8 1.8L10.8 6"/>`)
const REOPEN_ICON = svg(`<path ${stroke} d="M13 8a5 5 0 1 1-1.5-3.6M13 3v2.5h-2.5"/>`)
const EDIT_ICON = svg(`<path ${stroke} d="M3 13h3l7-7-3-3-7 7zM9 4l3 3"/>`)
const SHEET_ICON = svg(`<rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path stroke="currentColor" stroke-width="1.5" d="M9.5 3v10"/>`)
const FILE_ICON = svg(`<path ${stroke} d="M4 2.5h5l3 3v8H4zM9 2.5v3h3"/><path ${stroke} d="M6 8.5h4M6 11h4"/>`)
const DELETE_ICON = svg(`<path ${stroke} d="M3 4.5h10M6.5 4.5v-1h3v1M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4"/>`)
const PANEL_ICON = svg(`<path ${stroke} d="M3 4.5h10M3 8h10M3 11.5h6"/>`)
const DISMISS_ICON = svg(`<path ${stroke} stroke-width="1.6" d="M4 4l8 8M12 4l-8 8"/>`)

/** The words for the two ways to write at length. */
const SHEET_LABEL = 'Composer panel'
const FILE_LABEL = 'Open as file'
const SEPARATOR: ContextMenuEntry = { type: 'separator' }
/** Reactions offered in the menu, before the whole grid. */
const REACTIONS_OFFERED = 9

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

/** Who and when, as a bubble says it. */
function byline(c: CommentInfo): [string, string] {
    return c.time ? [`@${c.author}`, when(c.time)] : [c.author, '']
}

/** How many answers `c` has, at every depth. */
function count(c: CommentInfo): number {
    return c.replies.reduce((n, r) => n + 1 + count(r), 0)
}

const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word.replace(/y$/, 'ie')}s`}`

/**
 * A menu of `items` under `anchor`, in the chrome's menu look, gone on a
 * choice, Escape, or a click elsewhere; `onClose` hears when it is.
 */
function openMenu(anchor: HTMLElement, items: ContextMenuEntry[], onClose: () => void, before?: HTMLElement): () => void {
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
        items: items.map((item) =>
            isSeparator(item)
                ? item
                : {
                      ...item,
                      onSelect: () => {
                          close()
                          item.onSelect()
                      },
                  },
        ),
        onClose: () => close(),
    })
    if (before) menu.dom.prepend(before)
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

/** The chevron in a bubble's corner, with `items` behind it (and `before`
 *  them, when given, the reactions to give). */
function chevron(items: () => ContextMenuEntry[], holder: { menu: (() => void) | null }, before?: (close: () => void) => HTMLElement): HTMLButtonElement {
    const more = glyph(CHEVRON_ICON, 'Comment menu', (b) => {
        if (holder.menu) {
            holder.menu()
            return
        }
        more.setAttribute('aria-expanded', 'true')
        const close = () => holder.menu?.()
        holder.menu = openMenu(b, items(), () => {
            holder.menu = null
            more.setAttribute('aria-expanded', 'false')
        }, before?.(close))
    }, 'ezco-mde-comment-menu-button')
    more.setAttribute('aria-haspopup', 'menu')
    more.setAttribute('aria-expanded', 'false')
    return more
}

/**
 * The reactions to give, at the top of a bubble's menu: the ones given
 * recently and the common ones, two rows of them, the last cell opening
 * the whole grid. The reader's own are marked.
 */
function reactionsBlock(mine: Set<string>, anchor: HTMLElement, give: (emoji: string) => void, close: () => void): HTMLElement {
    const block = el('div', 'ezco-mde-comment-menu-reactions')
    block.setAttribute('role', 'group')
    block.setAttribute('aria-label', 'React')
    const seen = new Set<string>()
    const offered = [...recentEmoji(), ...QUICK_REACTIONS].filter((e) => !seen.has(e) && seen.add(e)).slice(0, REACTIONS_OFFERED)
    for (const emoji of offered) {
        const cell = button(emoji, () => {
            close()
            rememberEmoji(emoji)
            give(emoji)
        }, 'ezco-mde-emoji-cell', `React ${emoji}`)
        cell.setAttribute('aria-pressed', String(mine.has(emoji)))
        block.append(cell)
    }
    // The whole grid, with search, from the menu's anchor once the menu is gone.
    block.append(
        glyph(REACT_ICON, 'More emoji', () => {
            close()
            openEmojiPicker(anchor, (emoji) => {
                rememberEmoji(emoji)
                give(emoji)
            })
        }, 'ezco-mde-emoji-cell is-more'),
    )
    return block
}

/**
 * A composer as a bubble of its own: who is writing over the field, a
 * chevron with the way to the sheet, and the composer's buttons under the
 * bubble. A reply right under the comment it answers, and a new comment.
 */
function composerBlock(composer: Composer, author: string, items: () => ContextMenuEntry[], holder: { menu: (() => void) | null }): HTMLElement {
    const box = el('div', 'ezco-mde-comment-message is-composer')
    const bubble = el('div', 'ezco-mde-comment-bubble is-editing')
    const head = el('div', 'ezco-mde-comment-head')
    head.append(el('span', 'ezco-mde-comment-author', `@${author}`), chevron(items, holder))
    const content = el('div', 'ezco-mde-comment-content is-editing')
    content.append(composer.field)
    bubble.append(head, content)
    const under = el('div', 'ezco-mde-comment-under')
    under.append(composer.actions)
    box.append(bubble, under)
    return box
}

// ── A card: one comment's bubbles ───────────────────────────────────────────

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
    /** Threads opened or closed by hand (the default: a comment's open, a
     *  reply's closed). */
    private threads = new Map<string, boolean>()
    /** Messages collapsed to their byline, everything under them with them. */
    private collapsed = new Set<string>()
    /** Comments whose reactions are all shown, not the first few. */
    private allReactions = new Set<string>()
    /** Comments whose long text is shown in full. */
    private expanded = new Set<string>()
    /** The menu open, if one is. */
    readonly holder: { menu: (() => void) | null } = { menu: null }
    /** The read-only views showing the texts, gone with the next render. */
    private views: ReadOnlyView[] = []
    private key = ''
    info!: CommentInfo

    constructor(private readonly margin: Margin, readonly id: string) {
        this.dom = el('article', 'ezco-mde-comment-card')
        this.dom.dataset.comment = id
        this.dom.tabIndex = 0
        this.context = el('div', 'ezco-mde-comment-context')
        this.messages = el('div', 'ezco-mde-comment-messages')
        // What the card holds scrolls when there is more than fits the frame.
        const inside = el('div', 'ezco-mde-comment-inside')
        inside.append(this.context, this.messages)
        this.dom.append(inside)
        // Looking at the card is looking at its comment; beside the note, a
        // click on it takes the note to the comment's text as well.
        this.dom.addEventListener('mousedown', (e) => {
            if ((e.target as HTMLElement).closest('a, button, [data-wikilink], .ezco-mde-comment-input, .ezco-mde-readonly')) return
            this.lookAt()
            if (!this.margin.floating) this.margin.reveal(this.id)
        })
        this.dom.addEventListener('focusin', () => this.lookAt())
        this.dom.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            if (this.holder.menu) {
                this.holder.menu()
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

    /** Whether the replies under `c` are shown: a comment's are, a reply's
     *  are not, unless asked otherwise. */
    private threadOpen(c: CommentInfo, depth: number): boolean {
        return this.threads.get(c.id) ?? depth === 0
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
            this.margin.switched,
            this.editing?.id ?? null,
            this.replying?.id ?? null,
            this.confirming,
            [...this.threads],
            [...this.collapsed],
            [...this.allReactions],
            [...this.expanded],
        ])
        if (key === this.key) return
        this.key = key
        this.render()
    }

    private render() {
        const { editor } = this.margin
        const info = this.info
        const author = this.margin.author()
        for (const view of this.views) view.destroy()
        this.views = []

        const context: Node[] = []
        if (info.target.orphaned) {
            const orphan = el('div', 'ezco-mde-comment-orphan')
            orphan.append(el('span', 'ezco-mde-comment-quote', quoteOf(info.target.link.fragment)), el('span', undefined, ' is no longer in the note.'))
            if (author) orphan.append(button('Anchor to selection', () => editor.commands.anchorComment(this.id), 'ezco-mde-comment-link', 'Point this at the selected text instead'))
            context.push(orphan)
        }
        this.context.replaceChildren(...context)
        this.context.hidden = !context.length

        this.messages.replaceChildren(this.message(info, 0, author))
        requestAnimationFrame(() => this.clamp())
        this.margin.schedule()
    }

    /** Long texts folded after a few lines, each with its fold to open it. */
    private clamp() {
        if (!this.dom.isConnected) return
        for (const text of this.dom.querySelectorAll<HTMLElement>('.ezco-mde-comment-content')) {
            const more = text.nextElementSibling as HTMLElement | null
            if (!more?.classList.contains('ezco-mde-comment-more')) continue
            if (text.classList.contains('is-expanded') || text.classList.contains('is-editing')) {
                text.classList.remove('is-clamped')
                more.hidden = text.classList.contains('is-editing')
                continue
            }
            // The text's own height against the fold (not the wrapper's scroll
            // height, which counts what the editor keeps beside the text).
            const body = text.querySelector<HTMLElement>('.ezco-mde-readonly > .ezco-mde-body')
            const over = (body ? body.offsetHeight : text.scrollHeight) > text.clientHeight + 1
            text.classList.toggle('is-clamped', over)
            more.hidden = !over
        }
        this.margin.schedule()
    }

    /** A comment as a bubble: [−], who and when, the menu's chevron; the
     *  text; under the bubble its reactions, React and the reply count; the
     *  reply being written to it; and its thread. */
    private message(c: CommentInfo, depth: number, author: string | null): HTMLElement {
        const { editor } = this.margin
        const deleted = c.body === DELETED_BODY
        const box = el('div', depth ? 'ezco-mde-comment-message is-reply' : 'ezco-mde-comment-message')
        box.dataset.comment = c.id
        box.classList.toggle('is-deleted', deleted)
        box.classList.toggle('is-mine', author !== null && c.author === author)
        const collapsed = this.collapsed.has(c.id)
        const editing = !collapsed && this.editing?.id === c.id

        const bubble = el('div', 'ezco-mde-comment-bubble')
        bubble.classList.toggle('is-editing', editing)
        bubble.classList.toggle('is-collapsed', collapsed)
        if (!depth) bubble.classList.add('is-anchor')

        const head = el('div', 'ezco-mde-comment-head')
        const [who, at] = byline(c)
        head.append(el('span', 'ezco-mde-comment-author', who))
        if (at) {
            const time = el('time', 'ezco-mde-comment-time', at)
            time.dateTime = c.time
            time.title = at
            head.append(time)
        }
        // As threads fold on a news site: the message and everything under
        // it, to its byline.
        head.append(
            button(collapsed ? '[+]' : '[–]', () => {
                if (collapsed) this.collapsed.delete(c.id)
                else {
                    this.collapsed.add(c.id)
                    if (this.editing?.id === c.id) this.stopEditing()
                    if (this.replying?.id === c.id) this.stopReplying()
                }
                this.render()
            }, 'ezco-mde-comment-fold', collapsed ? 'Expand' : 'Collapse'),
        )
        if (c.resolved) head.append(el('span', 'ezco-mde-comment-status', 'Resolved'))
        if (editing) head.append(el('span', 'ezco-mde-comment-status is-editing', 'Editing'))
        if (collapsed && count(c)) head.append(el('span', 'ezco-mde-comment-folded-hint', plural(count(c), 'reply')))
        const mine = author !== null && c.author === author
        const me = this.margin.identity()
        const items = editing ? this.sheetItems(c) : this.menuFor(c, depth, author, mine, deleted)
        const reactions = me && !editing && !deleted ? (close: () => void) => reactionsBlock(new Set(c.reactions.filter((r) => r.by === me).map((r) => r.emoji)), this.dom, (emoji) => editor.commands.reactToComment(c.id, emoji), close) : undefined
        if (items.length || reactions) head.append(chevron(() => items, this.holder, reactions))
        bubble.append(head)
        box.append(bubble)
        if (collapsed) return box

        // The text, as the note shows text, folded after a few lines; or
        // the composer editing it, in its place.
        const content = el('div', 'ezco-mde-comment-content')
        if (editing) {
            content.classList.add('is-editing')
            content.append(this.editing!.composer.field)
        } else if (deleted) {
            content.append(el('div', 'ezco-mde-body ezco-mde-comment-body is-deleted', 'Deleted'))
        } else {
            const view = renderReadOnly(editor, c.body, { extensions: this.margin.composerExtensions(), className: 'ezco-mde-comment-body' })
            this.views.push(view)
            content.append(view.dom)
        }
        if (this.expanded.has(c.id)) content.classList.add('is-expanded')
        const more = button(this.expanded.has(c.id) ? 'Show less' : 'Show more', () => {
            if (this.expanded.has(c.id)) this.expanded.delete(c.id)
            else this.expanded.add(c.id)
            this.render()
        }, 'ezco-mde-comment-more', this.expanded.has(c.id) ? 'Fold the text' : 'Show the whole text')
        more.hidden = !this.expanded.has(c.id)
        bubble.append(content, more)

        // Under the bubble, on their own: the composer's buttons while the
        // text is edited; else the reactions, React, and the reply count. A
        // deletion is asked about there too.
        const row = el('div', 'ezco-mde-comment-under')
        if (editing) {
            row.append(this.editing!.composer.actions)
        } else if (this.confirming === c.id) {
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
            for (const [emoji, given] of shown) {
                const chip = button(`${emoji} ${given.length}`, () => editor.commands.reactToComment(c.id, emoji), 'ezco-mde-comment-reaction', given.map((r) => `@${r.by}`).join(', '))
                chip.setAttribute('aria-pressed', String(!!me && given.some((r) => r.by === me)))
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
            // The count shows or hides the replies right under this message
            // (a reply's own answers stay behind their own count); with
            // nothing to show, it starts the first reply.
            const n = c.replies.length
            const open = this.threadOpen(c, depth)
            const replies = button(String(n), () => {
                if (!n) {
                    if (author) this.reply(c)
                    return
                }
                this.threads.set(c.id, !open)
                this.render()
            }, 'ezco-mde-comment-action is-replies', n ? (open ? 'Hide replies' : `Show ${plural(n, 'reply')}`) : author ? 'Reply' : 'No replies')
            replies.insertAdjacentHTML('afterbegin', REPLIES_ICON)
            replies.setAttribute('aria-expanded', String(open && n > 0))
            replies.disabled = !n && !author
            row.append(replies)
        }
        box.append(row)

        // The reply being written: right under the comment it answers.
        if (this.replying?.id === c.id && author) {
            const composer = this.replying.composer
            box.append(composerBlock(composer, author, () => this.longForms(() => this.replyInFull(c, true), () => this.replyInFull(c, 'note')), this.holder))
        }

        // The thread: this message's replies, each a message of its own.
        if (c.replies.length && this.threadOpen(c, depth)) {
            const thread = el('div', 'ezco-mde-comment-thread')
            for (const r of c.replies) thread.append(this.message(r, depth + 1, author))
            box.append(thread)
        }
        return box
    }

    /** What the chevron offers for `c`, in groups: to answer or change it
     *  (Edit first for one's own, Reply first for another's); to settle it;
     *  the long ways (the composer panel for one's own only); to delete it;
     *  the panel and the way out. */
    private menuFor(c: CommentInfo, depth: number, author: string | null, mine: boolean, deleted: boolean): ContextMenuEntry[] {
        const { editor } = this.margin
        const me = this.margin.identity()
        const groups: ContextMenuItem[][] = []
        const reply: ContextMenuItem = { label: 'Reply', icon: REPLY_ICON, onSelect: () => this.reply(c) }
        const edit: ContextMenuItem = { label: 'Edit', icon: EDIT_ICON, onSelect: () => this.edit(c) }
        if (author && !deleted) groups.push(mine ? [edit, reply] : [reply, edit])
        if (me && !depth) {
            groups.push([
                c.resolved
                    ? { label: 'Reopen', icon: REOPEN_ICON, onSelect: () => editor.commands.reopenComment(c.id) }
                    : {
                          label: 'Resolve',
                          icon: RESOLVE_ICON,
                          onSelect: () => {
                              editor.commands.resolveComment(c.id)
                              this.margin.close()
                          },
                      },
            ])
        }
        groups.push([
            ...(author && mine && !deleted ? [{ label: SHEET_LABEL, icon: SHEET_ICON, onSelect: () => editor.commands.openComment(c.id) }] : []),
            { label: FILE_LABEL, icon: FILE_ICON, onSelect: () => editor.commands.openCommentAsNote(c.id) },
        ])
        if (author && !deleted) {
            groups.push([
                {
                    label: 'Delete',
                    icon: DELETE_ICON,
                    onSelect: () => {
                        this.confirming = c.id
                        this.render()
                    },
                },
            ])
        }
        if (!depth) {
            const last: ContextMenuItem[] = []
            if (this.margin.switched) last.push({ label: 'Hide comments panel', icon: PANEL_ICON, onSelect: () => this.margin.togglePanel() })
            else if (this.margin.floating) last.push({ label: 'Show all comments', icon: PANEL_ICON, onSelect: () => this.margin.togglePanel() })
            if (this.margin.floating) last.push({ label: 'Dismiss', icon: DISMISS_ICON, onSelect: () => this.margin.close() })
            if (last.length) groups.push(last)
        }
        return groups.flatMap((group, i) => (i ? [SEPARATOR, ...group] : group))
    }

    /** What the chevron offers while `c` is being edited: the long ways. */
    private sheetItems(c: CommentInfo): ContextMenuEntry[] {
        const { editor } = this.margin
        return [
            {
                label: SHEET_LABEL,
                icon: SHEET_ICON,
                onSelect: () => {
                    this.stopEditing()
                    editor.commands.openComment(c.id)
                },
            },
            { label: FILE_LABEL, icon: FILE_ICON, onSelect: () => editor.commands.openCommentAsNote(c.id) },
        ]
    }

    private draftKey(id: string) {
        return draftKey(this.margin.notePath(), id, 'reply')
    }

    /** The reply's document, made with what was written, where a longer
     *  one is written: the sheet, or the editor itself. */
    private replyInFull(c: CommentInfo, open: true | 'note') {
        const body = this.replying?.composer.value() ?? ''
        if (this.margin.editor.commands.replyToComment(c.id, body, { open })) {
            clearDraft(this.draftKey(c.id))
            this.stopReplying()
        }
    }

    /** What a composer's chevron offers: the two ways to write at length. */
    private longForms(inSheet: () => void, asNote: () => void): ContextMenuEntry[] {
        return [
            { label: SHEET_LABEL, icon: SHEET_ICON, onSelect: inSheet },
            { label: FILE_LABEL, icon: FILE_ICON, onSelect: asNote },
        ]
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
        this.collapsed.delete(c.id)
        const [who] = byline(c)
        const draft = this.draftKey(c.id)
        const posted = () => {
            clearDraft(draft)
            this.stopReplying()
            // The new reply, in view under its comment.
            this.threads.set(c.id, true)
            this.render()
        }
        const composer = new Composer({
            editor,
            extensions: this.margin.composerExtensions(),
            placeholder: `Reply to ${who}…`,
            submitLabel: 'Reply',
            initial: readDraft(draft) ?? '',
            onChange: (markdown) => writeDraft(draft, markdown),
            onSubmit: (body) => {
                if (editor.commands.replyToComment(c.id, body)) posted()
            },
            onExpand: () => this.replyInFull(c, true),
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

    /** Edit a comment where it is: its text gives way to a composer, in the
     *  same bubble. */
    private edit(c: CommentInfo) {
        this.lookAt()
        this.stopEditing()
        this.stopReplying()
        this.collapsed.delete(c.id)
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
            // The comment's own document, in the sheet.
            onExpand: () => {
                this.stopEditing()
                editor.commands.openComment(c.id)
            },
        })
        this.editing = { id: c.id, composer }
        this.render()
        composer.focus()
        // The end of a long text, into view: that is where the edit goes.
        requestAnimationFrame(() => composer.field.scrollIntoView({ block: 'nearest' }))
    }

    private stopEditing() {
        this.editing?.composer.destroy()
        this.editing = null
    }

    destroy() {
        this.holder.menu?.()
        this.stopEditing()
        this.stopReplying()
        for (const view of this.views) view.destroy()
        this.views = []
        this.dom.remove()
    }
}

/** What a card shows of a comment, for telling whether to draw it again. */
function summary(c: CommentInfo): unknown {
    return [c.ref.source, c.ref.line, c.ref.text, c.body, c.resolved, c.target.orphaned, c.reactions.map((r) => [r.by, r.emoji]), c.replies.map(summary)]
}

/** The composer for a new comment: a bubble by the end of the text it is
 *  about, who is writing over it. What is typed is kept until posted. */
class NewComment {
    readonly dom: HTMLElement
    private readonly composer: Composer
    private readonly holder: { menu: (() => void) | null } = { menu: null }

    constructor(margin: Margin, author: string) {
        const { editor } = margin
        this.dom = el('article', 'ezco-mde-comment-card is-draft is-active')
        this.dom.setAttribute('aria-label', 'New comment')
        const key = draftKey(margin.notePath(), 'new', '')
        const ranges = () => ((editor.storage as any).comments.draft() as { ranges: { from: number; to: number }[] } | null)?.ranges ?? []
        const inFull = (open: true | 'note') => () => {
            if (editor.commands.addComment({ body: this.composer.value(), ranges: ranges(), open })) clearDraft(key)
        }
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
            onExpand: inFull(true),
        })
        const inside = el('div', 'ezco-mde-comment-inside')
        inside.append(
            composerBlock(this.composer, author, () => [
                { label: SHEET_LABEL, icon: SHEET_ICON, onSelect: inFull(true) },
                { label: FILE_LABEL, icon: FILE_ICON, onSelect: inFull('note') },
            ], this.holder),
        )
        this.dom.append(inside)
        this.composer.focus()
    }

    destroy() {
        this.holder.menu?.()
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
    private draft: NewComment | null = null
    private sheet: Sheet | null = null
    private showResolved = false
    /** How comments are shown now: the host's choice, or the reader's. */
    private layout: CommentLayout
    /** A column the margin made for itself (the host gave none). */
    private column: HTMLElement | null = null
    /** Comments float over the note's edge (the layout, or a column or
     *  panel that would not fit). */
    floating: boolean
    /** A panel: a list beside the note that scrolls on its own. */
    private get panel() {
        return this.layout === 'panel' && !this.floating
    }
    /** The reader asked for the panel (so it can be put away). */
    get switched() {
        return this.layout !== (this.options.layout ?? 'float')
    }
    private frame = 0
    private headKey = ''
    /** The comment the panel last scrolled to. */
    private scrolledTo: string | null = null
    private readonly observer: ResizeObserver | null
    private extensions: AnyExtension[] | null = null

    constructor(
        readonly editor: Editor,
        readonly view: EditorView,
        private readonly options: CommentMarginOptions,
        private readonly storage: CommentMarginStorage,
    ) {
        this.layout = options.layout ?? 'float'
        this.floating = this.layout === 'float'
        this.dom = el('section', 'ezco-mde-comment-margin')
        this.dom.setAttribute('aria-label', 'Comments')
        this.head = el('header', 'ezco-mde-comment-margin-head')
        this.list = el('div', 'ezco-mde-comment-list')
        this.dom.append(this.head, this.list)
        this.place()
        this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule())
        this.observer?.observe(view.dom)
        if (view.dom.parentElement) this.observer?.observe(view.dom.parentElement)
        storage.open = (path) => this.openSheet(path)
        storage.sheet = null
        storage.togglePanel = () => this.togglePanel()
        this.update()
    }

    /** The margin where its layout puts it: over the note, or beside it. */
    private place() {
        if (this.floating) {
            // Over the note it is as wide as the note; a width kept from a
            // column or panel would pen the cards in.
            this.dom.style.width = ''
            this.view.dom.after(this.dom)
            if (this.column) {
                this.column.remove()
                this.column = null
            }
            return
        }
        const root = (this.view.dom.closest('.ezco-mde') as HTMLElement | null) ?? this.view.dom
        const mount = this.options.mount
        let host = mount instanceof HTMLElement ? mount : typeof mount === 'function' ? mount(root) ?? null : null
        if (!host) {
            // No column from the host: one of the margin's own, right of the note.
            const content = this.view.dom.closest('.ezco-mde-content') as HTMLElement | null
            if (content) {
                host = this.column ?? el('div', 'ezco-mde-comments')
                if (!host.isConnected) content.append(host)
                this.column = host
            }
        }
        if (host) host.appendChild(this.dom)
        else this.view.dom.after(this.dom)
    }

    /** Every comment in a panel, or back to the host's layout. */
    togglePanel(): boolean {
        this.layout = this.switched ? this.options.layout ?? 'float' : 'panel'
        this.floating = this.layout === 'float'
        this.scrolledTo = null
        this.place()
        this.headKey = ''
        this.update()
        return true
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

    /** Bring the text comment `id` is about into the middle of the frame. */
    reveal(id: string) {
        const state = commentsKey.getState(this.view.state)
        const range = state?.comments.find((c) => c.id === id)?.target.range
        if (!range) return
        let top: number
        try {
            top = this.view.coordsAtPos(range.from).top
        } catch {
            return
        }
        const scroller = scrollerOf(this.view.dom)
        if (scroller) {
            const box = scroller.getBoundingClientRect()
            scroller.scrollTo({ top: scroller.scrollTop + (top - box.top) - scroller.clientHeight / 2, behavior: 'smooth' })
        } else window.scrollTo({ top: window.scrollY + top - window.innerHeight / 2, behavior: 'smooth' })
    }

    /** Done looking: no card, the caret back in the note. */
    close() {
        this.editor.commands.focusComment(null)
        this.editor.commands.focus()
    }

    /** The open note's path (drafts are kept per note). */
    notePath(): string | null {
        return this.persistence()?.options?.filepath ?? null
    }

    private persistence(): FileSystemStorage | undefined {
        return (this.editor.storage as any).persistence as FileSystemStorage | undefined
    }

    private files(): FileOperations | undefined {
        const codeblock = this.editor.extensionManager.extensions.find((e) => e.name === 'ezcodeBlock')
        return (codeblock?.options as { files?: FileOperations } | undefined)?.files
    }

    /** What a comment is written and shown with; the host's list, made once. */
    composerExtensions(): AnyExtension[] | undefined {
        if (!this.options.composer) return undefined
        return (this.extensions ??= this.options.composer())
    }

    // ── The sheet ────────────────────────────────────────────────────────

    /** The document at `path`, in the sheet beside the note. */
    openSheet(path: string) {
        if (this.sheet?.path === path) {
            this.sheet.editor.commands.focus()
            return
        }
        void this.closeSheet()
        const fs = this.persistence()?.options.fs
        if (!fs) return
        const sheet = new Sheet({
            host: this.editor,
            path,
            fs,
            extensions: this.composerExtensions(),
            openAsNote: () => {
                void this.closeSheet()
                const c = this.comments.comments().find((x) => x.ref.source === path)
                if (c) this.editor.commands.openCommentAsNote(c.id)
                else void this.persistence()?.loadFile(path)
            },
            remove: async () => {
                await this.files()?.remove(path)
            },
            onClose: () => {
                if (this.sheet === sheet) {
                    this.sheet = null
                    this.storage.sheet = null
                }
            },
        })
        this.sheet = sheet
        this.storage.sheet = sheet
    }

    private closeSheet(): Promise<void> {
        const sheet = this.sheet
        this.sheet = null
        this.storage.sheet = null
        return sheet ? sheet.close() : Promise.resolve()
    }

    // ── The cards ────────────────────────────────────────────────────────

    update() {
        const state = commentsKey.getState(this.view.state)
        if (!state) return
        const resolved = state.comments.filter((c) => c.resolved).length
        const visible = this.floating
            ? state.comments.filter((c) => c.id === state.active)
            : state.comments.filter((c) => !c.resolved || this.showResolved || c.id === state.active)
        this.dom.hidden = this.floating ? !state.active && !state.draft : !state.comments.length && !state.draft
        this.dom.classList.toggle('is-floating', this.floating)
        this.dom.classList.toggle('is-panel', this.panel)

        // The column's head: how many, the resolved ones on request, and the
        // way to put a panel the reader asked for away.
        const open = state.comments.length - resolved
        const headKey = `${this.floating}/${this.switched}/${open}/${resolved}/${this.showResolved}`
        if (headKey !== this.headKey) {
            this.headKey = headKey
            const title = el('span', 'ezco-mde-comment-margin-title', plural(open, 'comment'))
            this.head.replaceChildren(title)
            if (resolved) {
                this.head.append(
                    button(this.showResolved ? 'Hide resolved' : `Show resolved (${resolved})`, () => {
                        this.showResolved = !this.showResolved
                        this.update()
                    }, 'ezco-mde-comment-link'),
                )
            }
            if (this.switched) this.head.append(glyph(DISMISS_ICON, 'Hide comments panel', () => this.togglePanel(), 'ezco-mde-comment-tool is-close'))
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
                this.draft = new NewComment(this, author)
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
            this.layout_()
        })
    }

    /** Where each card goes. Over the note: under its text, or above it
     *  when there is no room under, never over it when that can be helped,
     *  and never past the note's frame. Beside the note: level with its
     *  text, none overlapping, the one looked at exactly at its text. In a
     *  panel: in the note's order. Every card fits the frame. */
    private layout_() {
        if (this.dom.hidden || !this.view.dom.isConnected) return
        // A column or panel beside the note takes what the note can spare,
        // down to SIDE_MIN; one that would squeeze the note below NOTE_MIN
        // even then floats instead.
        const host = this.view.dom.parentElement
        if (this.layout !== 'float' && host) {
            const available = host.clientWidth + (this.floating ? 0 : this.dom.offsetWidth)
            const floating = available - SIDE_MIN < NOTE_MIN
            if (!floating) this.dom.style.width = `${Math.round(Math.min(SIDE_WIDTH, Math.max(SIDE_MIN, available - NOTE_MIN)))}px`
            else this.dom.style.width = ''
            if (floating !== this.floating) {
                this.floating = floating
                this.place()
                this.headKey = ''
                this.update()
                return
            }
        }
        const state = commentsKey.getState(this.view.state)
        if (!state) return
        const scroller = scrollerOf(this.list)
        const frameHeight = scroller ? scroller.clientHeight : window.innerHeight
        // No card taller than the frame: what is more scrolls inside it. Set
        // before anything is measured, so a card is placed at its real height.
        const maxHeight = this.panel ? '' : `${Math.round(Math.max(160, frameHeight - 2 * GAP))}px`
        const all = [...this.cards.values()].map((c) => c.dom)
        if (this.draft) all.push(this.draft.dom)
        for (const dom of all) {
            dom.style.maxHeight = maxHeight
            const inside = dom.firstElementChild as HTMLElement | null
            dom.classList.toggle('is-capped', !!inside && !this.panel && inside.scrollHeight > inside.clientHeight + 1)
        }
        const box = this.list.getBoundingClientRect()
        const origin = box.top
        const size = this.view.state.doc.content.size
        const coords = (pos: number, side: -1 | 1) => {
            try {
                return this.view.coordsAtPos(Math.min(pos, size), side)
            } catch {
                return null
            }
        }
        type Placed = { id: string; dom: HTMLElement; range: { from: number; to: number } | null; height: number; top: number; fixed: boolean }
        const placed: Placed[] = []
        for (const info of state.comments) {
            const card = this.cards.get(info.id)
            if (!card || card.dom.hidden) continue
            placed.push({ id: info.id, dom: card.dom, range: info.target.whole ? null : info.target.range, height: card.dom.offsetHeight, top: 0, fixed: info.id === state.active && !state.draft })
        }
        if (this.draft && state.draft) placed.push({ id: 'new', dom: this.draft.dom, range: state.draft.ranges[0] ?? null, height: this.draft.dom.offsetHeight, top: 0, fixed: true })

        if (this.panel) {
            // In the note's order, the list scrolling on its own, the one
            // looked at brought into view.
            this.dom.style.setProperty('--ezco-mde-comment-frame', `${Math.round(frameHeight)}px`)
            const at = (p: Placed) => (p.range ? coords(p.range.from, 1)?.top ?? 0 : 0)
            placed.sort((a, b) => at(a) - at(b))
            for (const p of placed) {
                p.dom.style.top = ''
                p.dom.style.left = ''
                p.dom.style.right = ''
                this.list.append(p.dom)
            }
            const active = state.draft ? 'new' : state.active
            if (active && active !== this.scrolledTo) {
                this.scrolledTo = active
                placed.find((p) => p.id === active)?.dom.scrollIntoView({ block: 'nearest' })
            }
            return
        }

        if (this.floating) {
            // Over the note. Each card on its own: under its text when that
            // fits in the frame and the scroll area; above it when that does;
            // else as far up as the frame allows (over its text, rather than
            // cut off). Left at the end of its text, but on the note.
            const frameTop = (scroller ? scroller.getBoundingClientRect().top : 0) - origin
            const frameBottom = frameTop + frameHeight
            const listTop = scroller ? origin - scroller.getBoundingClientRect().top + scroller.scrollTop : origin + window.scrollY
            const limit = Math.min(frameBottom, (scroller ? scroller.scrollHeight : document.documentElement.scrollHeight) - listTop)
            for (const p of placed) {
                const end = p.range ? coords(p.range.to, -1) : null
                const start = p.range ? coords(p.range.from, 1) : null
                const below = end ? end.bottom - origin + GAP : 0
                const above = start ? start.top - origin - GAP - p.height : -1
                if (below + p.height <= limit - GAP) p.top = below
                else if (above >= Math.max(0, frameTop + GAP)) p.top = above
                else p.top = Math.max(frameTop + GAP, Math.min(below, limit - GAP - p.height))
                p.dom.style.top = `${Math.round(p.top)}px`
                if (end) {
                    const width = p.dom.offsetWidth
                    p.dom.style.left = `${Math.round(Math.max(0, Math.min(end.left - box.left - 24, box.width - width)))}px`
                    p.dom.style.right = 'auto'
                } else {
                    p.dom.style.left = ''
                    p.dom.style.right = ''
                }
            }
            this.list.style.minHeight = ''
            return
        }

        // Beside the note: level with its text; the card being looked at
        // (or written) exactly there, the others pushed out of its way.
        for (const p of placed) p.top = p.range ? (coords(p.range.from, 1)?.top ?? origin) - origin : 0
        placed.sort((a, b) => a.top - b.top || Number(b.fixed) - Number(a.fixed))
        const want = placed.map((p) => p.top)
        const pin = placed.findIndex((p) => p.fixed)
        if (pin < 0) {
            let y = 0
            for (const [i, p] of placed.entries()) y = (p.top = Math.max(want[i], y)) + p.height + GAP
        } else {
            placed[pin].top = Math.max(0, want[pin])
            let limit = placed[pin].top - GAP
            for (let i = pin - 1; i >= 0; i--) limit = (placed[i].top = Math.min(want[i], limit - placed[i].height)) - GAP
            const overflow = Math.min(0, ...placed.slice(0, pin + 1).map((p) => p.top))
            if (overflow < 0) for (let i = 0; i <= pin; i++) placed[i].top -= overflow
            let y = placed[pin].top + placed[pin].height + GAP
            for (let i = pin + 1; i < placed.length; i++) y = (placed[i].top = Math.max(want[i], y)) + placed[i].height + GAP
        }
        // Placed with `top`, not a transform: text on a transformed layer
        // renders soft in some engines.
        let bottom = 0
        for (const p of placed) {
            p.dom.style.top = `${Math.round(p.top)}px`
            p.dom.style.left = ''
            p.dom.style.right = ''
            bottom = Math.max(bottom, p.top + p.height)
        }
        this.list.style.minHeight = `${Math.ceil(bottom)}px`
    }

    destroy() {
        if (this.frame) cancelAnimationFrame(this.frame)
        this.observer?.disconnect()
        for (const card of this.cards.values()) card.destroy()
        this.cards.clear()
        this.draft?.destroy()
        if (this.sheet) {
            void this.sheet.save()
            this.sheet.destroy()
            this.sheet = null
        }
        this.storage.sheet = null
        this.storage.open = () => {}
        this.storage.togglePanel = () => false
        this.dom.remove()
        this.column?.remove()
    }
}

export const CommentMargin = Extension.create<CommentMarginOptions, CommentMarginStorage>({
    name: 'commentMargin',

    addOptions() {
        return { mount: undefined, layout: 'float', composer: undefined }
    },

    addStorage() {
        return { open: () => {}, sheet: null, togglePanel: () => false }
    },

    addCommands() {
        return {
            toggleCommentsPanel: () => () => this.storage.togglePanel(),
        }
    },

    addKeyboardShortcuts() {
        return { 'Mod-Shift-m': () => this.editor.commands.toggleCommentsPanel() }
    },

    addProseMirrorPlugins() {
        const editor = this.editor
        const options = this.options
        const storage = this.storage
        return [
            new Plugin({
                key: new PluginKey('commentMargin'),
                view: (view) => {
                    const margin = new Margin(editor, view, options, storage)
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
