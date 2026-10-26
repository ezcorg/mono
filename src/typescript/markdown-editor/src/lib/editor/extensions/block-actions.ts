import { Editor, Extension } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { caretRect, menuPopover, type Popover } from '../ui/popover'
import { ContextMenu, sectioned, type ContextMenuEntry } from '../ui/context-menu'
import { foldsOf, type Fold } from './folding'
import { CALLOUT_KINDS, calloutIcon, calloutType } from './callout'
import { button, el, labelled, pressable } from '../ui/dom'
import { observeResize, rafThrottle, resolveMount, type Mount } from '../ui/layout'

/** Where the block-action indicator should mount (same shape as the toolbar /
 *  sidebar `mount`). */
export type BlockActionsMount = Mount

export interface BlockActionsOptions {
    /**
     * Render the indicator into a dedicated element instead of overlaying it in
     * the editor's left gutter. With a mount, the button lives *inside* that
     * element (a fixed-width "block action" column) and is right-aligned so its
     * indicator line hugs the editor — so it never overlaps a sidebar, and the
     * host reserves its width via layout instead of the editor accounting for
     * the indicator's size by hand.
     *
     * The mount should be a sibling laid out in the same row + scroll container
     * as the editor, so the button's vertical position tracks the active block.
     * An element, or a function of the editor's root returning one (returning
     * nothing keeps the overlay).
     */
    mount?: BlockActionsMount
}

export interface BlockAction {
    label: string
    icon: string
    /** The section of the menu it stands in ("Turn into", "List", "Rows";
     *  "Block" for what any block can do), under a heading; none for an
     *  item on its own at the top. */
    section?: string
    /** A setting rather than an action: on or off, shown as a switch. */
    checked?: boolean
    /** One of a set of choices (a callout's kind): the one in force has a check. */
    selected?: boolean
    run: (ctx: { editor: Editor; pos: number; node: PMNode }) => void
}

/** The glyph of "Fold" in the menus. */
const FOLD_ICON = '▸'

/** A fold's glyph in the gutter (folding.ts): a chevron at its head's first
 *  line, as a code editor marks a folded line. Pressed, it opens the fold. */
const CHEVRON_ICON =
    '<svg class="ezco-mde-block-icon-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** The glyph of "Callout" where a block can become one: the `!` of `[!kind]`. */
const CALLOUT_ICON = '!'

/** The kinds a callout's menu offers directly (the rest through "Other kind…"). */
const COMMON_KINDS = ['note', 'tip', 'info', 'warning', 'danger', 'example', 'quote']

const TYPE_ICONS: Record<string, string> = {
    frontMatter: '---',
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

/** A task list's glyph in the gutter: a box the size of its checkboxes
 *  (`--ezco-mde-checkbox-size`, an em of the list's text, which the glyph
 *  is set in). */
const TASK_ICON =
    '<svg class="ezco-mde-block-icon-box" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'

/** A paragraph's glyph in the gutter: a pilcrow drawn as tall as the
 *  text's capitals (`--ezco-mde-block-icon-cap`, measured from the face),
 *  standing on the text's baseline: it is set inline on a line of the
 *  text's own, which the glyph's font makes. The face's own ¶ would hang
 *  below the line, as a descender does. */
const PARA_ICON =
    '<span class="ezco-mde-block-icon-line"><svg viewBox="1.5 0 10.5 16" aria-hidden="true"><path d="M12 0v16h-2V2H8v14H6V9a4.5 4.5 0 1 1 0-9z"/></svg></span>'

/** How tall the capitals of text set in `font` are, from the face itself.
 *  Measured once per font; again once the faces have loaded. */
const caps = new Map<string, number>()
let capsCanvas: CanvasRenderingContext2D | null | undefined
if (typeof document !== 'undefined') document.fonts?.addEventListener('loadingdone', () => caps.clear())
function capHeight(font: string): number {
    let cap = caps.get(font)
    if (cap === undefined) {
        capsCanvas ??= document.createElement('canvas').getContext('2d')
        if (capsCanvas) {
            capsCanvas.font = font
            cap = capsCanvas.measureText('H').actualBoundingBoxAscent
        }
        if (!cap || !Number.isFinite(cap)) cap = (parseFloat(font) || 16) * 0.7
        caps.set(font, cap)
    }
    return cap
}

/** The types whose glyph is the block's own first marker (or its text's
 *  pilcrow), set in the text's face and size so the two read as one. */
const TEXTUAL = new Set(['paragraph', 'bulletList', 'orderedList', 'taskList', 'blockquote'])

/** What stands for `node` in the gutter: a heading's level, a list's first
 *  marker as the list draws it (`•`, `–`, `3.`, `b)`), a box for a task
 *  list, the type's glyph otherwise. */
function iconForNode(node: PMNode): string {
    const attrs = node.attrs as { level?: number; marker?: string; start?: number; type?: string; delimiter?: string }
    switch (node.type.name) {
        case 'heading':
            return `H${attrs.level ?? 1}`
        case 'bulletList':
            return attrs.marker === 'dash' ? '–' : '•'
        case 'orderedList':
            return `${orderedMarker(attrs.start ?? 1, attrs.type ?? null)}${attrs.delimiter ?? '.'}`
        case 'callout':
            // The kind's own icon, as the callout draws it before its title.
            return calloutIcon((attrs as { kind?: string }).kind ?? 'note')
        default:
            return TYPE_ICONS[node.type.name] ?? '·'
    }
}

/** `n` as an ordered list of `type` counts it: `3`, `c`, `C`. */
function orderedMarker(n: number, type: string | null): string {
    if (type !== 'a' && type !== 'A') return String(n)
    let s = ''
    for (let k = Math.max(1, n); k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s
    return type === 'A' ? s.toUpperCase() : s
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
    return firstTextLine(root)?.rect ?? null
}

/** The first character of the first text in `root`: its rect, and the
 *  element it is set in. */
function firstTextLine(root: HTMLElement): { rect: DOMRect; element: HTMLElement } | null {
    if (typeof document === 'undefined') return null
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return node.textContent && node.textContent.trim().length > 0
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT
        },
    } as NodeFilter)
    const textNode = walker.nextNode() as Text | null
    if (!textNode || !textNode.textContent || !textNode.parentElement) return null
    try {
        const range = document.createRange()
        range.setStart(textNode, 0)
        range.setEnd(textNode, Math.min(1, textNode.textContent.length))
        // Prefer the first client rect over the union bounding box so
        // we don't pick up a wrapped second line's height.
        const rects = range.getClientRects()
        const rect = rects.length > 0 ? (rects[0] as DOMRect) : range.getBoundingClientRect()
        return { rect, element: textNode.parentElement }
    } catch {
        return null
    }
}

