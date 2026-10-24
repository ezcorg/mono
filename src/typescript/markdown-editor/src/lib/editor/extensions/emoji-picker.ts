import { Editor, Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { popover, type Popover } from '../ui/popover'
import { popoverUnderTyped } from '../ui/suggestion-menu'
import { button, el, labelled, pressable } from '../ui/dom'
import { FACE_ICON } from '../ui/icons'
import { readKept, writeKept } from '../ui/kept'

/**
 * Emoji picker.
 *
 * Typing `:` followed by at least two characters opens a searchable, OS-style
 * emoji grid (`:smi` → 😄 😊 …); arrow keys move through the grid, Enter inserts
 * the focused emoji in place of the `:query`. Mirrors the slash-command trigger
 * mechanics (a ProseMirror plugin, a popover under the typed text through
 * `ui/suggestion-menu.ts`'s `popoverUnderTyped`) but presents a grid with a
 * name footer rather than a flat menu, so its rows and keys are its own.
 *
 * The ~550KB emoji dataset is **lazy-loaded** via a dynamic import — the cost is
 * paid on the first `:`-trigger, not at editor load (a consumer can warm it
 * ahead of time with `prefetchEmojiData()`).
 *
 * The grid itself (`EmojiMenu`) is the one emoji chooser of the editor:
 * the `:` trigger drives it from the typed query, and `openEmojiPicker`
 * opens it with a search field of its own beside any element (a comment's
 * reactions), so there is one way to pick an emoji everywhere.
 */

interface EmojiEntry {
    /** The rendered emoji character. */
    unicode: string
    /** Human label, e.g. "grinning face". */
    label: string
    /** Search keywords, e.g. ["grin", "happy", "smile"]. */
    tags?: string[]
    /** Emojibase's category (0 is smileys and emotion), and its place in it. */
    group?: number
    order?: number
}

/** The first category, shown when nothing has been typed. */
const FIRST_GROUP = 0
const FIRST_GROUP_LABEL = 'Smileys & emotion'
function firstCategory(): EmojiEntry[] {
    if (!EMOJIS) return []
    // The dataset lists components (flag letters, skin tones) first and out
    // of order; the category is its own entries, in the order it gives them.
    const inGroup = EMOJIS.filter((e) => e.group === FIRST_GROUP)
    const chosen = inGroup.length ? inGroup : EMOJIS.filter((e) => e.group === undefined && !/regional indicator|skin tone/i.test(e.label))
    return chosen.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).slice(0, MAX_RESULTS)
}

// ── Lazy dataset ────────────────────────────────────────────────────────────
let EMOJIS: EmojiEntry[] | null = null
let loadPromise: Promise<EmojiEntry[]> | null = null

/** Load (and cache) the emoji dataset. The dynamic import is code-split, so the
 *  dataset only travels over the wire the first time the picker is opened. */
function loadEmojis(): Promise<EmojiEntry[]> {
    if (EMOJIS) return Promise.resolve(EMOJIS)
    if (!loadPromise) {
        loadPromise = import('emojibase-data/en/compact.json')
            .then((mod) => {
                EMOJIS = ((mod as { default?: EmojiEntry[] }).default ?? mod) as EmojiEntry[]
                return EMOJIS
            })
            .catch((err) => {
                // Allow a retry on the next trigger if the fetch failed.
                loadPromise = null
                throw err
            })
    }
    return loadPromise
}

/** Warm the emoji cache ahead of first use (e.g. during idle time) so the first
 *  `:`-trigger is instant. Safe to call repeatedly. */
export function prefetchEmojiData(): void {
    void loadEmojis().catch(() => { /* surfaced on real use */ })
}

// Grid geometry — a fixed column count keeps 2-D arrow navigation predictable.
const COLUMNS = 9
const MAX_RESULTS = 54 // 6 rows

// ── What was picked before ──────────────────────────────────────────────────
const RECENT_KEY = 'ezco-mde-emoji-recent'
const RECENT_MAX = 27 // 3 rows

/** The emoji picked most recently, newest first (this browser's). */
export function recentEmoji(): string[] {
    try {
        const raw = readKept(RECENT_KEY)
        const list = raw ? (JSON.parse(raw) as unknown) : []
        return Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string').slice(0, RECENT_MAX) : []
    } catch {
        return []
    }
}

/** Note that `emoji` was picked, so it comes first next time. */
export function rememberEmoji(emoji: string): void {
    writeKept(RECENT_KEY, JSON.stringify([emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, RECENT_MAX)))
}

