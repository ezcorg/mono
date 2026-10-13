/**
 * Where a note's comments are read and answered (comments RFC).
 *
 * By default every comment shows in a panel beside the note, a list that
 * scrolls on its own, when there is room past the note's text column
 * (`layout: 'panel'`); the reader can put it away from its head's menu or
 * ⌘⇧M, and ask for it again from a bubble's menu. With no room beside the note, the
 * panel asked for slides over the note's right edge instead, as the sheet
 * does, and rests at the edge when the pointer leaves it. Otherwise nothing
 * shows beside the note: commented text is marked, and the comment's mark
 * in the annotation column (comment-gutter.ts) opens its comments over the
 * note's edge, under their text (above it when there is no room under),
 * one under the other where they share a line; the mark again, Escape or
 * Close in a card's menu closes it, a click elsewhere in the note closes
 * them all (`layout: 'float'`). Or every comment stands in a column beside
 * the note, each level with its text (`layout: 'column'`; floating after
 * all where the note would be too narrow).
 *
 * A comment is a bubble: who and when, its text as the note shows text (a
 * read-only editor of the note's make, so a fence in a fence shows as the
 * note shows it), and under the text its reactions, React, and the reply
 * count. A chevron in the bubble's corner holds the rest: first the
 * reactions to give (the common and recent ones, and the whole grid behind
 * the last), then the actions in groups: Edit and Reply, Resolve, the
 * composer panel and the file, Delete, the comments panel and Close.
 * Long text folds after a few lines, with the fold to open it. [−] after
 * a byline collapses that message and everything under it to the byline;
 * [+] brings it back. The reply count is the handle of the thread: pressed,
 * its pill grows into a frame around the row and the replies under it,
 * each a bubble of its own, and shrinks back into the pill when they are
 * folded away. A comment's first replies are shown; a reply's own are
 * behind its count. Beside the note, a bubble is the way to its text: a
 * click takes the note there, the text level with the bubble, and in a
 * panel, as the note is read past commented text, that comment's bubble
 * is the current one, stepping out a little from the others (anchored to
 * their text from the head's menu, the bubbles are still, and the head
 * stays at the top of the frame).
 *
 * Writing happens in a bubble: a new comment in a composer over the note
 * by the end of the text it is about, whatever the layout; a reply in a
 * composer right under the comment it answers; an edit in the bubble
 * itself, which keeps its shape and takes the accent while it is written
 * in; the composer's Cancel and its one filled button stand in the
 * bubble's foot. What is typed is a draft,
 * kept in this browser until posted; nothing has to be asked for. A comment
 * written in full goes to the sheet (`comment-sheet.ts`), beside the note,
 * from the composer's menu or ⌘⇧↩.
 */
import { Extension, type AnyExtension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { menuPopover } from '../ui/popover'
import type { FileOperations } from '@joinezco/storage'
import { parseTextFragment, type Reaction, type Wikilink } from '@joinezco/vault'
import { DELETED_BODY, RESOLVED, commentsKey, type CommentInfo, type CommentsStorage } from './comments'
import { Composer } from './comment-composer'
import { clearDraft, draftKey, readDraft, renderReadOnly, when, writeDraft, type ReadOnlyView } from './comment-render'
import { Sheet, frameOver } from './comment-sheet'
import { openReactionPicker, reactionGrid } from './emoji-picker'
import { ContextMenu, isSeparator, type ContextMenuEntry, type ContextMenuItem } from '../ui/context-menu'
import { CHEVRON_DOWN_ICON, CLOSE_ICON, FACE_ICON, FILE_ICON, stroke, svg } from '../ui/icons'
import { readKept, writeKept } from '../ui/kept'
import { settingsOf, type SettingsStorage } from '../settings'
import { resolveMount, scrollerOf, type Mount } from '../ui/layout'
import { persistenceOf } from './filesystem'

export type CommentLayout = 'float' | 'column' | 'panel'

export interface CommentMarginOptions {
    /** Where a column or a panel goes (`createEditor` gives it the column
     *  beside the note; without a mount the margin makes one). */
    mount?: Mount
    /** `panel` (default): every comment in a list beside the note that
     *  scrolls on its own, when there is room beside the note's text
     *  column; `float`: the comment looked at, over the note's edge;
     *  `column`: every comment beside the note, level with its text. A
     *  panel or column floats where there is no room for it. The reader's
     *  choice (the panel shown or put away) is kept over the host's. */
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
    /** Whether the comments float over the note (nothing beside it shows them). */
    floating: () => boolean
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        commentMargin: {
            /** Show every comment in a panel beside the note, or put the panel away. */
            toggleCommentsPanel: () => ReturnType
        }
    }
}

/** The note keeps its text column whole (`--ezco-mde-measure`), and never
 *  less than this, before anything beside it gets room. */
const NOTE_MIN = 400
/** Where the reader's choice of the panel is kept, across notes and sessions. */
const PANEL_KEY = 'ezco-mde-comments-panel'
/** Where the reader's choice of anchoring is kept: comments level with
 *  their text, or a list that scrolls on its own. */
const ANCHORED_KEY = 'ezco-mde-comments-anchored'
/** A column or panel beside the note: this wide, narrower when the note
 *  would otherwise be squeezed, never narrower than the least. */
const SIDE_WIDTH = 360
const SIDE_MIN = 240
const GAP = 8
/** Reactions shown on a comment before the rest fold behind "+n". */
const REACTIONS_SHOWN = 4
/** Where in the frame the note is read: a comment whose text is nearest
 *  this line, from the top, is the current one as the note scrolls. */
const READING = 0.3
/** How far from the reading line, as a share of the frame's height, a
 *  comment's text can be before its card stops stepping out. */