/** The box of a block's first line: where it is and how tall (the line
 *  box, leading included), and the face it is set in: those of the block
 *  the first text is laid out in (a `p`, not the `strong` the text may
 *  start with), whose first line starts at the top of its content. Not
 *  the first character's box: an engine splits a line's leading to the
 *  pixel, so the character can stand half a pixel off the line's middle,
 *  and a glyph centred on it stood that much off the text. Null for a
 *  block with no text. */
function firstLineBox(dom: HTMLElement): { top: number; height: number; font: string } | null {
    const line = firstTextLine(dom)
    const element = line?.element ?? (dom.matches('p, h1, h2, h3, h4, h5, h6, li, blockquote, ul, ol') ? findFirstTextElement(dom) : null)
    if (!element) return null
    const block = blockOf(element, dom)
    const computed = getComputedStyle(block)
    const fontSize = parseFloat(computed.fontSize) || 16
    let lineHeight = parseFloat(computed.lineHeight)
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) lineHeight = fontSize * 1.2
    const top = block.getBoundingClientRect().top + (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.paddingTop) || 0)
    return { top, height: lineHeight, font: `${fontSize}px/${lineHeight}px ${computed.fontFamily}` }
}

/** The displays that lay their text out in lines of their own. */
const LINE_BOXES = new Set(['block', 'list-item', 'flex', 'grid', 'flow-root', 'table-cell', 'table-caption'])

/** The element whose lines `element` is laid out in: itself, or the
 *  nearest ancestor within `root` that makes line boxes (an inline, or an
 *  inline-block such as a chip, does not). */
function blockOf(element: HTMLElement, root: HTMLElement): HTMLElement {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        if (node === root || LINE_BOXES.has(getComputedStyle(node).display)) return node
    }
    return root
}

/** How big a task list draws its checkboxes, to draw the box the same. */
function checkboxSize(dom: HTMLElement): number | null {
    const box = dom.querySelector<HTMLElement>(':scope > li > label > input')?.getBoundingClientRect()
    return box?.height ? box.height : null
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
    listAttrs: Record<string, unknown> = {},
): void {
    const { state } = editor
    const { schema } = state
    const rebuilt = rebuildListNode(node, targetListType, schema, listAttrs)
    if (!rebuilt) return
    const { from, to } = state.selection
    const tr = state.tr.replaceRangeWith(pos, pos + node.nodeSize, rebuilt)
    // The rebuilt list has the old one's shape (items of another kind hold
    // the same content), so the caret's positions mean the same place in
    // it: put it back there, rather than after the list, where the
    // replacement's mapping sends it.
    if (from >= pos && to <= pos + node.nodeSize && rebuilt.nodeSize === node.nodeSize) {
        tr.setSelection(TextSelection.between(tr.doc.resolve(from), tr.doc.resolve(to)))
    }
    editor.view.dispatch(tr)
}