/** The reactions a conversation reaches for first (GitHub's set). */
export const QUICK_REACTIONS = ['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀']

/** Rank emojis for `query` by how well its label/tags match: exact word > prefix
 *  > substring, preserving the dataset's canonical order within each tier (common
 *  emoji first). */
function searchEmojis(query: string): EmojiEntry[] {
    if (!EMOJIS) return []
    const q = query.toLowerCase()
    const scored: { e: EmojiEntry; score: number }[] = []
    for (const e of EMOJIS) {
        const label = e.label.toLowerCase()
        const tags = e.tags ?? []
        let score = -1
        if (label === q || tags.includes(q)) score = 0
        else if (label.startsWith(q) || tags.some((t) => t.startsWith(q))) score = 1
        else if (label.includes(q) || tags.some((t) => t.includes(q))) score = 2
        if (score >= 0) scored.push({ e, score })
    }
    // Stable sort by score keeps the dataset's order within a tier.
    scored.sort((a, b) => a.score - b.score)
    return scored.slice(0, MAX_RESULTS).map((s) => s.e)
}

export interface EmojiPickerOptions {
    /** Minimum query length after `:` before the picker opens (default 2). */
    minChars: number
}

export interface EmojiMenuOptions {
    /** An emoji was chosen. */
    onPick: (emoji: string) => void
    /** The menu asks to be closed (Escape, or arrowing up out of it). */
    onClose: () => void
    /** With a search field of its own (when not driven by typed text). */
    search?: boolean
}

/**
 * The emoji grid: results for a query, arrow keys through them, Enter or a
 * click picks one, a footer names the one under focus. Loads the dataset on
 * first use. It draws into `dom`; whoever shows it puts `dom` somewhere and
 * gives it the keys (or, with `search`, its own field takes them).
 */
export class EmojiMenu {
    readonly dom: HTMLElement
    private results: EmojiEntry[] = []
    private selectedIndex = 0
    private loadToken = 0
    private input: HTMLInputElement | null = null

    constructor(private readonly options: EmojiMenuOptions) {
        this.dom = el('div', 'ezco-mde-emoji-menu')
        this.dom.setAttribute('role', 'listbox')
        this.dom.setAttribute('aria-label', 'Emoji')
        if (options.search) {
            this.input = el('input', 'ezco-mde-emoji-search')
            this.input.type = 'search'
            this.input.placeholder = 'Search emoji'
            this.input.setAttribute('aria-label', 'Search emoji')
            this.input.addEventListener('input', () => this.query(this.input!.value))
            this.input.addEventListener('keydown', (e) => {
                if (this.handleKeyDown(e)) return
                if (e.key === 'Escape') {
                    e.preventDefault()
                    options.onClose()
                }
            })
            this.dom.append(this.input)
        }
        this.render(false)
    }

    /** Show the results for `query` (loading the dataset first, once). With
     *  nothing typed (a searching menu): a row of what was picked recently,
     *  or the common reactions standing in for it, then the first category. */
    query(query: string) {
        this.selectedIndex = 0
        if (!EMOJIS) {
            const token = ++this.loadToken
            this.results = []
            this.render(true)
            loadEmojis()
                .then(() => { if (token === this.loadToken) this.query(query) })
                .catch(() => { if (token === this.loadToken) this.render(false) })
            return
        }
        if (!query) {
            if (!this.input) {
                this.results = []
                this.render(false)
                return
            }
            const recent = recentEmoji()
            this.results = firstCategory()
            this.render(false, FIRST_GROUP_LABEL, { label: recent.length ? 'Recent' : 'Reactions', emoji: recent.length ? recent : QUICK_REACTIONS })
            return
        }
        this.results = searchEmojis(query)
        this.render(false)
    }

    focus() {
        this.input?.focus()
    }

    private pick(emoji: string) {
        rememberEmoji(emoji)
        this.options.onPick(emoji)
    }

    hasResults() {
        return this.results.length > 0
    }

