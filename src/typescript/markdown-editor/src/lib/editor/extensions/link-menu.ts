import { Editor, Extension, getMarkRange } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import tippy, { Instance as TippyInstance } from 'tippy.js'
import { LinkPopover } from '../ui/link-popover'

/**
 * Inline link affordances:
 *
 * - A plain click on a link just places the caret (Link is configured with
 *   `openOnClick: false`) and reveals an inline popover with the URL plus
 *   Open / Edit / Remove.
 * - Following the link requires the platform "open" gesture — ⌘-click on
 *   macOS, Ctrl-click elsewhere (we accept either) — or, for keyboard-only
 *   use, the popover's focusable "Open" control and the `Mod-Enter`
 *   shortcut while the caret is in a link.
 * - Creating / editing a link uses the popover's inline URL input (no more
 *   `window.prompt`).
 *
 * Positioned with Tippy (same as the block-action / selection menus),
 * anchored to a dedicated zero-size element — NOT to `view.dom`: Tippy writes
 * aria-* attributes onto its reference, and the ProseMirror editable must not
 * be mutated from outside its own lifecycle.
 */

function openHref(href: string): void {
    if (!href || typeof window === 'undefined') return
    // Open as a normal new tab. Passing a window-features string (e.g.
    // 'noopener') makes browsers treat this as a *popup*, which the blocker
    // can silently drop on the first programmatic call — the cause of links
    // appearing to need a second ⌘-click / ⌘-Enter to open. Sever `opener`
    // afterwards instead, to keep the reverse-tabnabbing protection.
    const win = window.open(href, '_blank')
    if (win) win.opener = null
}

class LinkPopoverView {
    private editor: Editor
    private view: EditorView
    private popover: LinkPopover
    private popup: TippyInstance | null = null
    /** Dedicated Tippy reference, appended to the editor wrapper (outside the
     *  PM-managed editable). Its own position is irrelevant — Tippy positions
     *  via `getReferenceClientRect`. We deliberately do NOT anchor to
     *  `view.dom`: Tippy writes aria-* attributes onto its reference and the
     *  editable must not be mutated from outside its lifecycle. */
    private refEl: HTMLElement
    private mode: 'hidden' | 'shown' = 'hidden'
    // True while the URL input has focus — `update()` won't disturb the
    // popover then (so an in-progress edit isn't reset by editor activity).
    private editing = false
    // Identifies the link currently shown so repeated `update()`s for the
    // same link just reposition rather than rebuilding the popover.
    private shownKey: string | null = null
    // Set when the user dismisses the popover (Esc / click-out) while the
    // caret is still inside a link, so `update()` doesn't immediately reopen
    // it (incl. while they keep typing in that link). Cleared when the caret
    // leaves any link, or a fresh click lands in the editor.
    private dismissed = false
    private getRect: () => DOMRect = () => new DOMRect()
    private onDocMouseDown: (e: MouseEvent) => void
    private onDocKeyDown: (e: KeyboardEvent) => void
    /** Status-bar-style chip showing the URL of the link under the pointer —
     *  replaces the native preview browsers suppress inside contenteditable. */
    private hoverEl: HTMLElement
    private hoverHref: string | null = null
    private onLinkOver: (e: MouseEvent) => void
    private onLinkLeave: () => void

