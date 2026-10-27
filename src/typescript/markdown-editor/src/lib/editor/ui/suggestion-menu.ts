/**
 * The menus that open under what is being typed: the slash commands after
 * `/`, the vault's notes after `[[`, the emoji after `:`. Each extension
 * still finds its own trigger and builds its own items (what counts as a
 * `/` on a word boundary, which notes match, which emoji), and this holds
 * what they had three of: a popover placed by the typed text and closed
 * by a press elsewhere (`popoverUnderTyped`), and for the two list menus
 * the rows, the empty line, the arrow keys, Enter and Escape, the row
 * under the pointer, and the chosen row kept in view (`SuggestionMenu`).
 *
 * The rows and the empty line are drawn with the slash menu's classes
 * (`ezco-mde-slash-item`, `-icon`, `-body`, `-title`, `-desc`,
 * `ezco-mde-slash-empty`) whatever the menu, as they always were; the root
 * class is the menu's own, so a host can tell them apart.
 */
import type { Range } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'
import { button, el, pressable } from './dom'
import { popover, rangeRect, type Popover } from './popover'

/** The typed menus' theme: a transparent box, the list its own surface. */
export const SUGGESTION_THEME = 'ezco-mde-slash'

export interface SuggestionItem {
    /** A short glyph in the chip left of the title (`H1`, `•`); no chip without one. */
    icon?: string
    title: string
    /** The second, muted line; none without one. */
    description?: string
    /** Data attributes on the row (`{ calloutType: 'warning' }` →
     *  `data-callout-type`), for styles that tell the rows apart. */
    data?: Record<string, string>
    /** Chosen, by Enter (Tab, where it chooses) or a press: the menu is closed before this runs. */
    onSelect: () => void
}

export interface SuggestionMenuOptions {
    /** The editor the menu is typed in: the popover's reference (its
     *  scroller is listened to, its presses are its own) and where the
     *  range's rect is read. */
    view: EditorView
    /** The typed trigger and query, read whenever the menu is placed. */
    range: () => Range | null
    /** Placed by this rect instead of the range's (a button the menu opens
     *  from), read whenever the menu is placed. */
    rect?: () => DOMRect
    /** The listbox's root class (`ezco-mde-slash-menu` by default). */
    className?: string
    /** The listbox's `aria-label`. */
    label?: string
    /** A `.tippy-box[data-theme~=…]` rule of styles.ts; the slash menu's by default. */
    theme?: string
    /** ArrowUp on the first row: `wrap` round to the last (the default),
     *  or `close` the menu and leave the key to the editor's own
     *  handlers (the browser's caret move is prevented either way). */
    atTop?: 'wrap' | 'close'
    /** Tab chooses the row too (Enter always does). */
    tabSelects?: boolean
    /** Closed on its own: Escape, a press outside, ArrowUp off the top.
     *  Not called for a choice, nor for `hide()`. */
    onClose: () => void
}

interface PopoverUnderTypedOptions {
    /** The popover's theme; the list menus' by default. */
    theme?: string
    /** Placed by this rect rather than the range's. */
    rect?: () => DOMRect
    /** Closed by a press outside the popover and the editor (a press in
     *  the editor is the editor's: its selection then decides). */
    onPressOutside: () => void
}

/**
 * A popover under the text being typed, shown at once: placed by `range`
 * (read each time it is placed, so it follows the query as it grows), no
 * cap on its width, the editor its reference. Shared by the list menus
 * and the emoji grid.
 */
export function popoverUnderTyped(view: EditorView, range: () => Range | null, content: HTMLElement, opts: PopoverUnderTypedOptions): Popover {
    const p = popover(view.dom, content, {
        rect: opts.rect ?? (() => rangeRect(view, range() ?? { from: 0, to: 0 })),
        theme: opts.theme ?? SUGGESTION_THEME,
        maxWidth: 'none',
        onPressOutside: opts.onPressOutside,
    })
    p.show()
    return p
}