    private render(loading: boolean, heading?: string, row?: { label: string; emoji: string[] }) {
        for (const child of [...this.dom.children]) if (child !== this.input) child.remove()
        if (loading || (this.results.length === 0 && !row)) {
            this.dom.appendChild(el('div', 'ezco-mde-emoji-note', loading ? 'Loading emoji…' : 'No emoji found'))
            return
        }
        // A row above the grid (recent picks): mouse and Tab, not the arrows.
        if (row) {
            const label = el('div', 'ezco-mde-emoji-heading', row.label)
            const strip = el('div', 'ezco-mde-emoji-row')
            for (const emoji of row.emoji.slice(0, COLUMNS)) {
                const cell = button('ezco-mde-emoji-cell', emoji)
                cell.setAttribute('aria-label', emoji)
                cell.addEventListener('mousedown', (ev) => ev.preventDefault())
                cell.addEventListener('click', () => this.pick(emoji))
                // Under the pointer, this is the one cell lit: the grid's
                // selection steps back until an arrow key or the pointer
                // returns to it.
                cell.addEventListener('mouseenter', () => {
                    this.selectedIndex = -1
                    this.updateSelection()
                    cell.classList.add('is-selected')
                })
                cell.addEventListener('mouseleave', () => cell.classList.remove('is-selected'))
                strip.append(cell)
            }
            this.dom.append(label, strip)
        }
        if (heading) {
            this.dom.appendChild(el('div', 'ezco-mde-emoji-heading', heading))
        }
        const grid = el('div', 'ezco-mde-emoji-grid')
        this.results.forEach((e, i) => {
            const cell = labelled(button('ezco-mde-emoji-cell' + (i === this.selectedIndex ? ' is-selected' : ''), e.unicode), e.label)
            cell.setAttribute('role', 'option')
            // `mousedown` (not click) so selecting never blurs what is being typed in.
            cell.addEventListener('mousedown', (ev) => {
                ev.preventDefault()
                this.pick(e.unicode)
            })
            cell.addEventListener('mouseenter', () => {
                this.selectedIndex = i
                this.updateSelection()
            })
            grid.appendChild(cell)
        })
        this.dom.appendChild(grid)
        // OS-picker style: a footer naming the focused emoji.
        const footer = el('div', 'ezco-mde-emoji-footer')
        const focused = this.results[this.selectedIndex]
        footer.append(el('span', 'ezco-mde-emoji-footer-glyph', focused?.unicode ?? ''), el('span', 'ezco-mde-emoji-footer-name', focused?.label ?? ''))
        this.dom.appendChild(footer)
    }

    /** Arrow keys, Enter and Escape; true when the key was the menu's. */
    handleKeyDown(event: KeyboardEvent): boolean {
        if (this.results.length === 0) {
            if (event.key === 'Escape') {
                event.preventDefault()
                this.options.onClose()
                return true
            }
            return false
        }
        const last = this.results.length - 1
        if (this.selectedIndex < 0) this.selectedIndex = 0
        switch (event.key) {
            case 'ArrowRight':
                event.preventDefault()
                this.selectedIndex = Math.min(this.selectedIndex + 1, last)
                this.updateSelection()
                return true
            case 'ArrowLeft':
                event.preventDefault()
                this.selectedIndex = Math.max(this.selectedIndex - 1, 0)
                this.updateSelection()
                return true
            case 'ArrowDown':
                event.preventDefault()
                this.selectedIndex = Math.min(this.selectedIndex + COLUMNS, last)
                this.updateSelection()
                return true
            case 'ArrowUp':
                event.preventDefault()
                if (this.selectedIndex < COLUMNS) {
                    // Out of the grid upward: back to the text (the `:` trigger
                    // closes); a searching menu stays on its field.
                    if (!this.input) this.options.onClose()
                    return !!this.input
                }
                this.selectedIndex -= COLUMNS
                this.updateSelection()
                return true
            case 'Enter':
            case 'Tab':
                event.preventDefault()
                if (this.results[this.selectedIndex]) this.pick(this.results[this.selectedIndex].unicode)
                return true
            case 'Escape':
                event.preventDefault()
                this.options.onClose()
                return true
            default:
                return false
        }
    }

    private updateSelection() {
        const cells = this.dom.querySelectorAll('.ezco-mde-emoji-grid .ezco-mde-emoji-cell')
        cells.forEach((cell, i) => {
            cell.classList.toggle('is-selected', i === this.selectedIndex)
            if (i === this.selectedIndex) (cell as HTMLElement).scrollIntoView({ block: 'nearest' })
        })
        const focused = this.results[this.selectedIndex]
        const glyph = this.dom.querySelector('.ezco-mde-emoji-footer-glyph')
        const name = this.dom.querySelector('.ezco-mde-emoji-footer-name')
        if (glyph) glyph.textContent = focused?.unicode ?? ''
        if (name) name.textContent = focused?.label ?? ''
    }
}