    constructor(view: EditorView, editor: Editor) {
        this.view = view
        this.editor = editor

        this.refEl = document.createElement('span')
        this.refEl.setAttribute('aria-hidden', 'true')
        this.refEl.style.cssText = 'position:absolute;width:0;height:0;'
        ;(view.dom.parentElement ?? document.body).appendChild(this.refEl)

        this.popover = new LinkPopover({
            onRemove: () => this.remove(),
            onSave: (href) => this.save(href),
            onCancel: () => this.cancel(),
            onFocusChange: (focused) => { this.editing = focused },
        })

        this.onDocMouseDown = (e: MouseEvent) => {
            const t = e.target as Node | null
            // A fresh click in the editor clears any dismissal, so clicking a
            // link (even the just-dismissed one) reopens its popover. The
            // click may not change the selection (clicking where the caret
            // already is dispatches no transaction, so `update()` wouldn't
            // run), so re-evaluate on the next frame.
            if (t && this.view.dom.contains(t)) {
                this.dismissed = false
                requestAnimationFrame(() => { if (!this.editing) this.update(this.view) })
            }
            if (this.mode === 'hidden') return
            if (!t) return
            if (this.popover.dom.contains(t)) return
            if (this.view.dom.contains(t)) return // editor clicks → handled by update()
            if (this.editing) this.cancel()
            else this.hide()
        }
        document.addEventListener('mousedown', this.onDocMouseDown, true)

        // Escape closes the popover from anywhere — when the caret (not the
        // input) holds focus, the popover's own keydown handler wouldn't see
        // it.
        this.onDocKeyDown = (e: KeyboardEvent) => {
            if (this.mode === 'hidden' || e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            this.cancel()
        }
        document.addEventListener('keydown', this.onDocKeyDown, true)

        // Hover preview: show the URL of the link under the pointer in a
        // bottom-left chip (browsers don't surface their native status-bar URL
        // preview for links inside contenteditable). Passive — doesn't affect
        // click/edit behaviour; following a link is still ⌘/Ctrl-click.
        this.hoverEl = document.createElement('div')
        this.hoverEl.className = 'ezco-mde-link-hover-preview'
        this.hoverEl.setAttribute('aria-hidden', 'true')
        this.hoverEl.style.display = 'none'
        document.body.appendChild(this.hoverEl)
        this.onLinkOver = (e: MouseEvent) => {
            const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
            if (a && this.view.dom.contains(a)) this.showHover(a.getAttribute('href') ?? '')
            else this.hideHover()
        }
        this.onLinkLeave = () => this.hideHover()
        view.dom.addEventListener('mouseover', this.onLinkOver)
        view.dom.addEventListener('mouseleave', this.onLinkLeave)
    }

    private showHover(href: string) {
        if (!href) { this.hideHover(); return }
        if (this.hoverHref === href) return
        this.hoverHref = href
        this.hoverEl.textContent = href
        this.hoverEl.style.display = 'block'
    }

    private hideHover() {
        if (this.hoverHref === null) return
        this.hoverHref = null
        this.hoverEl.style.display = 'none'
    }

    update(view: EditorView) {
        this.view = view
        // Don't disturb an open editor input.
        if (this.editing) return
        // Show whenever the caret is inside a link, hide only when it leaves.
        // (We deliberately don't gate on `view.hasFocus()`: during a click's
        // own dispatch the editable isn't focused yet, and async codeblock
        // transactions can momentarily move focus — both would otherwise stop
        // the popover from ever appearing or make it flicker.)
        const range = this.linkRangeAtSelection()
        const href = this.currentHref()
        // Require an actual href. With the caret right *before* a link,
        // getMarkRange still finds the adjacent link's range, but the caret
        // isn't inside the mark (no active link → empty href); don't show the
        // popover there.
        if (!range || !href || this.selectionInCode()) {
            this.dismissed = false // caret left the link → allow showing again
            this.hide()
            return
        }
        if (this.dismissed) {
            this.hide()
            return
        }
        this.showFor(range)
    }

    destroy() {
        document.removeEventListener('mousedown', this.onDocMouseDown, true)
        document.removeEventListener('keydown', this.onDocKeyDown, true)
        this.view.dom.removeEventListener('mouseover', this.onLinkOver)
        this.view.dom.removeEventListener('mouseleave', this.onLinkLeave)
        this.hoverEl.remove()
        this.popup?.destroy()
        this.popup = null
        this.popover.destroy()
        this.refEl.remove()
    }

    // ── selection / link helpers ────────────────────────────────
    private linkRangeAtSelection(): { from: number; to: number } | null {
        const { state } = this.view
        const markType = state.schema.marks.link
        if (!markType) return null
        const range = getMarkRange(state.doc.resolve(state.selection.from), markType)
        return range ?? null
    }

    private selectionInCode(): boolean {
        const { $from } = this.view.state.selection
        return !!$from.parent?.type.spec.code
    }

    private currentHref(): string {
        return (this.editor.getAttributes('link').href as string | undefined) ?? ''
    }

    /** Reference rect for Tippy: the link's rendered `<a>` if present, else
     *  the current selection's coordinates. */
    private anchorRect(range: { from: number; to: number } | null): DOMRect {
        if (range) {
            try {
                const { node } = this.view.domAtPos(range.from)
                const el = (node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null
                const a = el?.closest('a') as HTMLElement | null
                if (a) return a.getBoundingClientRect()
            } catch { /* fall through */ }
        }
        try {
            const c = this.view.coordsAtPos(this.view.state.selection.from)
            return new DOMRect(c.left, c.top, 1, Math.max(1, c.bottom - c.top))
        } catch {
            return new DOMRect()
        }
    }

    private ensurePopup() {
        if (this.popup) return
        this.popup = tippy(this.refEl, {
            getReferenceClientRect: () => this.getRect(),
            appendTo: () => document.body,
            content: this.popover.dom,
            interactive: true,
            trigger: 'manual',
            placement: 'top',
            theme: 'ezco-mde-block-actions',
            hideOnClick: false,
            // Quick fade in, but close instantly when the caret leaves a link.
            duration: [150, 0],
        }) as TippyInstance
    }

    // ── states ──────────────────────────────────────────────────
    /** Show the popover for the link at `range` (URL prefilled, not focused —
     *  the caret stays in the editor). */
    private showFor(range: { from: number; to: number }) {
        const href = this.currentHref()
        const key = `${range.from}:${range.to}:${href}`
        this.getRect = () => this.anchorRect(range)
        this.ensurePopup()
        if (this.mode === 'shown' && this.shownKey === key) {
            return
        }
        this.popover.show(href, false)
        this.popup!.show()
        this.mode = 'shown'
        this.shownKey = key
    }

    /** Open the popover with its input focused — used by the selection menu's
     *  "Link" action to create a link on the current selection. */
    startEdit() {
        // Mark editing *now*, not when the input's focus event fires a frame
        // later (the input is focused via rAF). The caller typically runs an
        // `editor.focus()` chain right before this, whose transaction triggers
        // `update()` — which, with no link mark yet (empty href), would
        // otherwise immediately hide the popover we're trying to open.
        this.editing = true
        this.dismissed = false
        const range = this.linkRangeAtSelection()
        this.getRect = () => this.anchorRect(range)
        this.ensurePopup()
        this.popover.show(this.currentHref(), true)
        this.popup!.show()
        this.mode = 'shown'
        this.shownKey = null
    }

    private save(href: string) {
        this.editing = false
        const chain = this.editor.chain().focus().extendMarkRange('link')
        if (href === '') chain.unsetLink().run()
        else chain.setLink({ href }).run()
        this.hide()
    }

    private remove() {
        this.editing = false
        this.editor.chain().focus().extendMarkRange('link').unsetLink().run()
        this.hide()
    }

    private cancel() {
        this.editing = false
        // Stay dismissed until the caret leaves the link (so it doesn't pop
        // back up on the next keystroke / cursor move within it).
        this.dismissed = !!this.linkRangeAtSelection()
        this.hide()
        this.editor.view.focus()
    }

    private hide() {
        if (this.mode === 'hidden') return
        this.mode = 'hidden'
        this.editing = false
        this.shownKey = null
        this.popup?.hide()
    }
}

interface LinkMenuStorage {
    view: LinkPopoverView | null
}

export const LinkMenu = Extension.create<unknown, LinkMenuStorage>({
    name: 'linkMenu',

    addStorage() {
        return { view: null }
    },

    addProseMirrorPlugins() {
        const editor = this.editor
        const storage = this.storage
        return [
            new Plugin({
                key: new PluginKey('linkMenu'),
                props: {
                    // ⌘/Ctrl-click follows the link; a plain click is left to
                    // place the caret (Link's openOnClick is false).
                    handleDOMEvents: {
                        click: (_view, event) => {
                            if (!(event.metaKey || event.ctrlKey)) return false
                            const a = (event.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null
                            if (a?.href) {
                                event.preventDefault()
                                openHref(a.href)
                                return true
                            }
                            return false
                        },
                    },
                },
                view: (editorView) => {
                    const popoverView = new LinkPopoverView(editorView, editor)
                    storage.view = popoverView
                    const origDestroy = popoverView.destroy.bind(popoverView)
                    popoverView.destroy = () => {
                        storage.view = null
                        origDestroy()
                    }
                    return popoverView
                },
            }),
        ]
    },

    addKeyboardShortcuts() {
        return {
            // Keyboard-only follow: open the link under the caret.
            'Mod-Enter': () => {
                const href = (this.editor.getAttributes('link').href as string | undefined) ?? ''
                if (!href) return false
                openHref(href)
                return true
            },
        }
    },
})