function rebuildListNode(
    listNode: PMNode,
    targetListType: ListTypeName,
    schema: PMNode['type']['schema'],
    listAttrs: Record<string, unknown> = {},
): PMNode | null {
    const listType = schema.nodes[targetListType]
    const itemTypeName = targetListType === 'taskList' ? 'taskItem' : 'listItem'
    const itemType = schema.nodes[itemTypeName]
    if (!listType || !itemType) return null

    const items: PMNode[] = []
    listNode.forEach((child) => {
        // child is a listItem or taskItem in the source list. Map its
        // content node-by-node so any nested lists are recursively
        // rebuilt as the same target type (and same attrs, e.g. the dash
        // marker, so the whole tree converts consistently).
        const newChildren: PMNode[] = []
        child.forEach((grandchild) => {
            if (isListType(grandchild.type.name)) {
                const rebuilt = rebuildListNode(grandchild, targetListType, schema, listAttrs)
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

    return listType.create(listAttrs, Fragment.from(items))
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

/** Whether a comment can be written in `editor` (there is an author). */
function canComment(editor: Editor | undefined): boolean {
    return !!(editor?.storage as { comments?: { author?: () => string | null } } | undefined)?.comments?.author?.()
}

/**
 * What a block's menu offers: what its type can become or do, then what
 * any block can: a comment on it (the block quoted, the composer by it)
 * and folding it to one line; Delete last.
 */
export function actionsForNode(node: PMNode, editor?: Editor): BlockAction[] {
    const actions = typeActions(node, editor)
    const extras: BlockAction[] = []
    const name = node.type.name
    if (canComment(editor) && name !== 'frontMatter') {
        extras.push({
            label: 'Comment',
            icon: '❝',
            section: BLOCK,
            run: ({ editor, pos, node }) => {
                const { doc } = editor.state
                const selection = node.isLeaf || node.isAtom ? NodeSelection.create(doc, pos) : TextSelection.between(doc.resolve(pos + 1), doc.resolve(pos + node.nodeSize - 1))
                editor.view.dispatch(editor.state.tr.setSelection(selection))
                editor.commands.startComment()
            },
        })
    }
    if (name !== 'frontMatter' && name !== 'horizontalRule') {
        // A heading folds its section; any other block, itself (folding.ts).
        extras.push({ label: 'Fold', icon: FOLD_ICON, section: BLOCK, run: ({ editor, pos }) => editor.commands.foldBlock(pos) })
    }
    if (!extras.length) return actions
    const last = actions[actions.length - 1]
    return last?.label.startsWith('Delete') ? [...actions.slice(0, -1), ...extras, last] : [...actions, ...extras]
}

/** The sections a block's menu is divided into, by what an action is for:
 *  what the block can become, what its own kind can do (a list's markers,
 *  a table's rows), and what any block can (`BLOCK`, last). */
const TURN_INTO = 'Turn into'
const BLOCK = 'Block'

function typeActions(node: PMNode, editor?: Editor): BlockAction[] {
    const remove: BlockAction = {
        label: 'Delete',
        icon: '✕',
        section: BLOCK,
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
        section: TURN_INTO,
        run: ({ editor }) => editor.chain().focus().setParagraph().run(),
    }

    /** `action` in the "Turn into" section. */
    const into = (label: string, icon: string, run: BlockAction['run']): BlockAction => ({ label, icon, section: TURN_INTO, run })

    switch (node.type.name) {
        case 'frontMatter': {
            // The note's properties: open them, add one, choose whether they
            // fold away when not being edited (a switch), or drop them. The
            // same list whether the YAML is open, folded or being typed in:
            // nothing here turns into a heading or a paragraph.
            const folds = (editor?.storage as { frontMatter?: { autoCollapse: boolean } } | undefined)?.frontMatter?.autoCollapse ?? true
            return [
                { label: 'Edit properties', icon: '✎', section: 'Properties', run: ({ editor }) => editor.commands.editFrontMatter() },
                { label: 'Add property', icon: '+', section: 'Properties', run: ({ editor }) => editor.commands.addFrontMatterProperty() },
                { label: 'Collapse when not editing', icon: '⇅', section: 'Properties', checked: folds, run: ({ editor }) => editor.commands.setFrontMatterAutoCollapse(!folds) },
                remove,
            ]
        }
        case 'paragraph':
            return [
                into('Heading 1', 'H1', ({ editor }) => editor.chain().focus().setHeading({ level: 1 }).run()),
                into('Heading 2', 'H2', ({ editor }) => editor.chain().focus().setHeading({ level: 2 }).run()),
                into('Heading 3', 'H3', ({ editor }) => editor.chain().focus().setHeading({ level: 3 }).run()),
                into('Bullet list', '•', ({ editor }) => editor.chain().focus().toggleBulletList().updateAttributes('bulletList', { marker: 'bullet' }).run()),
                into('Dashed list', '–', ({ editor }) => editor.chain().focus().toggleBulletList().updateAttributes('bulletList', { marker: 'dash' }).run()),
                into('Numbered list', '1.', ({ editor }) => editor.chain().focus().toggleOrderedList().updateAttributes('orderedList', { type: null }).run()),
                into('Lettered list', 'a.', ({ editor }) => editor.chain().focus().toggleOrderedList().updateAttributes('orderedList', { type: 'a' }).run()),
                into('Task list', '☐', ({ editor }) => editor.chain().focus().toggleTaskList().run()),
                into('Quote', '"', ({ editor }) => editor.chain().focus().toggleBlockquote().run()),
                into('Callout', CALLOUT_ICON, ({ editor }) => editor.chain().focus().chooseCalloutKind().run()),
                remove,
            ]
        case 'heading': {
            const current = (node.attrs as { level?: number }).level ?? 1
            const levels: Array<1 | 2 | 3 | 4 | 5 | 6> = [1, 2, 3, 4, 5, 6]
            return [
                ...levels
                    .filter((l) => l !== current)
                    .map<BlockAction>((l) => into(`Heading ${l}`, `H${l}`, ({ editor }) => editor.chain().focus().setHeading({ level: l }).run())),
                toParagraph,
                remove,
            ]
        }
        case 'bulletList': {
            // Offer the *other* marker so a bullet (•) list can become a
            // dashed (–) list and vice-versa: the list's own affair, not a
            // conversion.
            const isDash = (node.attrs as { marker?: string }).marker === 'dash'
            const markerSwap: BlockAction = isDash
                ? { label: 'Bullet list', icon: '•', section: 'List', run: ({ editor, pos, node }) => convertList(editor, pos, node, 'bulletList', { marker: 'bullet' }) }
                : { label: 'Dashed list', icon: '–', section: 'List', run: ({ editor, pos, node }) => convertList(editor, pos, node, 'bulletList', { marker: 'dash' }) }
            return [
                into('Numbered list', '1.', ({ editor, pos, node }) => convertList(editor, pos, node, 'orderedList')),
                into('Lettered list', 'a.', ({ editor, pos, node }) => convertList(editor, pos, node, 'orderedList', { type: 'a' })),
                into('Task list', '☐', ({ editor, pos, node }) => convertList(editor, pos, node, 'taskList')),
                markerSwap,
                { label: 'Lift to paragraphs', icon: '¶', section: 'List', run: ({ editor, pos, node }) => liftListToParagraphs(editor, pos, node) },
                remove,
            ]
        }
        case 'orderedList': {
            // Numbers or letters: the other is offered.
            const lettered = (node.attrs as { type?: string | null }).type === 'a' || (node.attrs as { type?: string | null }).type === 'A'
            const countSwap: BlockAction = lettered
                ? { label: 'Numbered list', icon: '1.', section: 'List', run: ({ editor, pos, node }) => convertList(editor, pos, node, 'orderedList', { ...node.attrs, type: null }) }
                : { label: 'Lettered list', icon: 'a.', section: 'List', run: ({ editor, pos, node }) => convertList(editor, pos, node, 'orderedList', { ...node.attrs, type: 'a' }) }
            return [
                into('Bullet list', '•', ({ editor, pos, node }) => convertList(editor, pos, node, 'bulletList', { marker: 'bullet' })),
                into('Dashed list', '–', ({ editor, pos, node }) => convertList(editor, pos, node, 'bulletList', { marker: 'dash' })),
                into('Task list', '☐', ({ editor, pos, node }) => convertList(editor, pos, node, 'taskList')),
                countSwap,
                { label: 'Lift to paragraphs', icon: '¶', section: 'List', run: ({ editor, pos, node }) => liftListToParagraphs(editor, pos, node) },
                remove,
            ]
        }
        case 'taskList': {
            const markAll = (checked: boolean) => ({ editor, pos, node }: Parameters<BlockAction['run']>[0]) => {
                const tr = editor.state.tr
                node.descendants((child, offset) => {
                    if (child.type.name === 'taskItem') {
                        tr.setNodeMarkup(pos + 1 + offset, undefined, { ...child.attrs, checked })
                    }
                    return true
                })
                editor.view.dispatch(tr)
            }
            return [
                into('Bullet list', '•', ({ editor, pos, node }) => convertList(editor, pos, node, 'bulletList', { marker: 'bullet' })),
                into('Dashed list', '–', ({ editor, pos, node }) => convertList(editor, pos, node, 'bulletList', { marker: 'dash' })),
                into('Numbered list', '1.', ({ editor, pos, node }) => convertList(editor, pos, node, 'orderedList')),
                into('Lettered list', 'a.', ({ editor, pos, node }) => convertList(editor, pos, node, 'orderedList', { type: 'a' })),
                { label: 'Mark all complete', icon: '☑', section: 'Tasks', run: markAll(true) },
                { label: 'Mark all incomplete', icon: '☐', section: 'Tasks', run: markAll(false) },
                { label: 'Lift to paragraphs', icon: '¶', section: 'List', run: ({ editor, pos, node }) => liftListToParagraphs(editor, pos, node) },
                remove,
            ]
        }
        case 'blockquote':
            return [
                {
                    label: 'Unwrap quote',
                    icon: '⇤',
                    section: 'Quote',
                    // Lift the *entire* quote's content out, not just the
                    // block under the cursor — replace the blockquote node
                    // with its children.
                    run: ({ editor, pos, node }) => {
                        const { state } = editor
                        const { from, to } = state.selection
                        const tr = state.tr.replaceWith(
                            pos,
                            pos + node.nodeSize,
                            node.content,
                        )
                        // Preserve the caret. `replaceWith` treats the quote as
                        // delete+insert, so `tr.mapping` would collapse a caret
                        // inside it to the content boundary. Removing the single
                        // blockquote wrapper token shifts every interior
                        // position left by exactly 1, so map by that instead.
                        const clamp = (p: number) =>
                            Math.min(Math.max(p - 1, 0), tr.doc.content.size)
                        try {
                            tr.setSelection(
                                TextSelection.between(
                                    tr.doc.resolve(clamp(from)),
                                    tr.doc.resolve(clamp(to)),
                                ),
                            )
                        } catch {
                            /* doc shape changed too much — keep PM's mapping */
                        }
                        editor.view.dispatch(tr)
                        editor.view.focus()
                    },
                },
                // A callout of the quote's blocks (the kind asked for, at its title).
                into('Callout', CALLOUT_ICON, ({ editor, pos }) =>
                    editor.chain().focus(pos + 1).setCallout('note').chooseCalloutKind(pos).run(),
                ),
                toParagraph,
                remove,
            ]
        case 'callout': {
            // The common kinds to choose from directly, the one in force
            // checked, and the menu of every kind for the rest; whether it
            // folds; a quote or plain blocks instead.
            const kind = calloutType((node.attrs as { kind: string }).kind)
            const kinds = CALLOUT_KINDS.filter((k) => COMMON_KINDS.includes(k.type)).map<BlockAction>((k) => ({
                label: k.label,
                icon: k.icon,
                section: 'Kind',
                selected: k.type === kind,
                run: ({ editor, pos }) => editor.chain().focus().setCalloutKind(k.type, pos).run(),
            }))
            return [
                ...kinds,
                { label: 'Other kind…', icon: '…', section: 'Kind', run: ({ editor, pos }) => editor.chain().focus(pos + 2).chooseCalloutKind(pos).run() },
                { label: 'Collapsible', icon: '▾', section: 'Callout', checked: !!(node.attrs as { fold: string }).fold, run: ({ editor, pos }) => editor.chain().focus().toggleCalloutFold(pos).run() },
                into('Plain quote', '"', ({ editor, pos }) => editor.chain().focus().calloutToQuote(pos).run()),
                into('Paragraphs', '¶', ({ editor, pos }) => editor.chain().focus().unsetCallout(pos).run()),
                remove,
            ]
        }
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
                    section: 'Code',
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
                { label: 'Add row above', icon: '↑', section: 'Rows', run: ({ editor }) => editor.chain().focus().addRowBefore().run() },
                { label: 'Add row below', icon: '↓', section: 'Rows', run: ({ editor }) => editor.chain().focus().addRowAfter().run() },
                { label: 'Delete row', icon: '⊟', section: 'Rows', run: ({ editor }) => editor.chain().focus().deleteRow().run() },
                { label: 'Add column before', icon: '←', section: 'Columns', run: ({ editor }) => editor.chain().focus().addColumnBefore().run() },
                { label: 'Add column after', icon: '→', section: 'Columns', run: ({ editor }) => editor.chain().focus().addColumnAfter().run() },
                { label: 'Delete column', icon: '⊠', section: 'Columns', run: ({ editor }) => editor.chain().focus().deleteColumn().run() },
                { label: 'Toggle header row', icon: '⇎', section: 'Table', run: ({ editor }) => editor.chain().focus().toggleHeaderRow().run() },
                { label: 'Delete table', icon: '✕', section: BLOCK, run: ({ editor }) => editor.chain().focus().deleteTable().run() },
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
    private popup: Popover | null = null
    private readonly unobserve: () => void
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
    // True when the indicator lives in its own mounted column (see the `mount`
    // option) rather than overlaying the editor's left gutter.
    private columnMode = false
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
    // A glyph for every block of the note, always in the gutter: what the
    // block is, soft until it is the active one (which the indicator shows
    // instead), and the handle to its menu. A fold's glyph opens the fold.
    private icons: HTMLButtonElement[] = []
    /** The glyphs laid out again, once, in the next frame. */
    private readonly iconPass = rafThrottle(() => this.layoutIcons())
    /** The blocks a selection spans (positions of its first and last), while
     *  the indicator stands for them all: their own glyphs fold into its star. */
    private span: { from: number; to: number } | null = null

    constructor(view: EditorView, editor: Editor, options: BlockActionsOptions) {
        this.view = view
        this.editor = editor

        // With a `mount`, the button lives in its own column; otherwise it
        // overlays the editor's left gutter (the original behavior).
        const mountEl = resolveMount(options.mount, view.dom.parentElement as HTMLElement | null)
        this.columnMode = !!mountEl
        this.wrapper = mountEl ?? (view.dom.parentElement as HTMLElement) ?? view.dom
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
        // Just the component class — its variables live at `:root`, and the
        // bare `.ezco-mde` class would pull in content-layout rules.
        this.btn = button('ezco-mde-block-action-btn')
        this.btn.style.position = 'absolute'
        this.btn.style.opacity = '0'
        this.btn.contentEditable = 'false'
        this.btn.setAttribute('aria-label', 'Block actions')
        this.btnIcon = el('span', 'ezco-mde-block-action-btn-icon', '·')
        this.btn.appendChild(this.btnIcon)

        pressable(this.btn, (_, e) => {
            e.preventDefault()
            // Anchor the dropdown to the click's viewport Y so the menu
            // opens near where the user clicked, rather than always at
            // the icon at the top of the button. For tall blocks (long
            // codeblocks, lists) a click near the bottom of the
            // indicator could otherwise open a menu hundreds of pixels
            // away from the cursor.
            this.openMenu('click-point', { x: e.clientX, y: e.clientY })
        })

        this.wrapper.appendChild(this.btn)

        this.unobserve = observeResize(view.dom, () => {
            this.reposition()
            this.iconPass.schedule()
        })

        // Track focus moving into/out of nested editors (CodeMirror inside
        // the codeblock NodeView). These don't trigger ProseMirror state
        // updates, so without explicit listeners the indicator wouldn't
        // appear when the cursor lands inside a codeblock.
        this.onFocusChange = () => this.reposition()
        view.dom.addEventListener('focusin', this.onFocusChange)
        view.dom.addEventListener('focusout', this.onFocusChange)

        // Initial position
        requestAnimationFrame(() => {
            this.reposition()
            this.iconPass.schedule()
        })
    }

    update(view: EditorView) {
        this.view = view
        this.reposition()
        this.iconPass.schedule()
    }

    /** A glyph for each top-level block (one for a fold, at its line), the
     *  box of its first line: as tall as the line, centred on it, and, for
     *  a paragraph, a list or a quote, in the line's own face and size, so
     *  a pilcrow stands as the text does and a bullet as the list's first
     *  bullet. A heading's level and a code block's `</>` keep the chrome's
     *  small label. The active block's glyph stands beside the indicator;
     *  the blocks a selection spans fold their glyphs into its star. */
    private layoutIcons() {
        if (!this.view.dom.isConnected) return
        const { doc } = this.view.state
        const folds = foldsOf(this.view.state)
        const wrapperRect = this.wrapper.getBoundingClientRect()
        const base = this.wrapper.scrollTop - wrapperRect.top
        type Entry = { glyph: string; top: number; height: number; font: string; pos: number; type: string; fold: Fold | null }
        const entries: Entry[] = []
        doc.forEach((node, offset) => {
            const fold = folds.find((f) => offset >= f.from && offset < f.to)
            if (fold) {
                // The chevron at the fold's head, on its first line (the one
                // line of it shown); the hidden blocks have no glyph.
                if (fold.from !== offset) return
                const head = this.view.nodeDOM(offset) as HTMLElement | null
                if (!head || typeof head.getBoundingClientRect !== 'function') return
                const line = firstLineBox(head)
                const rect = head.getBoundingClientRect()
                if (line) entries.push({ glyph: CHEVRON_ICON, top: line.top + base, height: line.height, font: '', pos: offset, type: 'fold', fold })
                else entries.push({ glyph: CHEVRON_ICON, top: rect.top + base + computeIconOffsetY(head) - 3, height: 20, font: '', pos: offset, type: 'fold', fold })
                return
            }
            const dom = this.view.nodeDOM(offset) as HTMLElement | null
            if (!dom || typeof dom.getBoundingClientRect !== 'function') return
            const rect = dom.getBoundingClientRect()
            if (!rect.height) return
            const type = node.type.name
            const line = firstLineBox(dom)
            const glyph = type === 'taskList' ? TASK_ICON : type === 'paragraph' ? PARA_ICON : iconForNode(node)
            if (line) entries.push({ glyph, top: line.top + base, height: line.height, font: TEXTUAL.has(type) ? line.font : '', pos: offset, type, fold: null })
            else entries.push({ glyph, top: rect.top + base + computeIconOffsetY(dom) - 3, height: 20, font: '', pos: offset, type, fold: null })
        })
        while (this.icons.length > entries.length) this.icons.pop()!.remove()
        const activeShown = this.btn.style.opacity === '1' && this.activePos >= 0
        const span = this.btn.style.opacity === '1' ? this.span : null
        entries.forEach((entry, i) => {
            let icon = this.icons[i]
            if (!icon) {
                icon = pressable(button('ezco-mde-block-icon'), (b, e) => {
                    e.preventDefault()
                    this.iconClicked(b)
                })
                icon.contentEditable = 'false'
                this.wrapper.appendChild(icon)
                this.icons.push(icon)
            }
            icon.dataset.pos = String(entry.pos)
            icon.dataset.blockType = entry.type
            if (icon.dataset.glyph !== entry.glyph) {
                icon.dataset.glyph = entry.glyph
                if (entry.glyph.startsWith('<')) icon.innerHTML = entry.glyph
                else icon.textContent = entry.glyph
            }
            const title = entry.fold ? 'Unfold' : 'Block actions'
            if (icon.title !== title) labelled(icon, title)
            // Where the line is, to the subpixel: a bullet rounded to the
            // pixel stood a hair under the list's own.
            const top = `${entry.top.toFixed(2)}px`
            if (icon.style.top !== top) icon.style.top = top
            const height = `${entry.height.toFixed(2)}px`
            if (icon.style.height !== height) icon.style.height = height
            if (icon.style.font !== entry.font) icon.style.font = entry.font
            const box = entry.type === 'taskList' ? checkboxSize(this.view.nodeDOM(entry.pos) as HTMLElement) : null
            const size = box ? `${box}px` : ''
            if (icon.style.getPropertyValue('--ezco-mde-block-icon-size') !== size) icon.style.setProperty('--ezco-mde-block-icon-size', size)
            const cap = entry.type === 'paragraph' && entry.font ? `${capHeight(entry.font).toFixed(2)}px` : ''
            if (icon.style.getPropertyValue('--ezco-mde-block-icon-cap') !== cap) icon.style.setProperty('--ezco-mde-block-icon-cap', cap)
            icon.classList.toggle('is-fold', !!entry.fold)
            icon.classList.toggle('is-active', !entry.fold && activeShown && entry.pos === this.activePos)
            icon.classList.toggle('is-spanned', !!span && entry.pos >= span.from && entry.pos <= span.to)
            // In the column, centred where the indicator's star is (17px in
            // from its line, which stands as far from the glyph's edge as
            // from the text; see `.ezco-mde-block-action-btn` in styles.ts).
            if (this.columnMode) {
                if (icon.style.right !== '13px') {
                    icon.style.right = '13px'
                    icon.style.left = 'auto'
                }
            } else if (icon.style.left !== '-41px') icon.style.left = '-41px'
        })
    }

    /** A glyph clicked: a fold's opens the fold; a block's makes the block
     *  the active one (the selection goes into it) and opens its menu there. */
    private iconClicked(icon: HTMLButtonElement) {
        const pos = Number(icon.dataset.pos)
        if (!Number.isFinite(pos)) return
        if (icon.dataset.blockType === 'fold') {
            this.editor.commands.unfold(pos)
            this.editor.view.focus()
            return
        }
        const { doc } = this.view.state
        const node = doc.nodeAt(pos)
        if (!node) return
        if (this.isOpen) this.closeMenu()
        // A code block's or the front matter's text is its own editor's: the
        // block is selected whole (a caret sent into the front matter would
        // be moved on to the body, and the body's block would be the active
        // one, with the wrong menu).
        const whole = node.isLeaf || node.isAtom || node.type.name === 'ezcodeBlock' || node.type.name === 'frontMatter'
        const selection = whole ? NodeSelection.create(doc, pos) : Selection.near(doc.resolve(pos + 1), 1)
        this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView())
        this.view.focus()
        this.reposition()
        const rect = icon.getBoundingClientRect()
        this.openMenu('click-point', { x: rect.left, y: rect.bottom })
    }

    destroy() {
        this.iconPass.cancel()
        for (const icon of this.icons) icon.remove()
        this.icons = []
        this.popup?.destroy()
        this.popup = null
        this.btn.remove()
        this.unobserve()
        this.view.dom.removeEventListener('focusin', this.onFocusChange)
        this.view.dom.removeEventListener('focusout', this.onFocusChange)
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

    /** A non-empty text selection that crosses a top-level block boundary
     *  (e.g. selecting from one paragraph into the next). Returns the range
     *  and the positions of its first/last top-level blocks. */
    private resolveSpanningSelection(): {
        from: number
        to: number
        fromBlockPos: number
        toBlockPos: number
    } | null {
        const { selection } = this.view.state
        if (!(selection instanceof TextSelection) || selection.empty) return null
        const { $from, $to } = selection
        if ($from.depth < 1 || $to.depth < 1) return null
        const fromBlockPos = $from.before(1)
        const toBlockPos = $to.before(1)
        if (fromBlockPos === toBlockPos) return null
        return { from: selection.from, to: selection.to, fromBlockPos, toBlockPos }
    }

    /** Position the indicator to span the full height of a multi-block
     *  selection (first block's top → last block's bottom) and show the
     *  `✳` glyph. */
    private positionSpanning(span: {
        from: number
        to: number
        fromBlockPos: number
        toBlockPos: number
    }) {
        const firstDom = this.view.nodeDOM(span.fromBlockPos) as HTMLElement | null
        const lastDom = this.view.nodeDOM(span.toBlockPos) as HTMLElement | null
        if (
            !firstDom || typeof firstDom.getBoundingClientRect !== 'function' ||
            !lastDom || typeof lastDom.getBoundingClientRect !== 'function'
        ) {
            requestAnimationFrame(() => this.reposition())
            return
        }

        const wrapperRect = this.wrapper.getBoundingClientRect()
        const firstRect = firstDom.getBoundingClientRect()
        const lastRect = lastDom.getBoundingClientRect()
        const top = firstRect.top - wrapperRect.top + this.wrapper.scrollTop
        const height = Math.max(lastRect.bottom - firstRect.top, firstRect.height)
        const iconOffsetY = computeIconOffsetY(firstDom)

        if (top !== this.lastTop) { this.btn.style.top = `${top}px`; this.lastTop = top }
        if (height !== this.lastHeight) { this.btn.style.height = `${height}px`; this.lastHeight = height }
        if (iconOffsetY !== this.lastIconOffsetY) {
            this.btn.style.setProperty('--ezco-mde-block-action-icon-offset-y', `${iconOffsetY}px`)
            this.lastIconOffsetY = iconOffsetY
        }
        this.positionHorizontally()
        if (this.btn.style.opacity !== '1') this.btn.style.opacity = '1'
        if (this.lastBlockType !== 'spanning') {
            this.btn.dataset.blockType = 'spanning'
            this.lastBlockType = 'spanning'
        }
        if (this.lastIconText !== '✳') {
            this.btnIcon.textContent = '✳'
            this.lastIconText = '✳'
        }

        this.activeNode = null
        this.activePos = -1
        if (this.span?.from !== span.fromBlockPos || this.span.to !== span.toBlockPos) {
            this.span = { from: span.fromBlockPos, to: span.toBlockPos }
            this.iconPass.schedule()
        }
    }

    /** The indicator stands for one block (or none): the spanned glyphs come back. */
    private unspan() {
        if (!this.span) return
        this.span = null
        this.iconPass.schedule()
    }

    /** Build the menu for a multi-block selection: only the block
     *  conversions that `editor.can()` apply to the whole range, plus a
     *  always-available Delete. If no conversion applies, a disabled "None"
     *  filler is shown so the menu never reads as empty. */
    private buildSpanningMenuItems(span: {
        from: number
        to: number
    }): ContextMenuEntry[] {
        const editor = this.editor
        const items: ContextMenuEntry[] = []
        const add = (label: string, icon: string, can: boolean, run: () => void) => {
            if (!can) return
            items.push({
                label,
                icon,
                onSelect: () => {
                    this.closeMenu()
                    run()
                    editor.view.focus()
                },
            })
        }

        add('Heading 1', 'H1', editor.can().setHeading({ level: 1 }), () => editor.chain().focus().setHeading({ level: 1 }).run())
        add('Heading 2', 'H2', editor.can().setHeading({ level: 2 }), () => editor.chain().focus().setHeading({ level: 2 }).run())
        add('Heading 3', 'H3', editor.can().setHeading({ level: 3 }), () => editor.chain().focus().setHeading({ level: 3 }).run())
        add('Paragraph', '¶', editor.can().setParagraph(), () => editor.chain().focus().setParagraph().run())
        add('Bullet list', '•', editor.can().toggleBulletList(), () => editor.chain().focus().toggleBulletList().updateAttributes('bulletList', { marker: 'bullet' }).run())
        add('Dashed list', '–', editor.can().toggleBulletList(), () => editor.chain().focus().toggleBulletList().updateAttributes('bulletList', { marker: 'dash' }).run())
        add('Numbered list', '1.', editor.can().toggleOrderedList(), () => editor.chain().focus().toggleOrderedList().updateAttributes('orderedList', { type: null }).run())
        add('Lettered list', 'a.', editor.can().toggleOrderedList(), () => editor.chain().focus().toggleOrderedList().updateAttributes('orderedList', { type: 'a' }).run())
        add('Task list', '☐', editor.can().toggleTaskList(), () => editor.chain().focus().toggleTaskList().run())
        add('Quote', '"', editor.can().toggleBlockquote(), () => editor.chain().focus().toggleBlockquote().run())

        if (items.length === 0) {
            items.push({
                label: 'No combined actions',
                icon: '∅',
                disabled: true,
                onSelect: () => { },
            })
        }

        // What any blocks can: a comment on the selection, the blocks folded.
        items.push({ type: 'separator' })
        if (canComment(editor)) {
            items.push({
                label: 'Comment',
                icon: '❝',
                onSelect: () => {
                    this.closeMenu()
                    editor.chain().focus().startComment().run()
                },
            })
        }
        items.push({
            label: 'Fold',
            icon: FOLD_ICON,
            onSelect: () => {
                this.closeMenu()
                editor.commands.foldBlocks(span.from, span.to)
                editor.view.focus()
            },
        })
        // Deleting the whole range always applies.
        items.push({
            label: 'Delete',
            icon: '✕',
            onSelect: () => {
                this.closeMenu()
                editor.chain().focus().deleteRange({ from: span.from, to: span.to }).run()
            },
        })

        return items
    }

    /** Place the indicator horizontally: right-aligned inside its own column
     *  (so the indicator line hugs the editor), or — without a mount — overlaid
     *  in the editor's left gutter via a negative offset. */
    private positionHorizontally() {
        if (this.columnMode) {
            if (this.btn.style.right !== '8px') {
                this.btn.style.right = '8px'
                this.btn.style.left = 'auto'
            }
        } else if (this.btn.style.left !== '-42px') {
            this.btn.style.left = '-42px'
        }
    }

    private reposition() {
        const wasShown = this.btn.style.opacity === '1'
        if (!this.hasFocusInside()) {
            if (wasShown) {
                this.btn.style.opacity = '0'
                this.iconPass.schedule()
            }
            this.unspan()
            return
        }

        // A selection that spans multiple blocks gets the spanning indicator
        // (block-level ops that apply to the whole range) instead of a
        // single-block one.
        const span = this.resolveSpanningSelection()
        if (span) {
            this.positionSpanning(span)
            return
        }
        this.unspan()

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
        // Place the indicator horizontally: in its own column, or overlaid in
        // the editor's left gutter (the default). Either way the button's right
        // border is the vertical indicator line, sitting just left of the text.
        this.positionHorizontally()
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

        // The glyphs follow: the active block's hides behind the indicator.
        if (!wasShown || this.activePos !== blockPos) this.iconPass.schedule()
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

        // Build the menu items. A multi-block selection gets the spanning
        // actions (whatever can apply to every block in the range); a single
        // block gets that block's own actions. Either way the items stand in
        // sections, a line between one and the next.
        let items: ContextMenuEntry[]
        const span = this.resolveSpanningSelection()
        if (span) {
            items = this.buildSpanningMenuItems(span)
        } else {
            // Refresh active-block resolution; the keyboard path doesn't go
            // through the usual update/reposition cycle.
            this.refreshActiveBlock()
            if (!this.activeNode || this.activePos < 0) {
                this.isOpen = false
                this.savedSelection = null
                return
            }
            const actions = actionsForNode(this.activeNode, this.editor)
            const activeNode = this.activeNode
            const activePos = this.activePos
            items = sectioned(actions, (action) => ({
                label: action.label,
                icon: action.icon,
                ...(action.checked !== undefined ? { checked: action.checked } : {}),
                ...(action.selected !== undefined ? { selected: action.selected } : {}),
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
            }))
        }

        const menu = new ContextMenu({
            className: 'ezco-mde-block-action-menu',
            items,
            onClose: () => this.closeMenu({ restoreEditorFocus: true }),
        })

        this.popup?.destroy()
        // Where it anchors:
        //  - `'cursor'`: the editor's text cursor (a keyboard invocation),
        //    where the user is looking.
        //  - `'click-point'`: the click's own height in the icon's column,
        //    so a tall block's menu opens by the click rather than hundreds
        //    of pixels up at its icon, at the same x as every other.
        //  - `'icon'`: the indicator icon at the top of the button.
        const rect =
            at === 'cursor'
                ? () => this.getCursorRect()
                : at === 'click-point' && clickPoint
                  ? () => {
                        const iconRect = this.btnIcon.getBoundingClientRect()
                        return new DOMRect(iconRect.left, clickPoint.y, iconRect.width, 0)
                    }
                  : () => this.btnIcon.getBoundingClientRect()
        // Escape, item selection (the menu) and a press outside (the
        // popover) close it; `Mod-/` toggles through `openMenu`.
        this.popup = menuPopover(this.btn, menu, {
            placement: 'bottom-start',
            rect,
            onHide: () => {
                this.isOpen = false
                this.popup = null
            },
        })
    }

    /** Compute a DOMRect at the editor's current cursor position. Used
     *  as Tippy's reference rect when the menu is opened via the
     *  keyboard shortcut. */
    private getCursorRect(): DOMRect {
        try {
            return caretRect(this.editor.view, this.editor.state.selection.from)
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

export const BlockActions = Extension.create<BlockActionsOptions, BlockActionsStorage>({
    name: 'blockActions',

    addOptions() {
        return { mount: undefined }
    },

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
        const options = this.options
        return [
            new Plugin({
                key: new PluginKey('blockActions'),
                view: (view) => {
                    const blockView = new BlockActionsView(view, editor, options)
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
