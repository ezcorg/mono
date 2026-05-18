import { Editor, Extension } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, type Selection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import tippy, { Instance as TippyInstance } from 'tippy.js'
import { ContextMenu } from '../ui/context-menu'

interface BlockAction {
    label: string
    icon: string
    run: (ctx: { editor: Editor; pos: number; node: PMNode }) => void
}

const TYPE_ICONS: Record<string, string> = {
    paragraph: '¶',
    heading: 'H',
    bulletList: '•',
    orderedList: '1.',
    taskList: '☐',
    blockquote: '"',
    ezcodeBlock: '</>',
    codeBlock: '</>',
    table: '⊞',
    horizontalRule: '—',
    image: '🖼',
}

function iconForNode(node: PMNode): string {
    if (node.type.name === 'heading') {
        const level = (node.attrs as { level?: number }).level ?? 1
        return `H${level}`
    }
    return TYPE_ICONS[node.type.name] ?? '·'
}

/**
 * Approximate the vertical offset from a block's top edge to the
 * vertical centre of its *first line* of content. Used to vertically
 * align the block-action icon with the first line of the block it
 * belongs to, rather than pinning it to the block's top edge.
 *
 * Primary path: a Range over the first character of the first
 * non-whitespace text node reports the line's actual rendered top/height
 * — this works correctly for every block type, including lists where
 * the wrapping `<ul>`/`<ol>` element inherits its line-height from
 * `html` and reports a much smaller value than the inner `<p>` line
 * actually occupies (which is why list icons read as "too high" with a
 * pure line-height heuristic).
 *
 * Fallback: blocks without text content (hr, image, empty block) fall
 * back to a line-height heuristic on a representative descendant.
 */
function computeIconOffsetY(dom: HTMLElement): number {
    // Icon's intrinsic height = font-size 13px × line-height 1 in
    // `.ezco-mde-block-action-btn` (see styles.ts).
    const iconHalf = 6.5

    const firstLine = firstTextLineRect(dom)
    if (firstLine && firstLine.height > 0) {
        const blockRect = dom.getBoundingClientRect()
        const lineCentre = firstLine.top + firstLine.height / 2
        return Math.max(0, Math.round(lineCentre - blockRect.top - iconHalf))
    }

    // Text-less block (hr, image, or empty paragraph): estimate from
    // line-height on the closest representative descendant.
    const target = findFirstTextElement(dom) ?? dom
    const computed =
        typeof getComputedStyle === 'function' ? getComputedStyle(target) : null
    let lineHeight = NaN
    if (computed) {
        lineHeight = parseFloat(computed.lineHeight)
        if (isNaN(lineHeight)) {
            const fs = parseFloat(computed.fontSize)
            lineHeight = isNaN(fs) ? 20 : fs * 1.2
        }
    }
    if (isNaN(lineHeight) || lineHeight <= 0) lineHeight = 20
    return Math.max(2, Math.round(lineHeight / 2 - iconHalf))
}

/**
 * Measure the rect of the first character of the first non-whitespace
 * text node inside `root`. Returns `null` if there's no such text node
 * (e.g. an empty block, an `<hr>`, an image).
 */
function firstTextLineRect(root: HTMLElement): DOMRect | null {
    if (typeof document === 'undefined') return null
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return node.textContent && node.textContent.trim().length > 0
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT
        },
    } as NodeFilter)
    const textNode = walker.nextNode() as Text | null
    if (!textNode || !textNode.textContent) return null
    try {
        const range = document.createRange()
        range.setStart(textNode, 0)
        range.setEnd(textNode, Math.min(1, textNode.textContent.length))
        // Prefer the first client rect over the union bounding box so
        // we don't pick up a wrapped second line's height.
        const rects = range.getClientRects()
        if (rects.length > 0) return rects[0] as DOMRect
        return range.getBoundingClientRect()
    } catch {
        return null
    }
}

function findFirstTextElement(root: HTMLElement): HTMLElement | null {
    // Used only in the no-text fallback. Prefer leaf-most text-bearing
    // elements; their own line-height metric tracks the rendered line.
    const preferred = 'p, h1, h2, h3, h4, h5, h6, blockquote, td, th'
    if (root.matches?.(preferred)) return root
    const candidate = root.querySelector(preferred) as HTMLElement | null
    return candidate ?? root
}

