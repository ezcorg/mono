import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { findTextFragment as matchTextFragment, parseTextFragment } from '@joinezco/storage'
import { slugify } from './slug-utils'

/**
 * The part of a link after `#`, found in a document:
 *
 * - a heading, by its anchor slug or its text (`[[Note#Goals]]`; Obsidian's
 *   nested `#Plan#Goals` names the last heading);
 * - a block id, `^abc`, which Obsidian writes at the end of a paragraph;
 * - a text fragment, `:~:text=[prefix-,]start[,end][,-suffix]`, the form a
 *   browser's "copy link to highlight" produces (and a comment's anchor),
 *   found as written, regardless of case, or approximately (see
 *   `@joinezco/storage`'s `findTextFragment`);
 * - a pin, the id of a bracketed span (`[text]{#c-…}`).
 */
export function findFragment(doc: PMNode, fragment: string): { from: number; to: number } | null {
    const frag = fragment.trim()
    if (!frag) return null
    if (frag.startsWith(':~:text=')) return locateTextFragment(doc, frag)
    if (frag.startsWith('^')) return findBlockId(doc, frag.slice(1))
    const pin = findPin(doc, frag)
    if (pin) return pin
    const last = frag.split('#').filter(Boolean).pop() ?? frag
    const slug = slugify(last)
    const text = last.trim().toLowerCase()
    let found: { from: number; to: number } | null = null
    doc.descendants((node, pos) => {
        if (found) return false
        if (node.type.name !== 'heading') return true
        if (slugify(node.textContent) === slug || node.textContent.trim().toLowerCase() === text) {
            found = { from: pos + 1, to: pos + node.nodeSize - 1 }
        }
        return false
    })
    return found
}

/** Put the caret at (or select) the fragment and scroll it into view.
 *  Returns false when the document has no such place. */
export function revealFragment(editor: Editor, fragment: string | null): boolean {
    if (!fragment) return false
    const range = findFragment(editor.state.doc, fragment)
    if (!range) return false
    const select = fragment.startsWith(':~:text=')
    const tr = editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, range.from, select ? range.to : range.from),
    )
    editor.view.dispatch(tr.scrollIntoView())
    const dom = editor.view.domAtPos(range.from).node as HTMLElement | Text
    const el = dom instanceof Text ? dom.parentElement : dom
    el?.scrollIntoView?.({ block: 'center' })
    editor.view.focus()
    return true
}

export function findBlockId(doc: PMNode, id: string): { from: number; to: number } | null {
    const marker = new RegExp(`(?:^|\\s)\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
    let found: { from: number; to: number } | null = null
    doc.descendants((node, pos) => {
        if (found) return false
        if (!node.isTextblock) return true
        if (marker.test(node.textContent)) found = { from: pos + 1, to: pos + node.nodeSize - 1 }
        return false
    })
    return found
}

/** The text a bracketed span with this id holds (`[text]{#id}`). */
export function findPin(doc: PMNode, id: string): { from: number; to: number } | null {
    let from = -1
    let to = -1
    doc.descendants((node, pos) => {
        if (!node.isText) return true
        if (node.marks.some((m) => m.type.name === 'span' && m.attrs.id === id)) {
            if (from < 0) from = pos
            to = pos + node.nodeSize
        }
        return false
    })
    return from < 0 ? null : { from, to }
}

/** A document's text as a reader sees it: its textblocks joined by
 *  newlines, an inline atom (a wikilink, an image) as the text it shows.
 *  `positions[i]` is where character `i` is in the document (a newline's,
 *  the end of the block before it). */
export interface DocText {
    text: string
    positions: number[]
}

export function docText(doc: PMNode): DocText {
    let text = ''
    const positions: number[] = []
    let end = -1
    doc.descendants((node, pos) => {
        if (!node.isTextblock) return true
        if (end >= 0) {
            text += '\n'
            positions.push(end)
        }
        node.forEach((child, offset) => {
            const at = pos + 1 + offset
            const piece = child.isText ? child.text ?? '' : ((child.type.spec as { leafText?: (n: PMNode) => string }).leafText?.(child) ?? '')
            for (let i = 0; i < piece.length; i++) positions.push(child.isText ? at + i : at)
            text += piece
        })
        end = pos + node.nodeSize - 1
        return false
    })
    return { text, positions }
}

/** The offset in `docText` of the first character at or after `pos`. */
export function textOffset(flat: DocText, pos: number): number {
    let lo = 0
    let hi = flat.positions.length
    while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (flat.positions[mid] < pos) lo = mid + 1
        else hi = mid
    }
    return lo
}

/** Offsets `[from, to)` of `docText` as a document range. */
export function docRange(flat: DocText, from: number, to: number): { from: number; to: number } {
    return { from: flat.positions[from], to: flat.positions[to - 1] + 1 }
}

/** A text fragment in the document (`:~:text=…`), and whether it was found
 *  as written (or only approximately). Nearest `near` when it is in several
 *  places. */
export function locateTextFragment(
    doc: PMNode,
    fragment: string,
    near?: number,
    flat: DocText = docText(doc),
    /** Whether a place whose text is only near the quote counts (when a
     *  note is read); while it is edited here, only the quote itself does. */
    approximate = true,
): { from: number; to: number; exact: boolean } | null {
    const f = parseTextFragment(fragment)
    if (!f) return null
    const match = matchTextFragment(flat.text, f, near === undefined ? undefined : textOffset(flat, near))
    if (!match || (!approximate && !match.exact)) return null
    return { ...docRange(flat, match.from, match.to), exact: match.exact }
}
