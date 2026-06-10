import { Editor, Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import tippy, { Instance as TippyInstance } from 'tippy.js'
import { ContextMenu } from '../ui/context-menu'

/**
 * Selection menu.
 *
 * When the user makes a non-empty text selection in prose, a small icon
 * button appears at the *end* of the selection. The button is part of the
 * tab order (Tab from the editor moves focus to it), and activating it
 * (click / Enter / Space) opens a menu of actions that apply to the
 * selected range — inline formatting, links, block conversions.
 *
 * Reuses the shared, keyboard-accessible `ContextMenu` component (the same
 * one the block-action indicator uses). Unlike the slash menu — where the
 * user is still typing and focus must stay in the editor — here we *want*
 * focus to move into the menu, which is exactly what `ContextMenu` does.
 */

interface SelectionAction {
    label: string
    icon: string
    isActive?: (editor: Editor) => boolean
    /** Hide the action entirely when it can't apply to this selection. */
    isAvailable?: (editor: Editor) => boolean
    run: (editor: Editor) => void
}

// A compact "edit selection" affordance. Kept as an inline SVG (rather
// than a text glyph) so it reads as a deliberate UI control distinct from
// the prose, at any font size.
const SELECTION_MENU_ICON = `
<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
  <path fill="currentColor" d="M11.13 1.2a1.4 1.4 0 0 1 1.98 0l1.69 1.69a1.4 1.4 0 0 1 0 1.98l-7.4 7.4a1.4 1.4 0 0 1-.64.37l-3.2.86a.7.7 0 0 1-.86-.86l.86-3.2a1.4 1.4 0 0 1 .37-.64l7.4-7.4Zm.99.99-7.4 7.4a.35.35 0 0 0-.1.16l-.5 1.84 1.84-.5a.35.35 0 0 0 .16-.1l7.4-7.4-1.4-1.4Z"/>
</svg>`

function actionsForSelection(editor: Editor): SelectionAction[] {
    const marks = editor.schema.marks
    const actions: SelectionAction[] = []

    if (marks.bold) {
        actions.push({
            label: 'Bold',
            icon: 'B',
            isActive: (e) => e.isActive('bold'),
            run: (e) => e.chain().focus().toggleBold().run(),
        })
    }
    if (marks.italic) {
        actions.push({
            label: 'Italic',
            icon: 'I',
            isActive: (e) => e.isActive('italic'),
            run: (e) => e.chain().focus().toggleItalic().run(),
        })
    }
    if (marks.strike) {
        actions.push({
            label: 'Strikethrough',
            icon: 'S',
            isActive: (e) => e.isActive('strike'),
            run: (e) => e.chain().focus().toggleStrike().run(),
        })
    }
    if (marks.code) {
        actions.push({
            label: 'Inline code',
            icon: '</>',
            isActive: (e) => e.isActive('code'),
            run: (e) => e.chain().focus().toggleCode().run(),
        })
    }
    if (marks.link) {
        actions.push({
            label: 'Link',
            icon: '🔗',
            isActive: (e) => e.isActive('link'),
            run: (e) => {
                const previous = e.getAttributes('link').href as string | undefined
                const url = window.prompt('Link URL', previous ?? 'https://')
                if (url === null) {
                    e.chain().focus().run()
                    return
                }
                if (url.trim() === '') {
                    e.chain().focus().extendMarkRange('link').unsetLink().run()
                    return
                }
                e.chain()
                    .focus()
                    .extendMarkRange('link')
                    .setLink({ href: url.trim() })
                    .run()
            },
        })
    }

    actions.push({
        label: 'Heading 1',
        icon: 'H1',
        isAvailable: (e) => e.can().setHeading({ level: 1 }),
        run: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
    })
    actions.push({
        label: 'Heading 2',
        icon: 'H2',
        isAvailable: (e) => e.can().setHeading({ level: 2 }),
        run: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
    })
    actions.push({
        label: 'Quote',
        icon: '“',
        isAvailable: (e) => e.can().toggleBlockquote(),
        isActive: (e) => e.isActive('blockquote'),
        run: (e) => e.chain().focus().toggleBlockquote().run(),
    })
    actions.push({
        label: 'Clear formatting',
        icon: '⌫',
        run: (e) => e.chain().focus().unsetAllMarks().run(),
    })

    return actions.filter((a) => !a.isAvailable || a.isAvailable(editor))
}

class SelectionMenuView {
    private editor: Editor
    private view: EditorView
    private wrapper: HTMLElement
    private btn: HTMLButtonElement
    private popup: TippyInstance | null = null
    private activeMenu: ContextMenu | null = null
    private isOpen = false
    private onFocusChange: () => void
    private onDocumentMouseDown: ((e: MouseEvent) => void) | null = null

    constructor(view: EditorView, editor: Editor) {
        this.view = view
        this.editor = editor

        this.wrapper = (view.dom.parentElement as HTMLElement) ?? view.dom
        this.ensureWrapperPositioned()

        this.btn = document.createElement('button')
        this.btn.type = 'button'
        this.btn.className = 'ezco-mde-selection-menu-btn'
        this.btn.style.position = 'absolute'
        this.btn.style.opacity = '0'
        this.btn.style.pointerEvents = 'none'
        this.btn.tabIndex = -1
        this.btn.contentEditable = 'false'
        this.btn.setAttribute('aria-label', 'Selection actions')
        this.btn.setAttribute('aria-haspopup', 'menu')
        this.btn.innerHTML = SELECTION_MENU_ICON

        // Don't let the button's own mousedown collapse the selection
        // before the click handler runs.
        this.btn.addEventListener('mousedown', (e) => e.preventDefault())
        this.btn.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.toggleMenu()
        })

        this.wrapper.appendChild(this.btn)

        // Keep the button visible while focus is on it / the menu, and
        // hide it when focus leaves the editor entirely.
        this.onFocusChange = () => this.reposition()
        view.dom.addEventListener('focusout', this.onFocusChange)
        view.dom.addEventListener('focusin', this.onFocusChange)

        this.onDocumentMouseDown = (e: MouseEvent) => {
            if (!this.isOpen) return
            const target = e.target as Node | null
            if (!target) return
            if (this.activeMenu?.dom.contains(target)) return
            if (this.btn.contains(target)) return
            this.closeMenu()
        }
        document.addEventListener('mousedown', this.onDocumentMouseDown)
    }

    update() {
        // A transaction may have moved/cleared the selection; if the menu
        // is open and the selection changed underneath it, close it.
        if (this.isOpen && this.editor.state.selection.empty) {
            this.closeMenu()
        }
        this.reposition()
    }

    destroy() {
        this.closeMenu()
        this.activeMenu?.destroy()
        this.popup?.destroy()
        this.btn.remove()
        this.view.dom.removeEventListener('focusout', this.onFocusChange)
        this.view.dom.removeEventListener('focusin', this.onFocusChange)
        if (this.onDocumentMouseDown) {
            document.removeEventListener('mousedown', this.onDocumentMouseDown)
            this.onDocumentMouseDown = null
        }
        // Intentionally do NOT reset the wrapper's position here. The
        // wrapper is shared with other overlays (block actions), and a
        // leftover `position: relative` is harmless — whereas resetting it
        // can yank the positioning context out from under a sibling
        // overlay that's still live (this happens under React StrictMode's
        // double-mount, where one editor's teardown runs after another's
        // setup).
    }

    /** Ensure the wrapper establishes a positioning context for the
     *  absolutely-positioned button. Re-asserted on each show so the
     *  button stays correctly anchored even if another overlay's teardown
     *  reset the wrapper back to `static`. */
    private ensureWrapperPositioned() {
        if (getComputedStyle(this.wrapper).position === 'static') {
            this.wrapper.style.position = 'relative'
        }
    }

    /** True when the current selection is a non-empty text selection in
     *  prose that supports the contextual actions (i.e. not an atom/node
     *  selection, not inside a code surface). */
    private shouldShow(): boolean {
        const { selection } = this.view.state
        if (!(selection instanceof TextSelection)) return false
        if (selection.empty) return false
        const { $from } = selection
        const parent = $from.parent
        // Code blocks edit through their own nested editor; offer no
        // prose actions there.
        if (parent.type.spec.code) return false
        if (!parent.isTextblock) return false
        // Keep the affordance while focus is in the editor, or while the
        // user is interacting with the button / its menu.
        return this.hasFocusInside()
    }

    private hasFocusInside(): boolean {
        if (this.view.hasFocus()) return true
        if (this.isOpen) return true
        const active = document.activeElement
        if (!active) return false
        return this.btn.contains(active) || !!this.activeMenu?.dom.contains(active)
    }

    /** Move focus from the editor onto the selection-menu button. Returns
     *  false when the button isn't currently shown. */
    focusButton(): boolean {
        if (!this.shouldShow()) return false
        this.reposition()
        if (this.btn.style.opacity === '0') return false
        this.btn.focus()
        return true
    }

    private reposition() {
        if (!this.shouldShow()) {
            this.btn.style.opacity = '0'
            this.btn.style.pointerEvents = 'none'
            this.btn.tabIndex = -1
            return
        }

        const { to } = this.view.state.selection
        let coords
        try {
            coords = this.view.coordsAtPos(to)
        } catch {
            this.btn.style.opacity = '0'
            return
        }

        this.ensureWrapperPositioned()
        const wrapperRect = this.wrapper.getBoundingClientRect()
        const left = coords.right - wrapperRect.left + this.wrapper.scrollLeft + 4
        const top =
            coords.top - wrapperRect.top + this.wrapper.scrollTop +
            (coords.bottom - coords.top) / 2

        this.btn.style.left = `${left}px`
        this.btn.style.top = `${top}px`
        this.btn.style.opacity = '1'
        this.btn.style.pointerEvents = 'auto'
        this.btn.tabIndex = 0
    }

    private toggleMenu() {
        if (this.isOpen) {
            this.closeMenu({ restoreEditorFocus: true })
        } else {
            this.openMenu()
        }
    }

    private openMenu() {
        if (this.isOpen) return
        const actions = actionsForSelection(this.editor)
        if (actions.length === 0) return
        this.isOpen = true

        const menu = new ContextMenu({
            className: 'ezco-mde-selection-menu',
            items: actions.map((action) => ({
                label: action.isActive?.(this.editor)
                    ? `${action.label} ✓`
                    : action.label,
                icon: action.icon,
                onSelect: () => {
                    this.closeMenu()
                    action.run(this.editor)
                },
            })),
            onClose: () => this.closeMenu({ restoreEditorFocus: true }),
        })
        this.activeMenu = menu

        this.popup?.destroy()
        this.popup = tippy(this.btn, {
            content: menu.dom,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-end',
            theme: 'ezco-mde-block-actions',
            appendTo: () => document.body,
            hideOnClick: false,
            onShown: () => menu.focus(),
            onHide: () => {
                this.isOpen = false
                this.activeMenu?.disable()
                setTimeout(() => {
                    this.activeMenu?.destroy()
                    this.activeMenu = null
                    this.popup?.destroy()
                    this.popup = null
                }, 0)
            },
        }) as TippyInstance
        menu.enable()
        this.popup.show()
    }

    private closeMenu(opts: { restoreEditorFocus?: boolean } = {}) {
        if (!this.isOpen) return
        this.isOpen = false
        if (opts.restoreEditorFocus) {
            // The action runs its own `.focus()` chain; for plain
            // dismissals (Esc / Tab / click-out) return focus to the
            // editor at the still-live selection.
            this.editor.view.focus()
        }
        this.popup?.hide()
    }
}