type ListTypeName = 'bulletList' | 'orderedList' | 'taskList'

function isListType(typeName: string): typeName is ListTypeName {
    return (
        typeName === 'bulletList' ||
        typeName === 'orderedList' ||
        typeName === 'taskList'
    )
}

/**
 * Recursively rebuild a list node as `targetListType`, preserving each
 * item's content and **also converting any nested lists** to the same
 * target type. TipTap's `toggleBulletList`/`toggleOrderedList`/
 * `toggleTaskList` only operate on the cursor's specific item and
 * leave siblings alone; this rebuilds the whole tree.
 */
function convertList(
    editor: Editor,
    pos: number,
    node: PMNode,
    targetListType: ListTypeName,
): void {
    const { state } = editor
    const { schema } = state
    const rebuilt = rebuildListNode(node, targetListType, schema)
    if (!rebuilt) return
    const tr = state.tr.replaceRangeWith(pos, pos + node.nodeSize, rebuilt)
    editor.view.dispatch(tr)
}

function rebuildListNode(
    listNode: PMNode,
    targetListType: ListTypeName,
    schema: PMNode['type']['schema'],
): PMNode | null {
    const listType = schema.nodes[targetListType]
    const itemTypeName = targetListType === 'taskList' ? 'taskItem' : 'listItem'
    const itemType = schema.nodes[itemTypeName]
    if (!listType || !itemType) return null

    const items: PMNode[] = []
    listNode.forEach((child) => {
        // child is a listItem or taskItem in the source list. Map its
        // content node-by-node so any nested lists are recursively
        // rebuilt as the same target type.
        const newChildren: PMNode[] = []
        child.forEach((grandchild) => {
            if (isListType(grandchild.type.name)) {
                const rebuilt = rebuildListNode(grandchild, targetListType, schema)
                if (rebuilt) newChildren.push(rebuilt)
            } else {
                newChildren.push(grandchild)
            }
        })

        // Preserve the `checked` attr when target item type accepts it.
        const itemAttrs: Record<string, unknown> =
            itemTypeName === 'taskItem'
                ? {
                      checked:
                          (child.attrs as { checked?: boolean }).checked ?? false,
                  }
                : {}

        items.push(itemType.create(itemAttrs, Fragment.from(newChildren)))
    })

    return listType.create({}, Fragment.from(items))
}

/**
 * Replace an entire list with a flat run of paragraphs — one paragraph
 * per list item, **including paragraphs from any nested lists** so the
 * action fully un-nests rather than leaving deeper levels intact.
 */
function liftListToParagraphs(editor: Editor, pos: number, node: PMNode): void {
    const { state } = editor
    const { schema } = state
    const paragraphType = schema.nodes.paragraph
    if (!paragraphType) return

    const paragraphs = collectParagraphs(node)
    if (paragraphs.length === 0) return

    const tr = state.tr.replaceWith(
        pos,
        pos + node.nodeSize,
        Fragment.from(paragraphs),
    )
    editor.view.dispatch(tr)
}

function collectParagraphs(listNode: PMNode): PMNode[] {
    const out: PMNode[] = []
    listNode.forEach((item) => {
        item.forEach((child) => {
            if (child.type.name === 'paragraph') {
                out.push(child)
            } else if (isListType(child.type.name)) {
                out.push(...collectParagraphs(child))
            }
        })
    })
    return out
}