/**
 * A list of suggestions under the text being typed. `show()` draws the
 * items given (or the empty line) with the first selected, in a popover
 * made on the first call and refilled after; ArrowDown and ArrowUp move
 * the selection (wrapping), Enter chooses it, Escape closes; the row under
 * the pointer is the selected one, and a press on a row chooses it without
 * taking the editor's focus. Whoever owns the menu gives it the editor's
 * keys while `isOpen`.
 */
export class SuggestionMenu {
    private popup: Popover | null = null
    private list: HTMLElement | null = null
    private items: SuggestionItem[] = []
    private selected = 0

    constructor(private readonly opts: SuggestionMenuOptions) {}

    /** Shown (a popover stands). */
    get isOpen(): boolean {
        return this.popup !== null
    }

    /** The listbox while shown. */
    get dom(): HTMLElement | null {
        return this.list
    }

    /** Draw `items` (or `empty`, the line shown without any), the first
     *  (or the `selected`th) selected; opened if not yet. */
    show(items: SuggestionItem[], empty: string, selected = 0): void {
        this.items = items
        this.selected = Math.min(Math.max(0, selected), Math.max(0, items.length - 1))
        const list = el('div', this.opts.className ?? 'ezco-mde-slash-menu')
        list.setAttribute('role', 'listbox')
        if (this.opts.label) list.setAttribute('aria-label', this.opts.label)
        if (items.length === 0) list.append(el('div', 'ezco-mde-slash-empty', empty))
        items.forEach((item, i) => {
            const row = button('ezco-mde-slash-item')
            row.setAttribute('role', 'option')
            for (const [key, value] of Object.entries(item.data ?? {})) row.dataset[key] = value
            if (item.icon) row.append(el('span', 'ezco-mde-slash-item-icon', item.icon))
            const body = el('span', 'ezco-mde-slash-item-body')
            body.append(el('span', 'ezco-mde-slash-item-title', item.title))
            if (item.description) body.append(el('span', 'ezco-mde-slash-item-desc', item.description))
            row.append(body)
            pressable(row, () => this.choose(item))
            row.addEventListener('mouseenter', () => {
                if (this.selected !== i) this.select(i)
            })
            list.append(row)
        })
        this.list = list
        this.mark()
        if (this.popup) this.popup.instance.setContent(list)
        else this.popup = popoverUnderTyped(this.opts.view, this.opts.range, list, { theme: this.opts.theme, rect: this.opts.rect, onPressOutside: () => this.close() })
    }

    /** The editor's keys while open; true when the key was the menu's. */
    handleKeyDown(event: KeyboardEvent): boolean {
        if (!this.popup) return false
        const n = this.items.length
        switch (event.key) {
            case 'Escape':
                event.preventDefault()
                this.close()
                return true
            case 'ArrowDown':
                if (!n) return false
                event.preventDefault()
                this.select((this.selected + 1) % n)
                return true
            case 'ArrowUp':
                if (!n) return false
                event.preventDefault()
                if (this.selected === 0 && this.opts.atTop === 'close') {
                    this.close()
                    return false
                }
                this.select((this.selected - 1 + n) % n)
                return true
            case 'Tab':
            case 'Enter': {
                if (event.key === 'Tab' && !this.opts.tabSelects) return false
                const item = this.items[this.selected]
                if (!item) return false
                event.preventDefault()
                this.choose(item)
                return true
            }
            default:
                return false
        }
    }

    /** Closed and gone; nothing is told. Safe to call when closed. */
    hide(): void {
        this.popup?.destroy()
        this.popup = null
        this.list = null
        this.items = []
        this.selected = 0
    }

    destroy(): void {
        this.hide()
    }

    private close() {
        this.hide()
        this.opts.onClose()
    }

    private choose(item: SuggestionItem) {
        this.hide()
        item.onSelect()
    }

    private select(i: number) {
        this.selected = i
        this.mark(true)
    }

    /** The selected row marked, and (once in the document) kept in view. */
    private mark(scroll = false) {
        this.list?.querySelectorAll<HTMLElement>('.ezco-mde-slash-item').forEach((row, i) => {
            const on = i === this.selected
            row.classList.toggle('is-selected', on)
            row.setAttribute('aria-selected', String(on))
            if (on && scroll) row.scrollIntoView({ block: 'nearest' })
        })
    }
}