const REACH = 0.5
/** How long after an alignment the scroll is the editor's, not the reader's. */
const QUIET = 1500
/** How long the pointer is gone before the overlaid panel rests at the edge. */
const REST_AFTER = 350
/** How long a thread's frame takes to grow out of its count, or back. */
const MORPH = 220
const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)'
const stillness = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

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
const REACT_ICON = FACE_ICON
/** The replies control's glyph: a speech bubble, the count beside it. */
const REPLIES_ICON = svg(`<path ${stroke} d="M2.5 3.5h11v7H7.5l-3 2.5v-2.5h-2z"/>`)
/** The menu's glyph, in a bubble's corner: a chevron. */
const CHEVRON_ICON = CHEVRON_DOWN_ICON
// The menu's glyphs, one per thing to do.
const REPLY_ICON = svg(`<path ${stroke} d="M6.5 4.5 3 8l3.5 3.5M3 8h6a4 4 0 0 1 4 4v.5"/>`)
const RESOLVE_ICON = svg(`<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path ${stroke} d="m5.5 8 1.8 1.8L10.8 6"/>`)
const REOPEN_ICON = svg(`<path ${stroke} d="M13 8a5 5 0 1 1-1.5-3.6M13 3v2.5h-2.5"/>`)
const EDIT_ICON = svg(`<path ${stroke} d="M3 13h3l7-7-3-3-7 7zM9 4l3 3"/>`)
const SHEET_ICON = svg(`<rect x="2.5" y="3" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path stroke="currentColor" stroke-width="1.5" d="M9.5 3v10"/>`)
const DELETE_ICON = svg(`<path ${stroke} d="M3 4.5h10M6.5 4.5v-1h3v1M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4"/>`)
const PANEL_ICON = svg(`<path ${stroke} d="M3 4.5h10M3 8h10M3 11.5h6"/>`)
/** The head's menu: anchored, comments stand level with their text. */
const ANCHOR_ICON = svg(`<path ${stroke} d="M2.5 8h3M10.5 8h3"/><circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/>`)
const RESOLVED_ICON = RESOLVE_ICON

/** The words for the two ways to write at length. */
const SHEET_LABEL = 'Composer panel'
const FILE_LABEL = 'Open as file'
const SEPARATOR: ContextMenuEntry = { type: 'separator' }

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

/** The layout the reader chose over the host's, if they did (kept in this
 *  browser; an editor with settings keeps the choice there instead). */
function keptLayout(): CommentLayout | null {
    const kept = readKept(PANEL_KEY)
    return kept === 'panel' || kept === 'float' || kept === 'column' ? kept : null
}

const keepLayout = (layout: CommentLayout | null) => writeKept(PANEL_KEY, layout)

/** Whether the reader chose comments anchored to their text, if they did. */
function keptAnchored(): boolean | null {
    const kept = readKept(ANCHORED_KEY)
    return kept === '1' ? true : kept === '0' ? false : null
}

const keepAnchored = (anchored: boolean) => writeKept(ANCHORED_KEY, anchored ? '1' : '0')

/**
 * A menu of `items` under `anchor`, in the chrome's menu look, gone on a
 * choice, Escape, or a click elsewhere; `onClose` hears when it is.
 */
function openMenu(anchor: HTMLElement, items: ContextMenuEntry[], onClose: () => void, before?: HTMLElement): () => void {
    const close = () => popup.hide()
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
        onClose: close,
    })
    if (before) menu.dom.prepend(before)
    const popup = menuPopover(anchor, menu, {
        placement: 'bottom-end',
        flip: ['top-end', 'bottom-start', 'top-start'],
        onHide: onClose,
    })
    return close
}

/** The chevron in a bubble's corner, with `items` behind it (and `before`
 *  them, when given, the reactions to give). */
function chevron(items: () => ContextMenuEntry[], holder: { menu: (() => void) | null }, before?: (close: () => void, anchor: HTMLElement) => HTMLElement): HTMLButtonElement {
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
        }, before?.(close, b))
    }, 'ezco-mde-comment-menu-button')
    more.setAttribute('aria-haspopup', 'menu')
    more.setAttribute('aria-expanded', 'false')
    return more
}

/** A bubble's foot holding `controls` in its row: where a comment's
 *  reactions and count stand, a composer's Cancel and its one filled
 *  button stand too, so the bubble is whole. */
function footWith(...controls: Node[]): HTMLElement {
    const foot = el('div', 'ezco-mde-comment-foot')
    const row = el('div', 'ezco-mde-comment-foot-row')
    row.append(...controls)
    foot.append(row)
    return foot
}

/**
 * A composer as a bubble of its own: who is writing over the field, a
 * chevron with the way to the sheet, and the composer's buttons in the
 * bubble's foot. A reply right under the comment it answers, and a new
 * comment.
 */