/**
 * A popover beside `anchor` holding `content`, closed by Escape, a press
 * elsewhere, or the returned function.
 */
function emojiPopover(anchor: HTMLElement, content: HTMLElement, onMount?: () => void): { close: () => void; update: () => void } {
    let keys: ((e: KeyboardEvent) => void) | null = null
    const close = () => {
        if (keys) document.removeEventListener('keydown', keys, true)
        keys = null
        popup.destroy()
    }
    const popup = popover(anchor, content, {
        theme: 'ezco-mde-emoji',
        maxWidth: 'none',
        // A grid is tall: shifted across as well as along, or flipped above.
        shift: 'both',
        onPressOutside: close,
        // Once in the document and placed, a frame on.
        onMount: () => requestAnimationFrame(() => onMount?.()),
    })
    // Escape closes it from the grid, or from nowhere (focus on the body).
    keys = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && (content.contains(document.activeElement) || !document.activeElement || document.activeElement === document.body)) {
            e.preventDefault()
            e.stopPropagation()
            close()
        }
    }
    setTimeout(() => {
        if (keys) document.addEventListener('keydown', keys, true)
    }, 0)
    popup.show()
    return {
        close,
        // The content changed size (the whole grid took the row's place):
        // the popover is placed again for it.
        update: () => popup.update(),
    }
}

/**
 * The emoji grid with a search field, beside `anchor`. Picking closes it;
 * so does Escape or a click elsewhere. Returns the way to close it early.
 */
export function openEmojiPicker(anchor: HTMLElement, onPick: (emoji: string) => void): () => void {
    let close = () => {}
    const menu = new EmojiMenu({
        search: true,
        onPick: (emoji) => {
            close()
            onPick(emoji)
        },
        onClose: () => close(),
    })
    menu.query('')
    close = emojiPopover(anchor, menu.dom, () => menu.focus()).close
    return close
}

/** Reactions offered in a grid, before the whole picker. */
const REACTIONS_OFFERED = 9

export interface ReactionGridOptions {
    /** The reader's own reactions, marked. */
    mine?: Set<string>
    /** One picked (what held the grid is closed first). */
    onPick: (emoji: string) => void
    /** What the whole picker opens by when the last cell is pressed. */
    anchor: HTMLElement
    /** Closes what holds the grid (a menu, a popover). */
    close: () => void
}

/**
 * The reactions to give, as a grid: the ones given recently and the common
 * ones, two rows of them, the last cell opening the whole picker (with
 * search) by `anchor`. The reader's own are marked. The same grid stands at
 * the top of a bubble's menu and under its React button.
 */
export function reactionGrid({ mine, onPick, anchor, close }: ReactionGridOptions): HTMLElement {
    const grid = el('div', 'ezco-mde-reaction-grid')
    grid.setAttribute('role', 'group')
    grid.setAttribute('aria-label', 'React')
    const seen = new Set<string>()
    const offered = [...recentEmoji(), ...QUICK_REACTIONS].filter((e) => !seen.has(e) && seen.add(e)).slice(0, REACTIONS_OFFERED)
    const cell = (label: string, pressed: boolean | null, pick: () => void) => {
        const b = pressable(labelled(button('ezco-mde-emoji-cell'), label), pick)
        if (pressed !== null) b.setAttribute('aria-pressed', String(pressed))
        return b
    }
    for (const emoji of offered) {
        const b = cell(`React ${emoji}`, !!mine?.has(emoji), () => {
            close()
            rememberEmoji(emoji)
            onPick(emoji)
        })
        b.textContent = emoji
        grid.append(b)
    }
    const more = cell('More emoji', null, () => {
        close()
        openEmojiPicker(anchor, (emoji) => {
            rememberEmoji(emoji)
            onPick(emoji)
        })
    })
    more.classList.add('is-more')
    more.innerHTML = FACE_ICON
    grid.append(more)
    return grid
}

/**
 * The reaction grid as a popover by `anchor` (the React button): the same
 * grid as the menu's, on the chrome's surface. Picking closes it; so does
 * Escape or a click elsewhere. Returns the way to close it early.
 */
