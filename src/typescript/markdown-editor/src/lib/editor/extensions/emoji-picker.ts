import { Editor, Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import tippy, { Instance as TippyInstance } from 'tippy.js'

/**
 * Emoji picker.
 *
 * Typing `:` followed by at least two characters opens a searchable, OS-style
 * emoji grid (`:smi` → 😄 😊 …); arrow keys move through the grid, Enter inserts
 * the focused emoji in place of the `:query`. Mirrors the slash-command trigger
 * mechanics (a ProseMirror plugin + a tippy popup) but presents a grid with a
 * name footer rather than a flat menu.
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
        const raw = localStorage.getItem(RECENT_KEY)
        const list = raw ? (JSON.parse(raw) as unknown) : []
        return Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string').slice(0, RECENT_MAX) : []
    } catch {
        return []
    }
}

/** Note that `emoji` was picked, so it comes first next time. */
export function rememberEmoji(emoji: string): void {
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, RECENT_MAX)))
    } catch {
        // Nothing to remember with: the picker works the same.
    }
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
        this.dom = document.createElement('div')
        this.dom.className = 'ezco-mde-emoji-menu'
        this.dom.setAttribute('role', 'listbox')
        this.dom.setAttribute('aria-label', 'Emoji')
        if (options.search) {
            this.input = document.createElement('input')
            this.input.type = 'search'
            this.input.className = 'ezco-mde-emoji-search'
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
            const note = document.createElement('div')
            note.className = 'ezco-mde-emoji-note'
            note.textContent = loading ? 'Loading emoji…' : 'No emoji found'
            this.dom.appendChild(note)
            return
        }
        // A row above the grid (recent picks): mouse and Tab, not the arrows.
        if (row) {
            const label = document.createElement('div')
            label.className = 'ezco-mde-emoji-heading'
            label.textContent = row.label
            const strip = document.createElement('div')
            strip.className = 'ezco-mde-emoji-row'
            for (const emoji of row.emoji.slice(0, COLUMNS)) {
                const cell = document.createElement('button')
                cell.type = 'button'
                cell.className = 'ezco-mde-emoji-cell'
                cell.textContent = emoji
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
            const label = document.createElement('div')
            label.className = 'ezco-mde-emoji-heading'
            label.textContent = heading
            this.dom.appendChild(label)
        }
        const grid = document.createElement('div')
        grid.className = 'ezco-mde-emoji-grid'
        this.results.forEach((e, i) => {
            const cell = document.createElement('button')
            cell.type = 'button'
            cell.className = 'ezco-mde-emoji-cell' + (i === this.selectedIndex ? ' is-selected' : '')
            cell.textContent = e.unicode
            cell.title = e.label
            cell.setAttribute('role', 'option')
            cell.setAttribute('aria-label', e.label)
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
        const footer = document.createElement('div')
        footer.className = 'ezco-mde-emoji-footer'
        const focused = this.results[this.selectedIndex]
        const glyph = document.createElement('span')
        glyph.className = 'ezco-mde-emoji-footer-glyph'
        glyph.textContent = focused?.unicode ?? ''
        const name = document.createElement('span')
        name.className = 'ezco-mde-emoji-footer-name'
        name.textContent = focused?.label ?? ''
        footer.append(glyph, name)
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
 * A popover beside `anchor` holding `content`, closed by Escape, a click
 * elsewhere, or the returned function.
 */
function popover(anchor: HTMLElement, content: HTMLElement, onMount?: () => void): () => void {
    let popup: TippyInstance | null = null
    let outside: ((e: MouseEvent) => void) | null = null
    let keys: ((e: KeyboardEvent) => void) | null = null
    const close = () => {
        if (outside) document.removeEventListener('mousedown', outside)
        if (keys) document.removeEventListener('keydown', keys, true)
        outside = keys = null
        popup?.destroy()
        popup = null
    }
    const created = tippy(anchor, {
        appendTo: () => document.body,
        content,
        showOnCreate: true,
        interactive: true,
        trigger: 'manual',
        placement: 'bottom-start',
        theme: 'ezco-mde-emoji',
        maxWidth: 'none',
        // Once in the document (not after a transition, which the theme may
        // not have).
        onMount: () => requestAnimationFrame(() => onMount?.()),
    }) as TippyInstance | TippyInstance[]
    popup = Array.isArray(created) ? created[0] : created
    outside = (e: MouseEvent) => {
        if (!content.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close()
    }
    keys = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && (content.contains(document.activeElement) || !document.activeElement || document.activeElement === document.body)) {
            e.preventDefault()
            e.stopPropagation()
            close()
        }
    }
    setTimeout(() => {
        if (outside) document.addEventListener('mousedown', outside)
        if (keys) document.addEventListener('keydown', keys, true)
    }, 0)
    return close
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
    close = popover(anchor, menu.dom, () => menu.focus())
    return close
}

/**
 * What a reaction is picked from: the common reactions and the ones picked
 * recently, one row, and "More" for the whole grid with search (recents
 * first there too). Picking closes it.
 */
export function openReactionPicker(anchor: HTMLElement, onPick: (emoji: string) => void): () => void {
    const root = document.createElement('div')
    root.className = 'ezco-mde-reactions'
    root.setAttribute('role', 'listbox')
    root.setAttribute('aria-label', 'React')
    const seen = new Set<string>()
    const quick = [...QUICK_REACTIONS, ...recentEmoji()].filter((e) => !seen.has(e) && seen.add(e)).slice(0, QUICK_REACTIONS.length + 4)
    let close = () => {}
    const done = (emoji: string) => {
        close()
        rememberEmoji(emoji)
        onPick(emoji)
    }
    for (const emoji of quick) {
        const cell = document.createElement('button')
        cell.type = 'button'
        cell.className = 'ezco-mde-emoji-cell'
        cell.textContent = emoji
        cell.setAttribute('role', 'option')
        cell.setAttribute('aria-label', `React ${emoji}`)
        cell.addEventListener('mousedown', (e) => e.preventDefault())
        cell.addEventListener('click', () => done(emoji))
        root.append(cell)
    }
    const more = document.createElement('button')
    more.type = 'button'
    more.className = 'ezco-mde-emoji-more'
    more.textContent = '…'
    more.title = 'More emoji'
    more.setAttribute('aria-label', 'More emoji')
    more.addEventListener('mousedown', (e) => e.preventDefault())
    more.addEventListener('click', () => {
        // The whole grid takes the popover's place: recents, then a search.
        const menu = new EmojiMenu({ search: true, onPick: done, onClose: () => close() })
        menu.query('')
        root.replaceChildren(menu.dom)
        root.classList.add('is-full')
        menu.focus()
    })
    root.append(more)
    // The first reaction takes focus once shown, unless the whole grid was
    // asked for meanwhile (its search field has it then).
    close = popover(anchor, root, () => {
        if (!root.classList.contains('is-full')) (root.querySelector('button') as HTMLButtonElement | null)?.focus()
    })
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
                view: () => {
                    view = new EmojiPickerView(this.editor, this.options)
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
    private popup: TippyInstance | null = null
    private range: { from: number; to: number } | null = null
    private outsideClick: ((e: MouseEvent) => void) | null = null

    constructor(
        private editor: Editor,
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
            const created = tippy(document.body, {
                getReferenceClientRect: () => {
                    const view = this.editor.view
                    const r = this.range ?? { from: 0, to: 0 }
                    const start = view.coordsAtPos(r.from)
                    const end = view.coordsAtPos(r.to)
                    return {
                        top: start.top, bottom: end.bottom, left: start.left, right: end.right,
                        width: end.right - start.left, height: end.bottom - start.top,
                        x: start.left, y: start.top, toJSON() { return this },
                    } as DOMRect
                },
                appendTo: () => document.body,
                content: this.menu.dom,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
                theme: 'ezco-mde-emoji',
                maxWidth: 'none',
                onShow: () => this.addOutsideClick(),
                onHide: () => this.removeOutsideClick(),
            }) as TippyInstance | TippyInstance[]
            this.popup = Array.isArray(created) ? created[0] : created
        }
        this.menu.query(query)
    }

    private selectEmoji(emoji: string) {
        if (!this.range) return
        this.editor.chain().focus().deleteRange(this.range).insertContent(emoji).run()
        this.hide()
    }

    private hide() {
        this.removeOutsideClick()
        this.popup?.destroy()
        this.popup = null
        this.menu = null
        this.range = null
    }

    private addOutsideClick() {
        this.outsideClick = (e: MouseEvent) => {
            const target = e.target as Node
            if (this.menu && !this.menu.dom.contains(target) && !this.editor.view.dom.contains(target)) {
                this.hide()
            }
        }
        // Defer so the click that opened the menu doesn't immediately close it.
        setTimeout(() => { if (this.outsideClick) document.addEventListener('mousedown', this.outsideClick) }, 0)
    }

    private removeOutsideClick() {
        if (this.outsideClick) {
            document.removeEventListener('mousedown', this.outsideClick)
            this.outsideClick = null
        }
    }

    destroy() {
        this.editor.off('selectionUpdate', this.onSelectionUpdate)
        this.hide()
    }
}
