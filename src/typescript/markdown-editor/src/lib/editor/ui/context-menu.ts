/**
 * Generic keyboard-accessible context menu. Intended for use behind any
 * affordance that opens a list of actions (the block-action indicator
 * today; slash commands, link previews, etc. in the future).
 *
 * Behaviour:
 * - Items are rendered as `<button role="menuitem">` inside a
 *   `role="menu"` container.
 * - `focus()` puts focus on the first item; subsequent ArrowUp/Down
 *   moves focus through items with wraparound; Home/End jump to the
 *   ends; Enter/Space activates; Escape calls `onClose`.
 * - The component owns its DOM; pass `el.dom` as the content of
 *   whatever popover host you're using (Tippy, native popover, etc.).
 */

export interface ContextMenuItem {
    label: string
    icon?: string
    disabled?: boolean
    onSelect: () => void
}

export type ContextMenuCloseReason = 'escape' | 'tab'

export interface ContextMenuOptions {
    items: ContextMenuItem[]
    className?: string
    /** Fires when the user dismisses the menu without selecting an
     *  item — currently via Escape or Tab. Consumers can use the
     *  reason to decide whether to e.g. return focus to the previous
     *  caller. */
    onClose?: (reason: ContextMenuCloseReason) => void
}

export class ContextMenu {
    public readonly dom: HTMLDivElement
    private readonly options: ContextMenuOptions
    private readonly itemButtons: HTMLButtonElement[] = []
    private focusedIndex = 0
    private readonly onKeyDown: (e: KeyboardEvent) => void
    private docListenerAttached = false

    constructor(options: ContextMenuOptions) {
        this.options = options
        this.dom = this.buildDom()
        this.onKeyDown = (e) => this.handleKeyDown(e)
    }

    /** Attach the document-level keydown listener. Call this as soon
     *  as the menu becomes "active" — typically *before* the popover
     *  host's show animation starts, not after — so Escape / arrow
     *  keys work during the animation, not only once it's done.
     *
     *  Why document-level (capture phase) instead of on `this.dom`?
     *  Tippy moves the menu around the DOM and focus can land
     *  somewhere unexpected during the open transition; a listener
     *  bound to the container is fragile. Listening on document with
     *  capture means we get keystrokes regardless of who's focused,
     *  and ahead of any editor keymap. */
    enable(): void {
        if (this.docListenerAttached) return
        document.addEventListener('keydown', this.onKeyDown, true)
        this.docListenerAttached = true
    }

    /** Move focus to the first enabled item. Call from `onShown` (or
     *  equivalent) so the focused item is actually in the DOM by the
     *  time `.focus()` runs. */
    focus(): void {
        const first = this.firstEnabledIndex()
        if (first >= 0) {
            this.setFocus(first)
        } else {
            this.dom.focus()
        }
    }

    /** Detach the keydown listener. Call from the host's `onHide`. */
    disable(): void {
        if (!this.docListenerAttached) return
        document.removeEventListener('keydown', this.onKeyDown, true)
        this.docListenerAttached = false
    }

    destroy(): void {
        this.disable()
        this.dom.remove()
    }

    private buildDom(): HTMLDivElement {
        const root = document.createElement('div')
        root.className = ['ezco-mde-context-menu', this.options.className]
            .filter(Boolean)
            .join(' ')
        root.setAttribute('role', 'menu')
        root.tabIndex = -1

        this.options.items.forEach((item, index) => {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'ezco-mde-context-menu-item'
            btn.setAttribute('role', 'menuitem')
            btn.tabIndex = index === 0 ? 0 : -1
            if (item.disabled) {
                btn.disabled = true
                btn.setAttribute('aria-disabled', 'true')
            }

            if (item.icon !== undefined) {
                const icon = document.createElement('span')
                icon.className = 'ezco-mde-context-menu-item-icon'
                icon.textContent = item.icon
                btn.appendChild(icon)
            }

            const label = document.createElement('span')
            label.className = 'ezco-mde-context-menu-item-label'
            label.textContent = item.label
            btn.appendChild(label)

            // Prevent the parent editor from receiving the mousedown and
            // moving focus/selection out from under us before the click
            // fires.
            btn.addEventListener('mousedown', (e) => e.preventDefault())
            btn.addEventListener('click', (e) => {
                e.preventDefault()
                if (item.disabled) return
                item.onSelect()
            })

            this.itemButtons.push(btn)
            root.appendChild(btn)
        })

        return root
    }

    private handleKeyDown(e: KeyboardEvent): void {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault()
                e.stopPropagation()
                this.moveFocus(1)
                break
            case 'ArrowUp':
                e.preventDefault()
                e.stopPropagation()
                this.moveFocus(-1)
                break
            case 'Home':
                e.preventDefault()
                e.stopPropagation()
                this.setFocus(this.firstEnabledIndex())
                break
            case 'End':
                e.preventDefault()
                e.stopPropagation()
                this.setFocus(this.lastEnabledIndex())
                break
            case 'Enter':
            case ' ':
                e.preventDefault()
                e.stopPropagation()
                this.itemButtons[this.focusedIndex]?.click()
                break
            case 'Escape':
                e.preventDefault()
                e.stopPropagation()
                this.options.onClose?.('escape')
                break
            case 'Tab':
                // Close on Tab so focus returns to the page rather than
                // wandering through other menu items + losing context.
                e.preventDefault()
                this.options.onClose?.('tab')
                break
        }
    }

    private moveFocus(delta: number): void {
        if (this.itemButtons.length === 0) return
        let index = this.focusedIndex
        for (let step = 0; step < this.itemButtons.length; step++) {
            index = (index + delta + this.itemButtons.length) % this.itemButtons.length
            if (!this.itemButtons[index].disabled) {
                this.setFocus(index)
                return
            }
        }
    }

    private setFocus(index: number): void {
        if (index < 0 || index >= this.itemButtons.length) return
        this.itemButtons[this.focusedIndex]?.setAttribute('tabindex', '-1')
        this.focusedIndex = index
        const target = this.itemButtons[index]
        target.setAttribute('tabindex', '0')
        target.focus()
    }

    private firstEnabledIndex(): number {
        return this.itemButtons.findIndex((b) => !b.disabled)
    }

    private lastEnabledIndex(): number {
        for (let i = this.itemButtons.length - 1; i >= 0; i--) {
            if (!this.itemButtons[i].disabled) return i
        }
        return -1
    }
}