function composerBlock(composer: Composer, author: string, items: () => ContextMenuEntry[], holder: { menu: (() => void) | null }): HTMLElement {
    const box = el('div', 'ezco-mde-comment-message is-composer')
    const bubble = el('div', 'ezco-mde-comment-bubble is-editing')
    const head = el('div', 'ezco-mde-comment-head')
    head.append(el('span', 'ezco-mde-comment-author', `@${author}`), chevron(items, holder))
    const content = el('div', 'ezco-mde-comment-content is-editing')
    content.append(composer.field)
    bubble.append(head, content, footWith(composer.actions))
    box.append(bubble)
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
    /** The messages whose thread is shown, by the last render and by this
     *  one: a thread shown now that was not grows out of its count. */
    private shown = new Set<string>()
    private folds = new Set<string>()
    /** The feet whose thread opened in this render, to grow. */
    private openings: HTMLElement[] = []
    /** Drawn once already: a thread open from the start does not grow. */
    private drawn = false
    /** The menu open, if one is. */
    readonly holder: { menu: (() => void) | null } = { menu: null }
    /** The read-only views showing the texts, gone with the next render. */
    private views: ReadOnlyView[] = []
    /** Watches the texts for growth, to fold them again. */
    private readonly sizes: ResizeObserver | null = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.clamp())
    private key = ''
    /** How near the note's reading line is to the text, 0 to 1 (the card
     *  steps out by it). */
    private near = ''
    /** A press on the comment's text, until it is released. */
    private pressed: { x: number; y: number; at: number } | null = null
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
        // click on it (or Enter) takes the note to the comment's text as well.
        this.dom.addEventListener('mousedown', (e) => {
            const target = e.target as HTMLElement
            if (target.closest('a, button, [data-wikilink], .ezco-mde-comment-input')) return
            this.lookAt()
            if (this.margin.floating) return
            // On the text itself, the note goes there on release, unless the
            // press turns out to be a drag that selects some of it. (Not on
            // `click`: looking at the comment draws the card again, so the
            // element pressed is gone by the release and no click is made.)
            if (target.closest('.ezco-mde-readonly')) this.pressed = { x: e.clientX, y: e.clientY, at: Date.now() }
            else this.margin.goTo(this.id)
        })
        this.dom.addEventListener('mouseup', (e) => {
            const pressed = this.pressed
            this.pressed = null
            if (!pressed || this.margin.floating) return
            const target = e.target as HTMLElement
            if (target.closest('a, button, [data-wikilink]') || Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > 4 || Date.now() - pressed.at > 600) return
            const selection = window.getSelection()
            if (selection && !selection.isCollapsed && this.dom.contains(selection.anchorNode)) return
            this.margin.goTo(this.id)
        })
        this.dom.addEventListener('focusin', () => this.lookAt())
        this.dom.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target === this.dom && !this.margin.floating) {
                e.preventDefault()
                this.margin.goTo(this.id)
                return
            }
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
            this.margin.close(this.margin.floating ? this.id : undefined)
        })
    }

    private lookAt() {
        if (this.margin.active() !== this.id) this.margin.editor.commands.focusComment(this.id)
    }

    /** Beside the note, the card steps out from the others by how near the
     *  reading line is to its text: all the way when it is looked at. */
    setNear(near: number) {
        const value = near.toFixed(3)
        if (value === this.near) return
        this.near = value
        this.dom.style.setProperty('--ezco-mde-comment-near', value)
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
            this.margin.panel,
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
        this.sizes?.disconnect()

        const context: Node[] = []
        if (info.target.orphaned) {
            const orphan = el('div', 'ezco-mde-comment-orphan')
            orphan.append(el('span', 'ezco-mde-comment-quote', quoteOf(info.target.link.fragment)), el('span', undefined, ' is no longer in the note.'))
            if (author) orphan.append(button('Anchor to selection', () => editor.commands.anchorComment(this.id), 'ezco-mde-comment-link', 'Point this at the selected text instead'))
            context.push(orphan)
        }
        this.context.replaceChildren(...context)
        this.context.hidden = !context.length

        this.shown = this.folds
        this.folds = new Set()
        this.openings = []
        this.messages.replaceChildren(this.message(info, 0, author))
        // A thread opened by this render grows out of its count, once the
        // card has been seen as it was (not one open from the start).
        if (this.drawn) for (const foot of this.openings) this.grow(foot)
        this.drawn = true
        this.openings = []
        requestAnimationFrame(() => this.clamp())
        // A text grows after it is shown (a quoted passage arrives once its
        // document is read): the fold is measured again.
        if (this.sizes) for (const view of this.views) this.sizes.observe(view.dom)
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
     *  text; under it its reactions, React and the reply count, and the
     *  thread the count opens, the reply being written to it last. While
     *  the text is edited, or its deletion asked about, the foot holds the
     *  composer's buttons, or the question, instead. */
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
        const items = () => (editing ? this.sheetItems(c) : this.menuFor(c, depth, author, mine, deleted))
        const mineReactions = () => new Set(c.reactions.filter((r) => r.by === me).map((r) => r.emoji))
        const reactions = me && !editing && !deleted ? (close: () => void, anchor: HTMLElement) => reactionGrid({ mine: mineReactions(), anchor, close, onPick: (emoji) => editor.commands.reactToComment(c.id, emoji) }) : undefined
        if (items().length || reactions) head.append(chevron(items, this.holder, reactions))
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

        // In the bubble, under the text: the reactions, React at their
        // right, and the reply count at the row's end, the handle of the
        // thread. The thread it opens (this message's replies, each a
        // message of its own, and last the reply being written) stands
        // under the row, in a frame grown out of the count.
        if (!editing && this.confirming !== c.id) {
            const foot = el('div', 'ezco-mde-comment-foot')
            const row = el('div', 'ezco-mde-comment-foot-row')
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
            // React: the common and recent reactions by the control, the
            // whole grid behind them.
            if (me && !deleted) row.append(glyph(REACT_ICON, 'React', (b) => openReactionPicker(b, (emoji) => editor.commands.reactToComment(c.id, emoji), mineReactions()), 'ezco-mde-comment-action is-icon is-react'))
            // The reply count: it shows or hides the replies right under
            // this message (a reply's own answers stay behind their own
            // count); with nothing to show, it starts the first reply.
            const n = c.replies.length
            const open = this.threadOpen(c, depth)
            const replying = this.replying?.id === c.id
            const opened = open && (n > 0 || replying)
            const replies = button(String(n), () => {
                if (!n && !replying) {
                    if (author) this.reply(c)
                    return
                }
                if (opened) this.closeThread(c.id, foot)
                else {
                    this.threads.set(c.id, true)
                    this.render()
                }
            }, 'ezco-mde-comment-action is-replies', n ? (opened ? 'Hide replies' : `Show ${plural(n, 'reply')}`) : author ? 'Reply' : 'No replies')
            replies.insertAdjacentHTML('afterbegin', REPLIES_ICON)
            replies.insertAdjacentHTML('beforeend', `<span class="ezco-mde-comment-replies-caret">${CHEVRON_ICON}</span>`)
            replies.setAttribute('aria-expanded', String(opened))
            replies.disabled = !n && !author
            row.append(replies)
            foot.append(row)
            if (opened) {
                foot.classList.add('is-open')
                const thread = el('div', 'ezco-mde-comment-thread')
                for (const r of c.replies) thread.append(this.message(r, depth + 1, author))
                if (replying && author) {
                    const composer = this.replying!.composer
                    thread.append(composerBlock(composer, author, () => this.longForms(() => this.replyInFull(c, true), () => this.replyInFull(c, 'note')), this.holder))
                }
                foot.append(thread, el('div', 'ezco-mde-comment-thread-frame'))
                this.folds.add(c.id)
                if (!this.shown.has(c.id)) this.openings.push(foot)
            }
            bubble.append(foot)
        }

        // In the foot instead: the composer's buttons while the text is
        // edited, or a deletion asked about.
        if (editing) {
            bubble.append(footWith(this.editing!.composer.actions))
        } else if (this.confirming === c.id) {
            const foot = footWith(
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
            foot.classList.add('is-confirming')
            bubble.append(foot)
        }
        return box
    }

    /** The parts of a thread's foot that move: its count, its frame, its thread. */
    private partsOf(foot: HTMLElement) {
        return {
            pill: foot.querySelector<HTMLElement>(':scope > .ezco-mde-comment-foot-row > .is-replies'),
            row: foot.querySelector<HTMLElement>(':scope > .ezco-mde-comment-foot-row'),
            frame: foot.querySelector<HTMLElement>(':scope > .ezco-mde-comment-thread-frame'),
            thread: foot.querySelector<HTMLElement>(':scope > .ezco-mde-comment-thread'),
        }
    }

    /** The thread under `foot` just opened: its frame grows out of the
     *  count's pill to stand around the row and the replies, which come
     *  in as it does; the foot takes its height as the frame grows. */
    private grow(foot: HTMLElement) {
        const { pill, row, frame, thread } = this.partsOf(foot)
        if (!pill || !row || !frame || !thread || stillness() || typeof foot.animate !== 'function') return
        const box = foot.getBoundingClientRect()
        const from = pill.getBoundingClientRect()
        if (!box.height || !from.height) return
        foot.classList.add('is-moving')
        const closed = box.height - thread.getBoundingClientRect().height
        const timing = { duration: MORPH, easing: EASE }
        const moving = [
            foot.animate([{ height: `${closed}px` }, { height: `${box.height}px` }], timing),
            frame.animate(
                [
                    { left: `${from.left - box.left}px`, top: `${from.top - box.top}px`, width: `${from.width}px`, height: `${from.height}px`, borderRadius: '999px' },
                    { left: '0px', top: '0px', width: `${box.width}px`, height: `${box.height}px`, borderRadius: '10px' },
                ],
                timing,
            ),
            thread.animate([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], timing),
        ]
        Promise.all(moving.map((a) => a.finished.catch(() => undefined))).then(() => foot.classList.remove('is-moving'))
        this.margin.schedule()
    }

    /** Hide the thread under `id`: its frame shrinks back into the count,
     *  the replies going as it does; then they are gone. */
    private closeThread(id: string, foot: HTMLElement) {
        let done = false
        const finish = () => {
            if (done) return
            done = true
            this.threads.set(id, false)
            this.render()
        }
        const { pill, row, frame, thread } = this.partsOf(foot)
        if (!pill || !row || !frame || !thread || stillness() || typeof foot.animate !== 'function') return finish()
        const box = foot.getBoundingClientRect()
        const to = pill.getBoundingClientRect()
        if (!box.height || !to.height) return finish()
        foot.classList.add('is-moving')
        const closed = box.height - thread.getBoundingClientRect().height
        const timing = { duration: MORPH, easing: EASE, fill: 'forwards' as const }
        const moving = [
            foot.animate([{ height: `${box.height}px` }, { height: `${closed}px` }], timing),
            frame.animate(
                [
                    { left: '0px', top: '0px', width: `${box.width}px`, height: `${box.height}px`, borderRadius: '10px' },
                    { left: `${to.left - box.left}px`, top: `${to.top - box.top}px`, width: `${to.width}px`, height: `${to.height}px`, borderRadius: '999px' },
                ],
                timing,
            ),
            thread.animate([{ opacity: 1 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }], timing),
        ]
        pill.setAttribute('aria-expanded', 'false')
        Promise.all(moving.map((a) => a.finished.catch(() => undefined))).then(finish)
        setTimeout(finish, MORPH * 2)
    }

    /** What the chevron offers for `c`, in groups: to answer or change it
     *  (Edit first for one's own, Reply first for another's); to settle it;
     *  the long ways (the composer panel for one's own only); to delete it;
     *  the panel and Close (the bubble put away; not Resolve). */
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
            if (!this.margin.floating) last.push({ label: 'Hide comments panel', icon: PANEL_ICON, onSelect: () => this.margin.togglePanel() })
            else last.push({ label: 'Show in comments panel', icon: PANEL_ICON, onSelect: () => this.margin.togglePanel() })
            if (this.margin.floating) last.push({ label: 'Close', icon: CLOSE_ICON, onSelect: () => this.margin.close(this.id) })
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
        // The reply is written in the thread, so the thread shows.
        this.threads.set(c.id, true)
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
        this.sizes?.disconnect()
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
    /** Over the note: the composer for a new comment, by its text, in
     *  every layout. */
    private readonly over: HTMLElement
    private readonly cards = new Map<string, Card>()
    private draft: NewComment | null = null
    private sheet: Sheet | null = null
    private showResolved = false
    /** How comments are shown now: the host's choice, or the reader's. */
    private layout: CommentLayout
    /** A column the margin made for itself (the host gave none). */
    private column: HTMLElement | null = null
    /** Comments float over the note's edge (the layout, or a column that
     *  would not fit). */
    floating: boolean
    /** The panel over the note's right edge: asked for, with no room beside
     *  the note. */
    overlay = false
    /** The reader asked for the panel (not the host, not a kept choice):
     *  with no room beside the note, it goes over the note's edge rather
     *  than nowhere. */
    private wanted = false
    /** Comments level with their text, scrolling with the note (a column),
     *  rather than a list beside it that scrolls on its own (a panel). */
    private anchored: boolean
    /** The reader's settings, when the editor has them: where the panel's
     *  choices (shown, anchored, the resolved ones) are kept, and read. */
    private readonly settings: SettingsStorage | null
    private unsubscribe: (() => void) | null = null
    /** The head's menu, while open. */
    private readonly holder: { menu: (() => void) | null } = { menu: null }
    /** The overlay's frame on the page, and its handle at the edge. */
    private clip: HTMLElement | null = null
    private handle: HTMLButtonElement | null = null
    private restTimer = 0
    /** A panel: a list beside the note (or over its edge) that scrolls on its own. */
    get panel() {
        return this.layout === 'panel' && !this.floating
    }
    /** The comment the reader is at: the one looked at, or, as the note
     *  scrolls, the one whose text is nearest the reading line. */
    private current: string | null = null
    private lastActive: string | null = null
    /** Until when the scroll is the editor's (an alignment), not the reader's. */
    private quietUntil = 0
    private spyFrame = 0
    private scrollTarget: EventTarget | null = null
    private readonly onScroll = () => {
        if (this.spyFrame) return
        this.spyFrame = requestAnimationFrame(() => {
            this.spyFrame = 0
            this.spy()
        })
    }
    /** The host's layout: the panel, unless it said otherwise. */
    private get base(): CommentLayout {
        return this.options.layout ?? 'panel'
    }
    /** The reader chose over the host's layout. */
    get switched() {
        return this.layout !== this.base
    }
    /** What the note keeps for itself: its column at its measure. */
    private noteMin(): number {
        const host = this.view.dom.parentElement
        const measure = parseFloat(getComputedStyle(host ?? this.view.dom).maxWidth)
        return Number.isFinite(measure) ? Math.max(NOTE_MIN, measure) : NOTE_MIN
    }
    /** The room for the note's column and a column or panel beside it:
     *  what is left of the row once the rail and the gutter have theirs. */
    private room(): number {
        const host = this.view.dom.parentElement
        if (!host) return 0
        const row = host.parentElement
        if (!row?.classList.contains('ezco-mde-content')) return host.clientWidth + (this.floating || this.overlay ? 0 : this.dom.offsetWidth)
        let taken = 0
        for (const child of row.children) {
            if (child === host || child === this.column || child.contains(this.dom)) continue
            taken += (child as HTMLElement).offsetWidth
        }
        return row.clientWidth - taken
    }
    /** Whether there is room beside the note for a column or panel. */
    fits(): boolean {
        return this.room() - SIDE_MIN >= this.noteMin()
    }
    /** How the layout is shown now: beside the note at this width, or over
     *  its edge (a panel), or floating (a column). */
    private decide(): { floating: boolean; overlay: boolean; width: string } {
        if (this.layout === 'float') return { floating: true, overlay: false, width: '' }
        const room = this.room()
        const noteMin = this.noteMin()
        if (room - SIDE_MIN >= noteMin) return { floating: false, overlay: false, width: `${Math.round(Math.min(SIDE_WIDTH, Math.max(SIDE_MIN, room - noteMin)))}px` }
        return this.layout === 'panel' && this.wanted ? { floating: false, overlay: true, width: '' } : { floating: true, overlay: false, width: '' }
    }
    private frame = 0
    private headKey = ''
    /** The comment the panel last scrolled to. */
    private scrolledTo: string | null = null
    /** Each floating card's height as last laid out: one that grew is
     *  brought into view again. */
    private readonly heights = new Map<string, number>()
    /** How much the note's end has been extended, so a card under the
     *  last lines could be scrolled into view. */
    private grown = 0
    private readonly observer: ResizeObserver | null
    private extensions: AnyExtension[] | null = null

    constructor(
        readonly editor: Editor,
        readonly view: EditorView,
        private readonly options: CommentMarginOptions,
        private readonly storage: CommentMarginStorage,
    ) {
        this.settings = settingsOf(editor)
        this.anchored = this.settings?.chosen('comments.anchored') ?? keptAnchored() ?? this.base === 'column'
        const panel = this.settings?.chosen('comments.panel')
        const kept = panel === undefined ? keptLayout() : panel ? this.shownKind() : 'float'
        this.layout = kept === 'float' ? 'float' : kept || this.base !== 'float' ? this.shownKind() : 'float'
        this.wanted = panel === true
        this.floating = this.layout === 'float'
        this.showResolved = this.settings?.get('comments.showResolved') ?? false
        this.dom = el('section', 'ezco-mde-comment-margin')
        this.dom.setAttribute('aria-label', 'Comments')
        this.head = el('header', 'ezco-mde-comment-margin-head')
        this.list = el('div', 'ezco-mde-comment-list')
        this.dom.append(this.head, this.list)
        this.over = el('div', 'ezco-mde-comment-over')
        this.over.hidden = true
        view.dom.after(this.over)
        this.place()
        this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.schedule())
        this.observer?.observe(view.dom)
        if (view.dom.parentElement) this.observer?.observe(view.dom.parentElement)
        storage.open = (path) => this.openSheet(path)
        storage.sheet = null
        storage.togglePanel = () => this.togglePanel()
        storage.floating = () => this.floating
        this.step()
        this.unsubscribe = this.settings?.subscribe(() => this.settingsChanged()) ?? null
        this.update()
    }

    /** How far a card steps out, from the settings. */
    private step() {
        const px = this.settings?.get('comments.step')
        this.dom.style.setProperty('--ezco-mde-comment-step', px === undefined ? '' : `${px}px`)
    }

    /** The settings changed (a file edited, the toolbar, another editor):
     *  what the panel shows follows them. */
    private settingsChanged() {
        const settings = this.settings
        if (!settings) return
        this.step()
        let changed = false
        const anchored = settings.chosen('comments.anchored') ?? this.base === 'column'
        if (anchored !== this.anchored) {
            this.anchored = anchored
            changed = true
        }
        const panel = settings.chosen('comments.panel')
        const layout: CommentLayout = panel === false ? 'float' : panel === true || this.layout !== 'float' ? this.shownKind() : 'float'
        if (layout !== this.layout) {
            this.layout = layout
            this.wanted = layout !== 'float'
            changed = true
        }
        const showResolved = settings.get('comments.showResolved')
        if (showResolved !== this.showResolved) {
            this.showResolved = showResolved
            this.headKey = ''
            changed = true
        }
        if (changed) this.relayout()
    }

    /** The panel's choices, kept: in the settings when the editor has
     *  them, else in this browser. */
    private keep() {
        if (this.settings) {
            void this.settings.set('comments.panel', this.layout !== 'float')
            void this.settings.set('comments.anchored', this.anchored)
        } else {
            keepLayout(this.switched ? this.layout : null)
            keepAnchored(this.anchored)
        }
    }

    /** The margin where its layout puts it: over the note, beside it, or
     *  over its edge. */
    private place() {
        if (this.overlay) {
            this.placeOver()
            return
        }
        this.unplaceOver()
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
        let host = resolveMount(this.options.mount, root)
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

    /** The panel over the note's right edge, in a frame the size of the
     *  note's own that clips it as it slides in; its own `.ezco-mde`, so
     *  the theme's variables reach it on the page. */
    private placeOver() {
        if (this.clip) return
        const root = (this.view.dom.closest('.ezco-mde') as HTMLElement | null) ?? this.view.dom
        this.clip = el('div', 'ezco-mde-comment-overlay-frame')
        this.dom.classList.add('ezco-mde', 'is-entering')
        const theme = root.closest('[data-theme]')?.getAttribute('data-theme')
        if (theme) this.dom.dataset.theme = theme
        this.handle = el('button', 'ezco-mde-comment-sheet-handle')
        this.handle.type = 'button'
        this.handle.title = 'Show the comments'
        this.handle.setAttribute('aria-label', 'Show the comments')
        this.handle.append(el('span', 'ezco-mde-comment-sheet-handle-label', 'Comments'))
        this.handle.addEventListener('mousedown', (e) => e.preventDefault())
        this.handle.addEventListener('click', () => this.wake())
        this.dom.prepend(this.handle)
        this.dom.addEventListener('pointerenter', this.wake)
        this.dom.addEventListener('pointerleave', this.rest)
        this.dom.addEventListener('focusin', this.wake)
        this.dom.addEventListener('focusout', this.restIfLeft)
        this.clip.append(this.dom)
        document.body.append(this.clip)
        window.addEventListener('scroll', this.schedule, true)
        window.addEventListener('resize', this.schedule)
        if (this.column) {
            this.column.remove()
            this.column = null
        }
        this.fit()
        // In from the edge: laid out at the edge first, then let in.
        requestAnimationFrame(() => requestAnimationFrame(() => this.dom.classList.remove('is-entering')))
    }

    private unplaceOver() {
        if (!this.clip) return
        clearTimeout(this.restTimer)
        this.dom.removeEventListener('pointerenter', this.wake)
        this.dom.removeEventListener('pointerleave', this.rest)
        this.dom.removeEventListener('focusin', this.wake)
        this.dom.removeEventListener('focusout', this.restIfLeft)
        window.removeEventListener('scroll', this.schedule, true)
        window.removeEventListener('resize', this.schedule)
        this.handle?.remove()
        this.handle = null
        this.dom.classList.remove('ezco-mde', 'is-entering', 'is-away')
        delete this.dom.dataset.theme
        this.dom.remove()
        this.clip.remove()
        this.clip = null
    }

    /** The overlay's frame over the note's frame, the panel at its right edge. */
    private fit() {
        if (!this.clip) return
        const root = (this.view.dom.closest('.ezco-mde') as HTMLElement | null) ?? this.view.dom
        const { width } = frameOver(this.clip, root)
        this.dom.style.width = `${Math.round(Math.min(width, Math.max(SIDE_MIN, Math.min(SIDE_WIDTH, width * 0.85))))}px`
    }

    private readonly wake = () => {
        clearTimeout(this.restTimer)
        this.dom.classList.remove('is-away')
    }

    private readonly rest = () => {
        clearTimeout(this.restTimer)
        this.restTimer = window.setTimeout(() => {
            if (this.overlay && !this.dom.matches(':hover') && !this.dom.contains(document.activeElement)) this.dom.classList.add('is-away')
        }, REST_AFTER)
    }

    private readonly restIfLeft = (e: FocusEvent) => {
        if (!this.dom.contains(e.relatedTarget as Node | null) && !this.dom.matches(':hover')) this.rest()
    }

    /** How comments are shown when shown beside the note: anchored to
     *  their text, or a list of their own. */
    private shownKind(): CommentLayout {
        return this.anchored ? 'column' : 'panel'
    }

    /** Every comment beside the note, or put away; the choice kept. */
    togglePanel(): boolean {
        // Shown beside the note (or over its edge): put away; else (floating,
        // whatever the layout, for want of room): beside the note. Decided
        // afresh: what is shown may not have been laid out yet.
        const shown = this.layout !== 'float' && !this.decide().floating
        this.layout = shown ? 'float' : this.shownKind()
        this.wanted = !shown
        this.keep()
        this.relayout()
        return true
    }

    /** Comments level with their text, or a list that scrolls on its own;
     *  the choice kept. */
    toggleAnchored(): boolean {
        this.anchored = !this.anchored
        if (this.layout !== 'float') this.layout = this.shownKind()
        this.keep()
        if (this.layout === 'float') return true
        this.relayout()
        return true
    }

    /** The layout changed: placed and drawn again. */
    private relayout() {
        const { floating, overlay, width } = this.decide()
        this.floating = floating
        this.overlay = overlay
        this.dom.style.width = width
        this.scrolledTo = null
        this.place()
        this.headKey = ''
        this.update()
    }

    /** What the head's chevron offers: the settings as switches (anchoring,
     *  the resolved comments), and the way to put the panel away. */
    private headItems(resolved: number): ContextMenuEntry[] {
        return [
            { label: 'Anchor comments to text', icon: ANCHOR_ICON, checked: this.anchored, onSelect: () => this.toggleAnchored() },
            SEPARATOR,
            {
                label: `Show resolved (${resolved})`,
                icon: RESOLVED_ICON,
                checked: this.showResolved,
                disabled: !resolved && !this.showResolved,
                onSelect: () => {
                    this.showResolved = !this.showResolved
                    void this.settings?.set('comments.showResolved', this.showResolved)
                    this.headKey = ''
                    this.update()
                },
            },
            SEPARATOR,
            { label: 'Hide comments panel', icon: CLOSE_ICON, onSelect: () => this.togglePanel() },
        ]
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

    /** Take the note to the text of comment `id`: level with its bubble in
     *  a panel; in view beside a column (whose cards stand level with their
     *  text already). */
    goTo(id: string) {
        if (this.panel) this.align(id)
        else this.reveal(id)
    }

    /** Scroll the note so that the text of comment `id` starts level with
     *  the top of its bubble: what is read and what is said about it on one
     *  line. The panel beside the note scrolls with it until it sticks at
     *  the top of the frame (over the note's edge it stays put), which the
     *  scroll allows for; what the note cannot do (its end reached, or the
     *  panel moving with it), the list does, the bubble brought to the text
     *  instead. */
    private align(id: string) {
        const card = this.cards.get(id)
        const range = commentsKey.getState(this.view.state)?.comments.find((c) => c.id === id)?.target.range
        if (!card || !range) return
        this.scrolledTo = id
        this.setCurrent(id)
        const bubble = card.dom.querySelector<HTMLElement>('.ezco-mde-comment-bubble.is-anchor') ?? card.dom
        let text: number
        try {
            text = this.view.coordsAtPos(range.from, 1).top
        } catch {
            return
        }
        const scroller = scrollerOf(this.view.dom)
        const frameTop = scroller ? scroller.getBoundingClientRect().top : 0
        const now = scroller ? scroller.scrollTop : window.scrollY
        const most = scroller ? scroller.scrollHeight - scroller.clientHeight : document.documentElement.scrollHeight - window.innerHeight
        const panelTop = this.dom.getBoundingClientRect().top
        const columnTop = this.overlay ? panelTop : (this.dom.parentElement?.getBoundingClientRect().top ?? panelTop)
        const inPanel = bubble.getBoundingClientRect().top - panelTop
        // Where the panel's top is once the note is scrolled to `s`: where
        // its column puts it, or stuck at the frame's top.
        const panelAt = (s: number) => (this.overlay ? panelTop : Math.max(frameTop, columnTop + now - s))
        const to = Math.max(0, Math.min(most, text + now - frameTop - inPanel))
        this.quietUntil = Date.now() + QUIET
        if (to !== now) {
            if (scroller) scroller.scrollTo({ top: to, behavior: 'smooth' })
            else window.scrollTo({ top: to, behavior: 'smooth' })
        }
        const left = text + now - to - (panelAt(to) + inPanel)
        if (Math.abs(left) > 1) this.list.scrollTo({ top: Math.max(0, this.list.scrollTop - left), behavior: 'smooth' })
    }

    /** As the note scrolls, in a panel: every card steps out by how near
     *  the reading line is to its text (by that alone: a click on a card
     *  takes the note to its text, and the scroll does the rest), and the
     *  comment whose text is nearest the line, among those in view, is the
     *  current one (not while the scroll is the editor's own: an
     *  alignment). Anchored to their text, the cards are still. */
    private spy() {
        if (!this.panel || this.dom.hidden || !this.view.dom.isConnected) return
        const state = commentsKey.getState(this.view.state)
        if (!state) return
        const scroller = scrollerOf(this.view.dom)
        const frameTop = scroller ? scroller.getBoundingClientRect().top : 0
        const frameHeight = scroller ? scroller.clientHeight : window.innerHeight
        const line = frameTop + frameHeight * READING
        const reach = Math.max(1, frameHeight * REACH)
        let best: { id: string; away: number } | null = null
        for (const c of state.comments) {
            const card = this.cards.get(c.id)
            const range = c.target.whole ? null : c.target.range
            if (!card || card.dom.hidden) continue
            let near = 0
            if (range) {
                let top: number
                let bottom: number
                try {
                    top = this.view.coordsAtPos(range.from, 1).top
                    bottom = this.view.coordsAtPos(range.to, -1).bottom
                } catch {
                    continue
                }
                const away = Math.abs(top - line)
                near = Math.max(0, 1 - away / reach)
                if (!(bottom < frameTop || top > frameTop + frameHeight) && (!best || away < best.away)) best = { id: c.id, away }
            }
            card.setNear(near)
        }
        if (best && Date.now() >= this.quietUntil) this.setCurrent(best.id)
    }

    /** Mark comment `id` the current one, and keep its card in view in a panel. */
    private setCurrent(id: string | null) {
        if (id === this.current) return
        this.current = id
        for (const [cid, card] of this.cards) card.dom.classList.toggle('is-current', cid === id)
        const card = id ? this.cards.get(id) : null
        if (card && this.panel) this.keepInView(card.dom)
    }

    /** The card being looked at (or written), when it is newly shown or has
     *  grown, brought into the frame: the note scrolled down by what the
     *  frame cannot show of the card, its end extended first when the note
     *  cannot scroll that far (a card under the last lines). The card stays
     *  under its text. */
    private keepFloatingInView(cards: { id: string; dom: HTMLElement; height: number }[], scroller: HTMLElement | null) {
        const frame = scroller ? scroller.getBoundingClientRect() : new DOMRect(0, 0, window.innerWidth, window.innerHeight)
        for (const card of cards) {
            const was = this.heights.get(card.id)
            this.heights.set(card.id, card.height)
            if (was !== undefined && card.height <= was) continue
            const bottom = card.dom.getBoundingClientRect().bottom + GAP
            const over = bottom - frame.bottom
            if (over <= 0) continue
            const now = scroller ? scroller.scrollTop : window.scrollY
            // The note's end must reach the card's bottom for the scroll to:
            // what it falls short by is added to it. (Not the scroll range:
            // the card, floating past the end, is in that range already.)
            const host = this.view.dom.parentElement
            const end = host ? host.getBoundingClientRect().bottom : frame.bottom
            if (bottom > end) this.grow(bottom - end)
            this.quietUntil = Date.now() + QUIET
            if (scroller) scroller.scrollTo({ top: now + over, behavior: 'smooth' })
            else window.scrollTo({ top: now + over, behavior: 'smooth' })
        }
    }

    /** Room under the note's last lines, by `px` more; laid out at once,
     *  so a scroll asked for next can reach it (a smooth scroll is held to
     *  the range as it was when asked for). */
    private grow(px: number) {
        const host = this.view.dom.parentElement
        if (!host) return
        this.grown += px
        host.style.paddingBottom = `${Math.ceil(this.grown)}px`
        void host.offsetHeight
    }

    /** The note's end as it was: nothing floats over it any more. */
    private ungrow() {
        this.heights.clear()
        if (!this.grown) return
        this.grown = 0
        const host = this.view.dom.parentElement
        if (host) host.style.paddingBottom = ''
    }

    /** `dom` in view in the panel's list: the list scrolled, never the note
     *  (`scrollIntoView` would scroll the note too, and undo an alignment
     *  under way). */
    private keepInView(dom: HTMLElement) {
        const list = this.list.getBoundingClientRect()
        const box = dom.getBoundingClientRect()
        if (box.top < list.top) this.list.scrollTo({ top: this.list.scrollTop + (box.top - list.top) - GAP, behavior: 'smooth' })
        else if (box.bottom > list.bottom) this.list.scrollTo({ top: this.list.scrollTop + (box.bottom - list.bottom) + GAP, behavior: 'smooth' })
    }

    /** Hear the note's scroll (its scroller may be mounted after the margin). */
    private listen() {
        const target: EventTarget = scrollerOf(this.view.dom) ?? window
        if (target === this.scrollTarget) return
        this.scrollTarget?.removeEventListener('scroll', this.onScroll)
        this.scrollTarget = target
        target.addEventListener('scroll', this.onScroll, { passive: true })
    }

    /** Done looking: the card closed (`id`, over the note), or every one;
     *  the caret back in the note when none is left. */
    close(id?: string) {
        if (id) this.editor.commands.toggleComments([id])
        else this.editor.commands.focusComment(null)
        if (!this.comments.open().length) this.editor.commands.focus()
    }

    /** The open note's path (drafts are kept per note). */
    notePath(): string | null {
        return persistenceOf(this.editor)?.options.filepath ?? null
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
        const fs = persistenceOf(this.editor)?.options.fs
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
                else void persistenceOf(this.editor)?.loadFile(path)
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
        // The composer for a new comment: over the note, by its text,
        // whatever the layout.
        const author = this.author()
        if (state.draft && author) {
            if (!this.draft) {
                this.draft = new NewComment(this, author)
                this.over.append(this.draft.dom)
                this.observer?.observe(this.draft.dom)
            }
        } else if (this.draft) {
            this.observer?.unobserve(this.draft.dom)
            this.draft.destroy()
            this.draft = null
            this.heights.delete('new')
        }
        this.over.hidden = !this.draft
        const resolved = state.comments.filter((c) => c.resolved).length
        const visible = this.floating
            ? state.comments.filter((c) => state.open.includes(c.id))
            : state.comments.filter((c) => !c.resolved || this.showResolved || c.id === state.active)
        this.dom.hidden = this.floating ? !state.open.length : !state.comments.length
        if ((!this.floating || this.dom.hidden) && !this.draft) this.ungrow()
        this.dom.classList.toggle('is-floating', this.floating)
        this.dom.classList.toggle('is-panel', this.panel)
        this.dom.classList.toggle('is-overlay', this.overlay)

        // The head beside the note: how many, and a chevron with the rest
        // (anchoring, the resolved ones, putting the panel away).
        const open = state.comments.length - resolved
        const headKey = `${this.floating}/${this.panel}/${this.anchored}/${open}/${resolved}/${this.showResolved}`
        if (headKey !== this.headKey) {
            this.headKey = headKey
            this.holder.menu?.()
            const title = el('span', 'ezco-mde-comment-margin-title', plural(open, 'comment'))
            this.head.replaceChildren(title)
            if (!this.floating) {
                const more = chevron(() => this.headItems(resolved), this.holder)
                more.title = 'Comments panel menu'
                more.setAttribute('aria-label', 'Comments panel menu')
                more.classList.add('ezco-mde-comment-tool', 'is-menu')
                this.head.append(more)
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
        // The comment looked at is the current one; an overlaid panel comes
        // back from the edge to show it.
        if (state.active !== this.lastActive) {
            this.lastActive = state.active
            if (state.active) {
                this.setCurrent(state.active)
                if (this.overlay) this.wake()
            }
        }
        for (const [id, card] of this.cards) {
            if (seen.has(id)) continue
            this.observer?.unobserve(card.dom)
            card.destroy()
            this.cards.delete(id)
        }
        this.schedule()
    }

    readonly schedule = () => {
        if (this.frame) return
        this.frame = requestAnimationFrame(() => {
            this.frame = 0
            this.layout_()
        })
    }

    /** Where each card goes. The composer for a new comment: over the
     *  note, under the end of its text, in every layout. Over the note: a
     *  card under its text, never past the note's frame. Beside the note:
     *  level with its text, none overlapping, the one looked at exactly at
     *  its text. In a panel: in the note's order. Every card fits the frame. */
    private layout_() {
        if (!this.view.dom.isConnected) return
        this.listen()
        if (this.draft) this.placeDraft(commentsKey.getState(this.view.state)?.draft?.ranges[0] ?? null)
        if (this.dom.hidden) return
        if (this.overlay) this.fit()
        // A column or panel beside the note takes what is past the note's
        // column, down to SIDE_MIN; one that would squeeze the column even
        // then goes over the note's edge (a panel) or floats (a column).
        if (this.layout !== 'float') {
            const { floating, overlay, width } = this.decide()
            if (!overlay) this.dom.style.width = width
            if (floating !== this.floating || overlay !== this.overlay) {
                this.floating = floating
                this.overlay = overlay
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
        // Capped to the frame before anything is measured, so a card is
        // placed at its real height.
        for (const card of this.cards.values()) this.cap(card.dom, this.panel ? null : frameHeight)
        const box = this.list.getBoundingClientRect()
        const origin = box.top
        type Placed = { id: string; dom: HTMLElement; range: { from: number; to: number } | null; height: number; top: number; fixed: boolean }
        const placed: Placed[] = []
        for (const info of state.comments) {
            const card = this.cards.get(info.id)
            if (!card || card.dom.hidden) continue
            placed.push({ id: info.id, dom: card.dom, range: info.target.whole ? null : info.target.range, height: card.dom.offsetHeight, top: 0, fixed: info.id === state.active && !state.draft })
        }

        if (this.panel) {
            // In the note's order, the list scrolling on its own, the one
            // looked at brought into view.
            this.dom.style.setProperty('--ezco-mde-comment-frame', `${Math.round(frameHeight)}px`)
            const at = (p: Placed) => (p.range ? this.coords(p.range.from, 1)?.top ?? 0 : 0)
            placed.sort((a, b) => at(a) - at(b))
            for (const p of placed) {
                p.dom.style.top = ''
                p.dom.style.left = ''
                p.dom.style.right = ''
                this.list.append(p.dom)
            }
            if (state.active && state.active !== this.scrolledTo) {
                this.scrolledTo = state.active
                const dom = placed.find((p) => p.id === state.active)?.dom
                if (dom) this.keepInView(dom)
            }
            this.spy()
            return
        }

        if (this.floating) {
            // Over the note. Each card under its text, where it stays: what
            // the frame cannot show of it is scrolled to, never the card
            // moved. Cards whose texts share a line (one mark opens them
            // all) stand one under the other.
            for (const p of placed) p.top = this.under(p.dom, p.range, box, scroller)
            placed.sort((a, b) => a.top - b.top || (a.range?.from ?? 0) - (b.range?.from ?? 0))
            let floor = -Infinity
            for (const p of placed) {
                if (p.top < floor) {
                    p.top = floor
                    p.dom.style.top = `${Math.round(p.top)}px`
                }
                floor = p.top + p.height + GAP
            }
            this.list.style.minHeight = ''
            this.keepFloatingInView(placed.filter((p) => p.fixed).map((p) => ({ id: p.id, dom: p.dom, height: p.height })), scroller)
            return
        }

        // Beside the note: level with its text; the card being looked at
        // exactly there, the others pushed out of its way.
        for (const p of placed) p.top = p.range ? (this.coords(p.range.from, 1)?.top ?? origin) - origin : 0
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

    private coords(pos: number, side: -1 | 1) {
        try {
            return this.view.coordsAtPos(Math.min(pos, this.view.state.doc.content.size), side)
        } catch {
            return null
        }
    }

    /** No card taller than the frame, less a line of the text it is under
     *  (which stays in view over it): what is more scrolls inside it. (In a
     *  panel, `frameHeight` null, the list is what scrolls.) */
    private cap(dom: HTMLElement, frameHeight: number | null) {
        dom.style.maxHeight = frameHeight === null ? '' : `${Math.round(Math.max(160, frameHeight - 2 * GAP - 32))}px`
        const inside = dom.firstElementChild as HTMLElement | null
        dom.classList.toggle('is-capped', frameHeight !== null && !!inside && inside.scrollHeight > inside.clientHeight + 1)
    }

    /** `dom`, in a layer over the note whose box is `box`, under the end of
     *  its text (a card on the whole note at the top of the frame), left by
     *  the text's end but on the note. Its top in the layer. */
    private under(dom: HTMLElement, range: { from: number; to: number } | null, box: DOMRect, scroller: HTMLElement | null): number {
        const end = range ? this.coords(range.to, -1) : null
        const frameTop = (scroller ? scroller.getBoundingClientRect().top : 0) - box.top
        const top = end ? end.bottom - box.top + GAP : Math.max(0, frameTop + GAP)
        dom.style.top = `${Math.round(top)}px`
        if (end) {
            const width = dom.offsetWidth
            dom.style.left = `${Math.round(Math.max(0, Math.min(end.left - box.left - 24, box.width - width)))}px`
            dom.style.right = 'auto'
        } else {
            dom.style.left = ''
            dom.style.right = ''
        }
        return top
    }

    /** The composer for a new comment: over the note, under the end of the
     *  text it is about, brought into the frame as a floating card is. */
    private placeDraft(range: { from: number; to: number } | null) {
        const dom = this.draft!.dom
        const scroller = scrollerOf(this.view.dom)
        this.cap(dom, scroller ? scroller.clientHeight : window.innerHeight)
        this.under(dom, range, this.over.getBoundingClientRect(), scroller)
        this.keepFloatingInView([{ id: 'new', dom, height: dom.offsetHeight }], scroller)
    }

    destroy() {
        if (this.frame) cancelAnimationFrame(this.frame)
        if (this.spyFrame) cancelAnimationFrame(this.spyFrame)
        this.unsubscribe?.()
        this.holder.menu?.()
        this.ungrow()
        this.scrollTarget?.removeEventListener('scroll', this.onScroll)
        this.unplaceOver()
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
        this.storage.floating = () => true
        this.dom.remove()
        this.over.remove()
        this.column?.remove()
    }
}

export const CommentMargin = Extension.create<CommentMarginOptions, CommentMarginStorage>({
    name: 'commentMargin',

    addOptions() {
        return { mount: undefined, layout: 'panel', composer: undefined }
    },

    addStorage() {
        return { open: () => {}, sheet: null, togglePanel: () => false, floating: () => true }
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