function actionsForNode(node: PMNode): BlockAction[] {
    const remove: BlockAction = {
        label: 'Delete',
        icon: '✕',
        run: ({ editor, pos, node }) => {
            // Use TipTap's command chain (not a raw `tr.delete` dispatch)
            // so the editor regains focus and ProseMirror maps the
            // selection to a sensible cursor position after the delete.
            // The previous raw-transaction implementation left no
            // selection / no focus, forcing the user to click back
            // into the editor before they could keep typing.
            editor
                .chain()
                .deleteRange({ from: pos, to: pos + node.nodeSize })
                .focus()
                .run()
        },
    }

    const toParagraph: BlockAction = {
        label: 'Paragraph',
        icon: '¶',
        run: ({ editor }) => editor.chain().focus().setParagraph().run(),
    }

    switch (node.type.name) {
        case 'paragraph':
            return [
                { label: 'Heading 1', icon: 'H1', run: ({ editor }) => editor.chain().focus().setHeading({ level: 1 }).run() },
                { label: 'Heading 2', icon: 'H2', run: ({ editor }) => editor.chain().focus().setHeading({ level: 2 }).run() },
                { label: 'Heading 3', icon: 'H3', run: ({ editor }) => editor.chain().focus().setHeading({ level: 3 }).run() },
                { label: 'Bullet list', icon: '•', run: ({ editor }) => editor.chain().focus().toggleBulletList().run() },
                { label: 'Ordered list', icon: '1.', run: ({ editor }) => editor.chain().focus().toggleOrderedList().run() },
                { label: 'Task list', icon: '☐', run: ({ editor }) => editor.chain().focus().toggleTaskList().run() },
                { label: 'Quote', icon: '"', run: ({ editor }) => editor.chain().focus().toggleBlockquote().run() },
                remove,
            ]
        case 'heading': {
            const current = (node.attrs as { level?: number }).level ?? 1
            const levels: Array<1 | 2 | 3 | 4 | 5 | 6> = [1, 2, 3, 4, 5, 6]
            return [
                ...levels
                    .filter((l) => l !== current)
                    .map<BlockAction>((l) => ({
                        label: `Heading ${l}`,
                        icon: `H${l}`,
                        run: ({ editor }) => editor.chain().focus().setHeading({ level: l }).run(),
                    })),
                toParagraph,
                remove,
            ]
        }
        case 'bulletList':
            return [
                { label: 'Ordered list', icon: '1.', run: ({ editor, pos, node }) => convertList(editor, pos, node, 'orderedList') },
                { label: 'Task list', icon: '☐', run: ({ editor, pos, node }) => convertList(editor, pos, node, 'taskList') },
                { label: 'Lift to paragraphs', icon: '¶', run: ({ editor, pos, node }) => liftListToParagraphs(editor, pos, node) },
                remove,
            ]
        case 'orderedList':
            return [
                { label: 'Bullet list', icon: '•', run: ({ editor, pos, node }) => convertList(editor, pos, node, 'bulletList') },
                { label: 'Task list', icon: '☐', run: ({ editor, pos, node }) => convertList(editor, pos, node, 'taskList') },
                { label: 'Lift to paragraphs', icon: '¶', run: ({ editor, pos, node }) => liftListToParagraphs(editor, pos, node) },
                remove,
            ]
        case 'taskList':
            return [
                { label: 'Bullet list', icon: '•', run: ({ editor, pos, node }) => convertList(editor, pos, node, 'bulletList') },
                { label: 'Ordered list', icon: '1.', run: ({ editor, pos, node }) => convertList(editor, pos, node, 'orderedList') },
                {
                    label: 'Mark all complete',
                    icon: '☑',
                    run: ({ editor, pos, node }) => {
                        const tr = editor.state.tr
                        node.descendants((child, offset) => {
                            if (child.type.name === 'taskItem') {
                                tr.setNodeMarkup(pos + 1 + offset, undefined, { ...child.attrs, checked: true })
                            }
                            return true
                        })
                        editor.view.dispatch(tr)
                    },
                },
                {
                    label: 'Mark all incomplete',
                    icon: '☐',
                    run: ({ editor, pos, node }) => {
                        const tr = editor.state.tr
                        node.descendants((child, offset) => {
                            if (child.type.name === 'taskItem') {
                                tr.setNodeMarkup(pos + 1 + offset, undefined, { ...child.attrs, checked: false })
                            }
                            return true
                        })
                        editor.view.dispatch(tr)
                    },
                },
                { label: 'Lift to paragraphs', icon: '¶', run: ({ editor, pos, node }) => liftListToParagraphs(editor, pos, node) },
                remove,
            ]
        case 'blockquote':
            return [
                { label: 'Unwrap quote', icon: '⇤', run: ({ editor }) => editor.chain().focus().lift('blockquote').run() },
                toParagraph,
                remove,
            ]
        case 'ezcodeBlock':
        case 'codeBlock':
            // No `toParagraph` here: converting a codeblock to a
            // paragraph is rarely useful (it inlines the source as
            // plain prose with no formatting), and the action was
            // also buggy. Keep Copy + Delete as the two relevant
            // actions on a code surface.
            return [
                {
                    label: 'Copy contents',
                    icon: '⎘',
                    run: ({ node }) => {
                        if (typeof navigator !== 'undefined' && navigator.clipboard) {
                            navigator.clipboard.writeText(node.textContent).catch(() => { })
                        }
                    },
                },
                remove,
            ]
        case 'table':
            return [
                { label: 'Add row above', icon: '↑', run: ({ editor }) => editor.chain().focus().addRowBefore().run() },
                { label: 'Add row below', icon: '↓', run: ({ editor }) => editor.chain().focus().addRowAfter().run() },
                { label: 'Add column before', icon: '←', run: ({ editor }) => editor.chain().focus().addColumnBefore().run() },
                { label: 'Add column after', icon: '→', run: ({ editor }) => editor.chain().focus().addColumnAfter().run() },
                { label: 'Delete row', icon: '⊟', run: ({ editor }) => editor.chain().focus().deleteRow().run() },
                { label: 'Delete column', icon: '⊠', run: ({ editor }) => editor.chain().focus().deleteColumn().run() },
                { label: 'Toggle header row', icon: '⇎', run: ({ editor }) => editor.chain().focus().toggleHeaderRow().run() },
                { label: 'Delete table', icon: '✕', run: ({ editor }) => editor.chain().focus().deleteTable().run() },
            ]
        case 'horizontalRule':
            return [remove]
        case 'image':
            return [remove]
        default:
            return [toParagraph, remove]
    }
}