interface SelectionMenuStorage {
    selectionMenuView: SelectionMenuView | null
}

export const SelectionMenu = Extension.create<unknown, SelectionMenuStorage>({
    name: 'selectionMenu',

    // Run the Tab handler ahead of list-indent and other default keymaps
    // so a non-empty selection sends focus to the menu button.
    priority: 1000,

    addStorage() {
        return { selectionMenuView: null }
    },

    addProseMirrorPlugins() {
        const editor = this.editor
        const storage = this.storage
        return [
            new Plugin({
                key: new PluginKey('selectionMenu'),
                view: (view) => {
                    const menuView = new SelectionMenuView(view, editor)
                    storage.selectionMenuView = menuView
                    const origDestroy = menuView.destroy.bind(menuView)
                    menuView.destroy = () => {
                        storage.selectionMenuView = null
                        origDestroy()
                    }
                    return menuView
                },
                props: {
                    handleKeyDown: (_view, event) => {
                        if (event.key !== 'Tab' || event.shiftKey) return false
                        const menuView = storage.selectionMenuView
                        if (!menuView) return false
                        // Only intercept Tab when there's an active text
                        // selection (otherwise Tab keeps its normal job,
                        // e.g. indenting a list item at an empty cursor).
                        if (menuView.focusButton()) {
                            event.preventDefault()
                            return true
                        }
                        return false
                    },
                },
            }),
        ]
    },
})
