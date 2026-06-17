/**
 * Inline link popover — shown when the caret is inside a link (or when
 * creating a link from a selection). It's a single, always-editable surface:
 * the URL is a text input, with "Save" and "Remove". (Following a link is a
 * separate gesture — ⌘/Ctrl-click or Mod-Enter — so there's no "Open" control
 * and no read-only view to flash through.)
 *
 * The component owns its DOM; the LinkMenu extension hosts it inside a Tippy
 * popover.
 */

export interface LinkPopoverCallbacks {
    /** Commit the URL (empty string ⇒ caller should remove). */
    onSave: (href: string) => void
    /** Remove the link mark, keeping the text. */
    onRemove: () => void
    /** Dismiss without changing anything. */
    onCancel: () => void
    /** The input gained (true) / lost (false) focus — used to avoid the host
     *  re-rendering the popover out from under an in-progress edit. */
    onFocusChange?: (focused: boolean) => void
}

export class LinkPopover {
    public readonly dom: HTMLFormElement
    private readonly cb: LinkPopoverCallbacks
    private readonly inputEl: HTMLInputElement

    constructor(cb: LinkPopoverCallbacks) {
        this.cb = cb

        // A <form> so Enter saves.
        this.dom = document.createElement('form')
        this.dom.className = 'ezco-mde-link-popover'
        this.dom.tabIndex = -1
        this.dom.addEventListener('submit', (e) => {
            e.preventDefault()
            this.cb.onSave(this.inputEl.value.trim())
        })
        // Don't let interacting with the popover collapse the editor selection
        // (but leave the input alone so it can take focus / caret).
        this.dom.addEventListener('mousedown', (e) => {
            if ((e.target as HTMLElement)?.tagName !== 'INPUT') e.preventDefault()
        })
        this.dom.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                this.cb.onCancel()
            }
        })

        this.inputEl = document.createElement('input')
        this.inputEl.type = 'text'
        this.inputEl.className = 'ezco-mde-link-popover-input'
        this.inputEl.placeholder = 'Paste or type a link…'
        this.inputEl.setAttribute('aria-label', 'Link URL')
        this.inputEl.addEventListener('focus', () => this.cb.onFocusChange?.(true))
        this.inputEl.addEventListener('blur', () => this.cb.onFocusChange?.(false))

        const divider = document.createElement('span')
        divider.className = 'ezco-mde-link-popover-divider'
        divider.setAttribute('aria-hidden', 'true')

        const saveBtn = document.createElement('button')
        saveBtn.type = 'submit'
        saveBtn.className = 'ezco-mde-link-popover-btn'
        saveBtn.textContent = 'Save'
        saveBtn.setAttribute('aria-label', 'Save link')

        const removeBtn = document.createElement('button')
        removeBtn.type = 'button'
        removeBtn.className = 'ezco-mde-link-popover-btn'
        removeBtn.textContent = 'Remove'
        removeBtn.setAttribute('aria-label', 'Remove link')
        removeBtn.addEventListener('click', (e) => {
            e.preventDefault()
            this.cb.onRemove()
        })

        this.dom.replaceChildren(this.inputEl, divider, saveBtn, removeBtn)
    }

    /** Show the current URL in the input. `focus` selects the input for
     *  immediate editing (used when creating a link). */
    show(href: string, focus: boolean): void {
        this.inputEl.value = href
        if (focus) {
            requestAnimationFrame(() => {
                this.inputEl.focus()
                this.inputEl.select()
            })
        }
    }

    destroy(): void {
        this.dom.remove()
    }
}