class BlockActionsView {
    private editor: Editor
    private view: EditorView
    private wrapper: HTMLElement
    private btn: HTMLButtonElement
    private btnIcon: HTMLSpanElement
    private popup: TippyInstance | null = null
    private activeMenu: ContextMenu | null = null
    private resizeObserver: ResizeObserver | null = null
    private onDocumentMouseDown: ((e: MouseEvent) => void) | null = null
    // Local source-of-truth for whether the menu is currently open.
    // We can't reliably read `popup.state.isShown` synchronously after
    // calling `show()` (it flips at different times across Tippy
    // versions), and the open-then-close-on-first-press bug happens
    // when something re-enters `openMenu` during that same tick — so
    // we also stamp the open time and ignore re-entry within a short
    // window.
    private isOpen = false
    private lastOpenTime = 0
    // When opening the menu we have to focus a menu item, which pulls
    // the browser selection out of ProseMirror. ProseMirror's
    // `state.selection` is preserved in state, but when focus comes
    // back to the editor it syncs from the DOM selection — which is
    // now wherever the menu put it — and the original cursor position
    // is lost. We stash the selection on open and re-dispatch it on
    // close (Esc / Tab) so the cursor lands where the user left it.
    private savedSelection: Selection | null = null
    private activeNode: PMNode | null = null
    private activePos = -1
    private wrapperHadRelative = false
    private onFocusChange: () => void
    // Cached last-applied geometry. Reposition writes a lot of inline
    // styles, and on every focus event / ResizeObserver tick those
    // writes happen even if the values are unchanged. Repeated writes
    // can invalidate the sticky child's positioning cache, so skip the
    // write when nothing changed.
    private lastTop = NaN
    private lastHeight = NaN
    private lastIconOffsetY = NaN
    private lastBlockType: string | null = null
    // The icon glyph is keyed separately from `blockType` because
    // headings share one type name ("heading") across all six levels —
    // only `iconForNode` knows to differentiate them via `attrs.level`.
    // Using `blockType` alone for icon caching would freeze the
    // displayed glyph at the first heading level encountered.
    private lastIconText: string | null = null

