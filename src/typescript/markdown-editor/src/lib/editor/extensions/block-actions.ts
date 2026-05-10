import { Editor, Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import tippy, { Instance as TippyInstance } from 'tippy.js'

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

function actionsForNode(node: PMNode): BlockAction[] {
    const remove: BlockAction = {
        label: 'Delete',
        icon: '✕',
        run: ({ editor, pos, node }) => {
            const tr = editor.state.tr.delete(pos, pos + node.nodeSize)
            editor.view.dispatch(tr)
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
                { label: 'Ordered list', icon: '1.', run: ({ editor }) => editor.chain().focus().toggleOrderedList().run() },
                { label: 'Task list', icon: '☐', run: ({ editor }) => editor.chain().focus().toggleTaskList().run() },
                { label: 'Lift to paragraph', icon: '¶', run: ({ editor }) => editor.chain().focus().liftListItem('listItem').run() },
                remove,
            ]
        case 'orderedList':
            return [
                { label: 'Bullet list', icon: '•', run: ({ editor }) => editor.chain().focus().toggleBulletList().run() },
                { label: 'Task list', icon: '☐', run: ({ editor }) => editor.chain().focus().toggleTaskList().run() },
                { label: 'Lift to paragraph', icon: '¶', run: ({ editor }) => editor.chain().focus().liftListItem('listItem').run() },
                remove,
            ]
        case 'taskList':
            return [
                { label: 'Bullet list', icon: '•', run: ({ editor }) => editor.chain().focus().toggleBulletList().run() },
                { label: 'Ordered list', icon: '1.', run: ({ editor }) => editor.chain().focus().toggleOrderedList().run() },
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
                toParagraph,
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
    private indicator: HTMLDivElement
    private btn: HTMLButtonElement
    private btnIcon: HTMLSpanElement
    private popup: TippyInstance | null = null
    private resizeObserver: ResizeObserver | null = null
    private activeNode: PMNode | null = null
    private activePos = -1
    private wrapperHadRelative = false

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

        this.indicator = document.createElement('div')
        this.indicator.className = 'ezco-mde-block-indicator'
        this.indicator.style.position = 'absolute'
        this.indicator.style.pointerEvents = 'none'
        this.indicator.style.opacity = '0'
        this.indicator.setAttribute('aria-hidden', 'true')

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
            e.preventDefault()
        })
        this.btn.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            this.openMenu()
        })

        this.wrapper.appendChild(this.indicator)
        this.wrapper.appendChild(this.btn)

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.reposition())
            this.resizeObserver.observe(view.dom)
        }

        // Initial position
        requestAnimationFrame(() => this.reposition())
    }

    update(view: EditorView) {
        this.view = view
        this.reposition()
    }

    destroy() {
        this.popup?.destroy()
        this.popup = null
        this.indicator.remove()
        this.btn.remove()
        this.resizeObserver?.disconnect()
        if (!this.wrapperHadRelative) {
            this.wrapper.style.position = ''
        }
    }

    private reposition() {
        const view = this.view
        if (!view.hasFocus()) {
            this.indicator.style.opacity = '0'
            this.btn.style.opacity = '0'
            return
        }

        const { state } = view
        const { $from } = state.selection
        if ($from.depth < 1) {
            this.indicator.style.opacity = '0'
            this.btn.style.opacity = '0'
            return
        }

        const blockNode = $from.node(1)
        const blockPos = $from.before(1)
        const dom = view.nodeDOM(blockPos) as HTMLElement | null
        if (!dom || typeof dom.getBoundingClientRect !== 'function') {
            // Hydration may not be ready yet; retry next frame.
            requestAnimationFrame(() => this.reposition())
            return
        }

        const wrapperRect = this.wrapper.getBoundingClientRect()
        const blockRect = dom.getBoundingClientRect()
        const top = blockRect.top - wrapperRect.top + this.wrapper.scrollTop
        const height = blockRect.height

        this.indicator.style.top = `${top}px`
        this.indicator.style.height = `${height}px`
        this.indicator.style.left = '-12px'
        this.indicator.style.opacity = '1'

        this.btn.style.top = `${top}px`
        this.btn.style.left = '-44px'
        this.btn.style.opacity = '1'
        this.btn.dataset.blockType = blockNode.type.name
        this.btnIcon.textContent = iconForNode(blockNode)

        this.activeNode = blockNode
        this.activePos = blockPos
    }

    private openMenu() {
        if (!this.activeNode || this.activePos < 0) return
        const actions = actionsForNode(this.activeNode)

        const menu = document.createElement('div')
        menu.className = 'ezco-mde-block-action-menu'

        actions.forEach((action) => {
            const item = document.createElement('button')
            item.type = 'button'
            item.className = 'ezco-mde-block-action-item'
            const icon = document.createElement('span')
            icon.className = 'ezco-mde-block-action-item-icon'
            icon.textContent = action.icon
            const label = document.createElement('span')
            label.className = 'ezco-mde-block-action-item-label'
            label.textContent = action.label
            item.appendChild(icon)
            item.appendChild(label)
            item.addEventListener('click', () => {
                this.popup?.hide()
                if (!this.activeNode || this.activePos < 0) return
                action.run({ editor: this.editor, pos: this.activePos, node: this.activeNode })
            })
            menu.appendChild(item)
        })

        if (this.popup) {
            this.popup.destroy()
            this.popup = null
        }

        this.popup = tippy(this.btn, {
            content: menu,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
            theme: 'ezco-mde-block-actions',
            appendTo: () => document.body,
            onHide: () => {
                setTimeout(() => {
                    this.popup?.destroy()
                    this.popup = null
                }, 0)
            },
        }) as TippyInstance
        this.popup.show()
    }
}

export const BlockActions = Extension.create({
    name: 'blockActions',

    addProseMirrorPlugins() {
        const editor = this.editor
        return [
            new Plugin({
                key: new PluginKey('blockActions'),
                view: (view) => new BlockActionsView(view, editor),
            }),
        ]
    },
})