export function openReactionPicker(anchor: HTMLElement, onPick: (emoji: string) => void, mine?: Set<string>): () => void {
    const root = el('div', 'ezco-mde-reactions')
    let close = () => {}
    root.append(reactionGrid({ mine, anchor, close: () => close(), onPick }))
    const popup = emojiPopover(anchor, root, () => (root.querySelector('button') as HTMLButtonElement | null)?.focus())
    close = popup.close
    return close
}

export const EmojiPicker = Extension.create<EmojiPickerOptions>({
    name: 'emojiPicker',

    addOptions() {
        return { minChars: 2 }
    },

    addProseMirrorPlugins() {
        let view: EmojiPickerView | null = null
        return [
            new Plugin({
                key: new PluginKey('emojiPicker'),
                view: (editorView) => {
                    view = new EmojiPickerView(this.editor, editorView, this.options)
                    return view
                },
                props: {
                    handleKeyDown: (_, event) => {
                        if (!view) return false
                        // Open only on a freshly-typed `:` (not when the cursor
                        // merely lands after an existing one). Kept alive while
                        // typing the query; `selectionUpdate` clears it when the
                        // context ends.
                        if (event.key === ':') view.lastInputWasColon = true
                        return view.menu ? view.handleKeyDown(event) : false
                    },
                },
            }),
        ]
    },
})

class EmojiPickerView {
    public lastInputWasColon = false
    /** The menu while it is shown (the plugin gives it the keys). */
    public menu: EmojiMenu | null = null
    private popup: Popover | null = null
    private range: { from: number; to: number } | null = null

    constructor(
        private editor: Editor,
        private view: EditorView,
        private options: EmojiPickerOptions,
    ) {
        this.onSelectionUpdate = this.onSelectionUpdate.bind(this)
        // `selectionUpdate` fires on every keystroke (inserting a char moves the
        // cursor) as well as on cursor moves, so it covers both narrowing the
        // query and leaving the colon context.
        this.editor.on('selectionUpdate', this.onSelectionUpdate)
    }

    private onSelectionUpdate() {
        const { $from } = this.editor.state.selection
        const textBefore = $from.parent.textContent.slice(0, $from.parentOffset)
        // The active colon context: a `:` then zero-or-more non-space/colon chars
        // ending at the cursor. `*` (not `+`) so a freshly-typed bare `:` still
        // counts as "in context" — otherwise the context would look broken for
        // the one keystroke before the query starts and we'd drop the trigger.
        const match = textBefore.match(/:([^\s:]*)$/)

        let onBoundary = false
        if (match) {
            const start = $from.parentOffset - match[0].length
            const before = start > 0 ? $from.parent.textContent[start - 1] : ''
            // The colon must start a word (avoids `http://`, `a:b`, `::`).
            onBoundary = start === 0 || /\s/.test(before)
        }

        // Not in a colon-word context at all → forget the colon and close.
        if (!match || !onBoundary) {
            this.lastInputWasColon = false
            this.hide()
            return
        }

        // In a colon context. Open once the query is long enough — but only if the
        // colon was actually just typed (`lastInputWasColon`), so merely landing
        // the cursor after an existing `:word` doesn't pop the picker. While the
        // query is still too short, keep the flag alive and wait.
        const query = match[1]
        if (this.lastInputWasColon && query.length >= this.options.minChars) {
            this.range = { from: $from.pos - match[0].length, to: $from.pos }
            this.show(query)
        } else {
            this.hide()
        }
    }

    handleKeyDown(event: KeyboardEvent): boolean {
        return this.menu?.handleKeyDown(event) ?? false
    }

    private show(query: string) {
        if (!this.menu) {
            this.menu = new EmojiMenu({
                onPick: (emoji) => this.selectEmoji(emoji),
                onClose: () => this.hide(),
            })
            // Under the typed `:query`, as the slash and `[[` menus are; the
            // grid, its keys and its empty line are the menu's own.
            this.popup = popoverUnderTyped(this.view, () => this.range, this.menu.dom, { theme: 'ezco-mde-emoji', onPressOutside: () => this.hide() })
        }
        this.menu.query(query)
    }

    private selectEmoji(emoji: string) {
        if (!this.range) return
        this.editor.chain().focus().deleteRange(this.range).insertContent(emoji).run()
        this.hide()
    }

    private hide() {
        this.popup?.destroy()
        this.popup = null
        this.menu = null
        this.range = null
    }

    destroy() {
        this.editor.off('selectionUpdate', this.onSelectionUpdate)
        this.hide()
    }
}