    constructor(view: EditorView, editor: Editor) {
        this.view = view
        this.editor = editor

        this.wrapper = (view.dom.parentElement as HTMLElement) ?? view.dom
        const computed = getComputedStyle(this.wrapper)
        if (computed.position === 'static') {
            this.wrapper.style.position = 'relative'
            this.wrapperHadRelative = false
        } else {
            this.wrapperHadRelative = true
        }

        // The button is now the entire indicator area — a tall, narrow
        // element whose right border draws the visual line. The icon
        // sits at the top, and clicking anywhere on the column opens
        // the action menu. This makes the whole indicator hit-target
        // interactive rather than just the icon.
        this.btn = document.createElement('button')
        this.btn.type = 'button'
        this.btn.className = 'ezco-mde-block-action-btn'
        this.btn.style.position = 'absolute'
        this.btn.style.opacity = '0'
        this.btn.contentEditable = 'false'
        this.btn.setAttribute('aria-label', 'Block actions')
        this.btnIcon = document.createElement('span')
        this.btnIcon.className = 'ezco-mde-block-action-btn-icon'
        this.btnIcon.textContent = '·'
        this.btn.appendChild(this.btnIcon)

        this.btn.addEventListener('mousedown', (e) => {
            // Prevent ProseMirror from stealing focus before our click fires.
            e.preventDefault()
        })
        this.btn.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            // Anchor the dropdown to the click's viewport Y so the menu
            // opens near where the user clicked, rather than always at
            // the icon at the top of the button. For tall blocks (long
            // codeblocks, lists) a click near the bottom of the
            // indicator could otherwise open a menu hundreds of pixels
            // away from the cursor.
            this.openMenu('click-point', { x: e.clientX, y: e.clientY })
        })

        this.wrapper.appendChild(this.btn)

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.reposition())
            this.resizeObserver.observe(view.dom)
        }

        // Track focus moving into/out of nested editors (CodeMirror inside
        // the codeblock NodeView). These don't trigger ProseMirror state
        // updates, so without explicit listeners the indicator wouldn't
        // appear when the cursor lands inside a codeblock.
        this.onFocusChange = () => this.reposition()
        view.dom.addEventListener('focusin', this.onFocusChange)
        view.dom.addEventListener('focusout', this.onFocusChange)

        // Close the menu when the user clicks anywhere outside it (we
        // disabled Tippy's built-in `hideOnClick` to avoid spurious
        // closes during the open keystroke; this re-implements it
        // explicitly using `mousedown` so it only fires on real
        // pointer interaction).
        this.onDocumentMouseDown = (e: MouseEvent) => {
            if (!this.isOpen) return
            // Suppress the close that the same click which opened the
            // menu would otherwise trigger (mousedown for the icon
            // press happens before our open path runs).
            if (Date.now() - this.lastOpenTime < 200) return
            const target = e.target as Node | null
            if (!target) return
            if (this.activeMenu?.dom.contains(target)) return
            if (this.btn.contains(target)) return
            this.closeMenu()
        }
        document.addEventListener('mousedown', this.onDocumentMouseDown)

        // Initial position
        requestAnimationFrame(() => this.reposition())
    }

    update(view: EditorView) {
        this.view = view
        this.reposition()
    }

    destroy() {
        this.activeMenu?.destroy()
        this.activeMenu = null
        this.popup?.destroy()
        this.popup = null
        this.btn.remove()
        this.resizeObserver?.disconnect()
        this.view.dom.removeEventListener('focusin', this.onFocusChange)
        this.view.dom.removeEventListener('focusout', this.onFocusChange)
        if (this.onDocumentMouseDown) {
            document.removeEventListener('mousedown', this.onDocumentMouseDown)
            this.onDocumentMouseDown = null
        }
        if (!this.wrapperHadRelative) {
            this.wrapper.style.position = ''
        }
    }

    private hasFocusInside(): boolean {
        // `view.hasFocus()` only checks the ProseMirror editable element.
        // When focus is inside a nested NodeView (e.g. CodeMirror within
        // a codeblock), it returns false even though the user is still
        // editing the editor. Treat focus on any descendant of `view.dom`
        // as "editor is focused" so the indicator stays visible.
        if (this.view.hasFocus()) return true
        const active = document.activeElement
        if (!active || active === document.body) return false
        return this.view.dom.contains(active)
    }

    private resolveActiveBlock(): { node: PMNode; pos: number } | null {
        // When focus has been delegated to a nested NodeView (e.g.
        // clicking directly inside the codeblock's CodeMirror), the
        // NodeView typically calls `stopEvent` to keep the click from
        // propagating to ProseMirror — so PM's selection stays put on
        // whatever block was previously active. Selection-based block
        // lookup then resolves the wrong block. Trust the DOM in that
        // case: find the top-level block whose DOM contains the
        // currently focused element.
        const active = document.activeElement
        if (
            active &&
            active !== document.body &&
            active !== this.view.dom &&
            this.view.dom.contains(active)
        ) {
            const fromDom = this.findTopLevelBlockContaining(active)
            if (fromDom) return fromDom
        }

        const { state } = this.view
        const { selection } = state
        // A `NodeSelection` is what ProseMirror uses when a top-level
        // atom-like block (a codeblock NodeView, an image, an hr, etc.)
        // is the "active" element. Its $from has depth 0, so the usual
        // `$from.node(1)` lookup throws. Handle it explicitly.
        if (selection instanceof NodeSelection) {
            return { node: selection.node, pos: selection.from }
        }
        const { $from } = selection
        if ($from.depth < 1) return null
        return { node: $from.node(1), pos: $from.before(1) }
    }

    private findTopLevelBlockContaining(
        element: Element,
    ): { node: PMNode; pos: number } | null {
        const doc = this.view.state.doc
        let foundPos = -1
        let foundNode: PMNode | null = null
        doc.forEach((child, offset) => {
            if (foundPos >= 0) return
            const dom = this.view.nodeDOM(offset) as HTMLElement | null
            if (dom && typeof dom.contains === 'function' && dom.contains(element)) {
                foundPos = offset
                foundNode = child
            }
        })
        if (foundNode !== null && foundPos >= 0) {
            return { node: foundNode, pos: foundPos }
        }
        return null
    }

    private reposition() {
        if (!this.hasFocusInside()) {
            this.btn.style.opacity = '0'
            return
        }

        const resolved = this.resolveActiveBlock()
        if (!resolved) {
            this.btn.style.opacity = '0'
            return
        }
        const { node: blockNode, pos: blockPos } = resolved

        const dom = this.view.nodeDOM(blockPos) as HTMLElement | null
        if (!dom || typeof dom.getBoundingClientRect !== 'function') {
            // Hydration may not be ready yet; retry next frame.
            requestAnimationFrame(() => this.reposition())
            return
        }

        const wrapperRect = this.wrapper.getBoundingClientRect()
        const blockRect = dom.getBoundingClientRect()
        const top = blockRect.top - wrapperRect.top + this.wrapper.scrollTop
        const height = blockRect.height

        // Natural alignment with the block's first text line. The
        // sticky-on-scroll behaviour is handled by CSS
        // (`position: sticky; top: 8px` on `.ezco-mde-block-action-btn-icon`)
        // — the browser does the math on the compositor thread, so
        // we don't need JS scroll listeners to track viewport position.
        const iconOffsetY = computeIconOffsetY(dom)

        // Only write inline styles that actually changed. Writing the
        // same `top`/`padding-top` on every focus event is enough to
        // invalidate the sticky child's positioning state (the browser
        // sees a style mutation on the containing block and may
        // recompute), which manifests as the icon "freezing" at its
        // last sticky offset until the next real scroll/click cycle.
        if (top !== this.lastTop) {
            this.btn.style.top = `${top}px`
            this.lastTop = top
        }
        if (height !== this.lastHeight) {
            this.btn.style.height = `${height}px`
            this.lastHeight = height
        }
        if (iconOffsetY !== this.lastIconOffsetY) {
            this.btn.style.setProperty(
                '--ezco-mde-block-action-icon-offset-y',
                `${iconOffsetY}px`,
            )
            this.lastIconOffsetY = iconOffsetY
        }
        // Position so the vertical indicator line (the button's right
        // border) sits 8px away from the editor content — matching the
        // 8px `padding-right` between the icon and that same line.
        if (this.btn.style.left !== '-42px') this.btn.style.left = '-42px'
        if (this.btn.style.opacity !== '1') this.btn.style.opacity = '1'
        const blockTypeName = blockNode.type.name
        if (blockTypeName !== this.lastBlockType) {
            this.btn.dataset.blockType = blockTypeName
            this.lastBlockType = blockTypeName
        }
        // Icon glyph is keyed by the icon string, not the type name —
        // see the comment on `lastIconText`. Updating only when the
        // glyph actually changes also avoids spurious textContent
        // writes that could invalidate the sticky child's layout.
        const iconText = iconForNode(blockNode)
        if (iconText !== this.lastIconText) {
            this.btnIcon.textContent = iconText
            this.lastIconText = iconText
        }

        this.activeNode = blockNode
        this.activePos = blockPos
    }

    /** Public entry point for opening the action menu. Called both by
     *  the button's own click handler and by the `Mod-/` keyboard
     *  shortcut. Re-resolves the active block first so a keyboard
     *  invocation works even if the user hasn't clicked into the block
     *  yet (e.g. typing into a paragraph and hitting Mod-/).
     *
     *  `at` controls where the dropdown anchors:
     *  - `'icon'` (click invocations): next to the indicator icon —
     *    visually tied to the affordance the user clicked.
     *  - `'cursor'` (keyboard invocations): next to the text cursor —
     *    so the menu appears where the user is *looking* when they
     *    invoke it via keyboard, not at an indicator they may not have
     *    interacted with directly. */
    public openMenu(
        at: 'icon' | 'cursor' | 'click-point' = 'icon',
        clickPoint?: { x: number; y: number },
    ) {
        // Re-entry guard: ignore a second openMenu within 200ms of the
        // first. This fixes the "first Mod-/ press opens then
        // immediately closes" bug where the same keydown event was
        // somehow producing a second openMenu invocation (synthesized
        // click on the focused button, double-dispatched keymap, etc.)
        // and the toggle branch was hiding the menu we'd just opened.
        const now = Date.now()
        if (this.isOpen) {
            if (now - this.lastOpenTime < 200) return
            this.closeMenu()
            return
        }
        this.isOpen = true
        this.lastOpenTime = now
        // Snapshot the editor selection BEFORE we move focus into the
        // menu. Esc-close uses this to put the cursor back exactly
        // where the user was.
        this.savedSelection = this.editor.state.selection

        // Refresh active-block resolution; the keyboard path doesn't go
        // through the usual update/reposition cycle.
        this.refreshActiveBlock()
        if (!this.activeNode || this.activePos < 0) return
        const actions = actionsForNode(this.activeNode)
        const activeNode = this.activeNode
        const activePos = this.activePos

        const menu = new ContextMenu({
            className: 'ezco-mde-block-action-menu',
            items: actions.map((action) => ({
                label: action.label,
                icon: action.icon,
                onSelect: () => {
                    // Action runs its own `.focus()` chain, which
                    // re-focuses the editor at the (possibly changed)
                    // selection — so we don't need `restoreEditorFocus`
                    // here, just close.
                    this.closeMenu()
                    action.run({
                        editor: this.editor,
                        pos: activePos,
                        node: activeNode,
                    })
                    // Belt-and-suspenders: ensure the editor regains
                    // focus regardless of how the action was
                    // implemented. Actions that already chained
                    // `.focus()` no-op here; raw-dispatch actions
                    // (which would otherwise leave focus stranded on
                    // the now-destroyed menu item) get rescued.
                    this.editor.view.focus()
                },
            })),
            onClose: () => this.closeMenu({ restoreEditorFocus: true }),
        })
        this.activeMenu = menu

        if (this.popup) {
            this.popup.destroy()
            this.popup = null
        }

        this.popup = tippy(this.btn, {
            content: menu.dom,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
            theme: 'ezco-mde-block-actions',
            appendTo: () => document.body,
            // Anchor selection:
            //  - `'cursor'`  → editor's text cursor (keyboard invoke).
            //  - `'click-point'` → click's viewport Y, horizontally
            //    aligned with the icon column. This keeps the menu's
            //    horizontal position consistent across clicks while
            //    putting it vertically near where the user clicked,
            //    rather than at the top of a tall block.
            //  - `'icon'` (default) → the indicator icon at the top of
            //    the button (used for non-click invocations).
            getReferenceClientRect:
                at === 'cursor'
                    ? () => this.getCursorRect()
                    : at === 'click-point' && clickPoint
                        ? () => {
                            const iconRect = this.btnIcon.getBoundingClientRect()
                            // Zero-height rect at the click's Y, horizontally
                            // matching the icon's column. With Tippy's
                            // `placement: 'bottom-start'`, the menu opens
                            // just below this point.
                            return new DOMRect(
                                iconRect.left,
                                clickPoint.y,
                                iconRect.width,
                                0,
                            )
                        }
                        : () => this.btnIcon.getBoundingClientRect(),
            // Tippy's default `hideOnClick: true` registers a
            // document-level pointerdown listener even when
            // `trigger: 'manual'` is set, and that listener has been
            // closing the popup on the same keystroke that opened it
            // (the `Mod-/` keydown → mousedown synthesis on some
            // browsers, or stray pointer events fired during focus
            // movement). Disable it; we close explicitly via Escape
            // (handled by `ContextMenu`), item selection, or click
            // outside (handled by `documentMousedownToClose` below).
            hideOnClick: false,
            // Move focus onto the first item once Tippy has finished
            // its open transition (the item needs to be in the DOM
            // for `.focus()` to take effect). The keyboard listener
            // is wired up below — *before* `show()` — so Escape and
            // arrow keys work even during the open animation.
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
        // Attach the document keydown listener BEFORE show() so that
        // Escape and arrow keys work the moment the menu starts to
        // appear — not only after Tippy's open animation completes
        // (which is when `onShown` fires, hundreds of ms later).
        menu.enable()
        this.popup.show()
    }

    /** Compute a DOMRect at the editor's current cursor position. Used
     *  as Tippy's reference rect when the menu is opened via the
     *  keyboard shortcut. */
    private getCursorRect(): DOMRect {
        try {
            const { from } = this.editor.state.selection
            const coords = this.editor.view.coordsAtPos(from)
            return new DOMRect(
                coords.left,
                coords.top,
                1,
                Math.max(1, coords.bottom - coords.top),
            )
        } catch {
            return this.btnIcon.getBoundingClientRect()
        }
    }

    public closeMenu(opts: { restoreEditorFocus?: boolean } = {}) {
        if (!this.isOpen) return
        this.isOpen = false
        if (opts.restoreEditorFocus && this.savedSelection) {
            // Re-dispatch the captured selection BEFORE focusing. If we
            // only called `editor.view.focus()` the editor would sync
            // its `state.selection` from the current DOM selection,
            // which is wherever the menu placed it — losing the
            // original cursor position. Dispatching first plus
            // focusing puts the cursor exactly where the user left it.
            try {
                const tr = this.editor.state.tr.setSelection(this.savedSelection)
                this.editor.view.dispatch(tr)
            } catch {
                // Selection is no longer valid (doc shape changed) —
                // ignore, just focus the editor.
            }
            this.editor.view.focus()
        }
        this.savedSelection = null
        this.popup?.hide()
    }

    /** Recompute the active block from the current focus + selection.
     *  Cheap wrapper around `resolveActiveBlock` so callers outside the
     *  reposition cycle (the keyboard shortcut) can update state. */
    private refreshActiveBlock() {
        const resolved = this.resolveActiveBlock()
        if (resolved) {
            this.activeNode = resolved.node
            this.activePos = resolved.pos
        }
    }
}

interface BlockActionsStorage {
    blockActionsView: BlockActionsView | null
}

export const BlockActions = Extension.create<unknown, BlockActionsStorage>({
    name: 'blockActions',

    addStorage() {
        return {
            // Set by the plugin view's constructor. The keyboard
            // shortcut below uses this to dispatch into the active
            // view's `openMenu` without going through ProseMirror state.
            blockActionsView: null,
        }
    },

    addProseMirrorPlugins() {
        const editor = this.editor
        const storage = this.storage
        return [
            new Plugin({
                key: new PluginKey('blockActions'),
                view: (view) => {
                    const blockView = new BlockActionsView(view, editor)
                    storage.blockActionsView = blockView
                    const origDestroy = blockView.destroy.bind(blockView)
                    blockView.destroy = () => {
                        storage.blockActionsView = null
                        origDestroy()
                    }
                    return blockView
                },
            }),
        ]
    },

    addKeyboardShortcuts() {
        return {
            // `Mod-/` = Cmd+/ on macOS, Ctrl+/ everywhere else. Opens
            // the block-action dropdown anchored to the *cursor* (not
            // the indicator), so the menu appears where the user is
            // looking when they invoke it via keyboard. Toggles when
            // already open. (Doesn't fire while focus is inside the
            // codeblock's CodeMirror, since that intercepts the
            // keystroke — there, click the indicator instead.)
            'Mod-/': () => {
                const view = this.storage.blockActionsView
                if (!view) return false
                view.openMenu('cursor')
                return true
            },
        }
    },
})
