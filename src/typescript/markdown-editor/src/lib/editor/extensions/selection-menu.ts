import { Editor, Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, AllSelection } from '@tiptap/pm/state'
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

// A compact "open contextual actions" affordance. A horizontal three-dot
// (overflow / "more actions") glyph rather than a pencil — the menu isn't
// limited to text-editing, so a neutral menu icon fits the range of
// actions better. Inline SVG so it reads as a deliberate control distinct
// from the prose at any font size.
const SELECTION_MENU_ICON = `
<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
  <circle cx="3.4" cy="8" r="1.45" fill="currentColor"/>
  <circle cx="8" cy="8" r="1.45" fill="currentColor"/>
  <circle cx="12.6" cy="8" r="1.45" fill="currentColor"/>
</svg>`

/** The list-item type the selection's start sits in (`listItem` for
 *  bullet/ordered lists, `taskItem` for task lists), or null when the
 *  selection isn't inside a list. Used to gate the indent/outdent actions
 *  and to decide whether Tab should indent rather than focus the menu. */
function listItemTypeAt(editor: Editor): 'listItem' | 'taskItem' | null {
    const { $from } = editor.state.selection
    for (let d = $from.depth; d > 0; d--) {
        const name = $from.node(d).type.name
        if (name === 'listItem' || name === 'taskItem') return name
    }
    return null
}

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
            // Open the inline link editor (LinkMenu) rather than a blocking
            // window.prompt. Falls back to focusing the editor if the
            // LinkMenu extension isn't installed.
            run: (e) => {
                e.chain().focus().run()
                const linkView = (e.storage as Record<string, any>).linkMenu?.view
                if (linkView?.startEdit) linkView.startEdit()
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
    // Indent / outdent for list selections — a discoverable, pointer-friendly
    // way to bulk-indent the selected items (Tab/Shift+Tab still work too).
    // Only shown inside a list. `⇥` = ⇥ (tab-to-bar), `⇤` = ⇤.
    actions.push({
        label: 'Indent',
        icon: '⇥',
        isAvailable: (e) => {
            const t = listItemTypeAt(e)
            return !!t && e.can().sinkListItem(t)
        },
        run: (e) => {
            const t = listItemTypeAt(e)
            if (t) e.chain().focus().sinkListItem(t).run()
        },
    })
    actions.push({
        label: 'Outdent',
        icon: '⇤',
        isAvailable: (e) => {
            const t = listItemTypeAt(e)
            return !!t && e.can().liftListItem(t)
        },
        run: (e) => {
            const t = listItemTypeAt(e)
            if (t) e.chain().focus().liftListItem(t).run()
        },
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
    // Whether the button itself currently holds focus. Tracked explicitly
    // (rather than read from `document.activeElement` during a focus event)
    // because the `focusout` that fires on the editor when Tab moves focus
    // to the button races with `activeElement` updating — reading it there
    // intermittently saw `body` and hid the button right as it gained focus.
    private buttonFocused = false
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
        this.btn.addEventListener('focus', () => {
            this.buttonFocused = true
            this.reposition()
        })
        this.btn.addEventListener('blur', () => {
            this.buttonFocused = false
            this.reposition()
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
        if (selection.empty) return false
        // Select-all (Cmd/Ctrl-A) yields an `AllSelection`, NOT a
        // `TextSelection` — which is why select-all never used to surface this
        // menu. It spans the whole document, so the per-textblock checks below
        // don't apply (its `$from` resolves to the doc root, not a textblock);
        // show it (anchored at the doc end) whenever focus is in the editor.
        if (selection instanceof AllSelection) return this.hasFocusInside()
        // Otherwise only ordinary range selections in prose. NodeSelections
        // (atoms/images) get no prose actions.
        if (!(selection instanceof TextSelection)) return false
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
        if (this.buttonFocused) return true
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
        // Anchor the button just *below* the end of the selection (the next
        // row), aligned to the selection's end x — rather than floating to
        // the right of the last character. This keeps the affordance out of
        // the line of text and reads as "actions for what's above".
        const left = coords.right - wrapperRect.left + this.wrapper.scrollLeft - 2
        const top = coords.bottom - wrapperRect.top + this.wrapper.scrollTop + 3

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
            // Open to the *right* of the icon so the menu follows the
            // natural left-to-right reading flow from where the selection
            // ended. Tippy's flip modifier keeps it on-screen, falling back
            // to the left only when there's no room on the right.
            placement: 'right-start',
            popperOptions: {
                modifiers: [
                    { name: 'flip', options: { fallbackPlacements: ['left-start', 'bottom-start', 'top-start'] } },
                    { name: 'preventOverflow', options: { padding: 8 } },
                ],
            },
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
                        // In a list, Tab's natural job is to indent the selected
                        // item(s) — don't hijack it; let the list keymap handle
                        // it (Shift+Tab already falls through to outdent, and the
                        // menu's Indent/Outdent items cover the pointer path).
                        // Elsewhere Tab has no editing role in prose, so we use
                        // it to move focus to the contextual-actions button.
                        if (listItemTypeAt(editor)) return false
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
