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
 */

interface EmojiEntry {
    /** The rendered emoji character. */
    unicode: string
    /** Human label, e.g. "grinning face". */
    label: string
    /** Search keywords, e.g. ["grin", "happy", "smile"]. */
    tags?: string[]
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
    public menu: HTMLElement | null = null
    private popup: TippyInstance | null = null
    private range: { from: number; to: number } | null = null
    private results: EmojiEntry[] = []
    private selectedIndex = 0
    private outsideClick: ((e: MouseEvent) => void) | null = null
    private loadToken = 0

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
            this.selectedIndex = 0
            this.showFor(query)
        } else {
            this.hide()
        }
    }

    /** Resolve results for `query` (lazy-loading the dataset on first use) and
     *  render. While the dataset loads, a placeholder is shown. */
    private showFor(query: string) {
        if (EMOJIS) {
            this.results = searchEmojis(query)
            this.render()
            return
        }
        // First open: show a loading state, then re-evaluate once loaded (the
        // token guards against a stale load resolving after the user moved on).
        const token = ++this.loadToken
        this.results = []
        this.render(true)
        loadEmojis()
            .then(() => { if (token === this.loadToken && this.range) this.onSelectionUpdate() })
            .catch(() => { if (token === this.loadToken) this.hide() })
    }

    private render(loading = false) {
        this.menu = this.buildMenu(loading)
        if (this.popup) {
            this.popup.setContent(this.menu)
        } else {
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
                content: this.menu,
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
    }

    private buildMenu(loading: boolean): HTMLElement {
        const root = document.createElement('div')
        root.className = 'ezco-mde-emoji-menu'
        root.setAttribute('role', 'listbox')
        root.setAttribute('aria-label', 'Emoji')

        if (loading) {
            const note = document.createElement('div')
            note.className = 'ezco-mde-emoji-note'
            note.textContent = 'Loading emoji…'
            root.appendChild(note)
            return root
        }
        if (this.results.length === 0) {
            const note = document.createElement('div')
            note.className = 'ezco-mde-emoji-note'
            note.textContent = 'No emoji found'
            root.appendChild(note)
            return root
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
            // `mousedown` (not click) so selecting never blurs the editor first.
            cell.addEventListener('mousedown', (ev) => {
                ev.preventDefault()
                this.selectEmoji(e)
            })
            cell.addEventListener('mouseenter', () => {
                this.selectedIndex = i
                this.updateSelection()
            })
            grid.appendChild(cell)
        })
        root.appendChild(grid)

        // OS-picker style: a footer naming the focused emoji.
        const footer = document.createElement('div')
        footer.className = 'ezco-mde-emoji-footer'
        const focused = this.results[this.selectedIndex]
        footer.innerHTML = ''
        const glyph = document.createElement('span')
        glyph.className = 'ezco-mde-emoji-footer-glyph'
        glyph.textContent = focused?.unicode ?? ''
        const name = document.createElement('span')
        name.className = 'ezco-mde-emoji-footer-name'
        name.textContent = focused?.label ?? ''
        footer.append(glyph, name)
        root.appendChild(footer)
        return root
    }

    handleKeyDown(event: KeyboardEvent): boolean {
        if (this.results.length === 0) {
            if (event.key === 'Escape') { event.preventDefault(); this.hide(); return true }
            return false
        }
        const last = this.results.length - 1
        const col = this.selectedIndex % COLUMNS
        switch (event.key) {
            case 'ArrowRight':
                event.preventDefault()
                this.selectedIndex = Math.min(this.selectedIndex + 1, last)
                this.updateSelection(); return true
            case 'ArrowLeft':
                event.preventDefault()
                this.selectedIndex = Math.max(this.selectedIndex - 1, 0)
                this.updateSelection(); return true
            case 'ArrowDown':
                event.preventDefault()
                this.selectedIndex = Math.min(this.selectedIndex + COLUMNS, last)
                this.updateSelection(); return true
            case 'ArrowUp':
                event.preventDefault()
                if (this.selectedIndex < COLUMNS) { this.hide(); return false } // exit upward
                this.selectedIndex -= COLUMNS
                this.updateSelection(); return true
            case 'Enter':
            case 'Tab':
                event.preventDefault()
                if (this.results[this.selectedIndex]) this.selectEmoji(this.results[this.selectedIndex])
                return true
            case 'Escape':
                event.preventDefault(); this.hide(); return true
            default:
                // Keep `col` referenced so a future home/end nav can use it.
                void col
                return false
        }
    }

    private updateSelection() {
        if (!this.menu) return
        const cells = this.menu.querySelectorAll('.ezco-mde-emoji-cell')
        cells.forEach((cell, i) => {
            cell.classList.toggle('is-selected', i === this.selectedIndex)
            if (i === this.selectedIndex) (cell as HTMLElement).scrollIntoView({ block: 'nearest' })
        })
        const focused = this.results[this.selectedIndex]
        const glyph = this.menu.querySelector('.ezco-mde-emoji-footer-glyph')
        const name = this.menu.querySelector('.ezco-mde-emoji-footer-name')
        if (glyph) glyph.textContent = focused?.unicode ?? ''
        if (name) name.textContent = focused?.label ?? ''
    }

    private selectEmoji(emoji: EmojiEntry) {
        if (!this.range) return
        this.editor.chain().focus().deleteRange(this.range).insertContent(emoji.unicode).run()
        this.hide()
    }

    private hide() {
        this.removeOutsideClick()
        this.popup?.destroy()
        this.popup = null
        this.menu = null
        this.range = null
        this.results = []
    }

    private addOutsideClick() {
        this.outsideClick = (e: MouseEvent) => {
            const target = e.target as Node
            if (this.menu && !this.menu.contains(target) && !this.editor.view.dom.contains(target)) {
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
