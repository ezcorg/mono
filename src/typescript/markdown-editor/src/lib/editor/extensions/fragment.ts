import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { slugify } from './slug-utils'

/**
 * The part of a link after `#`, found in a document:
 *
 * - a heading, by its anchor slug or its text (`[[Note#Goals]]`; Obsidian's
 *   nested `#Plan#Goals` names the last heading);
 * - a block id, `^abc`, which Obsidian writes at the end of a paragraph;
 * - a text fragment, `:~:text=[prefix-,]start[,end][,-suffix]`, the form a
 *   browser's "copy link to highlight" produces (and a comment's anchor).
 */
export function findFragment(doc: PMNode, fragment: string): { from: number; to: number } | null {
    const frag = fragment.trim()
    if (!frag) return null
    if (frag.startsWith(':~:text=')) return findTextFragment(doc, frag.slice(':~:text='.length))
    if (frag.startsWith('^')) return findBlockId(doc, frag.slice(1))
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

function findBlockId(doc: PMNode, id: string): { from: number; to: number } | null {
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

/** The text of each textblock with a map back to document positions (inline
 *  atoms, which have no text, simply do not appear). */
function textblocks(doc: PMNode): { text: string; positions: number[] }[] {
    const out: { text: string; positions: number[] }[] = []
    doc.descendants((node, pos) => {
        if (!node.isTextblock) return true
        let text = ''
        const positions: number[] = []
        node.forEach((child, offset) => {
            if (!child.isText || !child.text) return
            for (let i = 0; i < child.text.length; i++) positions.push(pos + 1 + offset + i)
            text += child.text
        })
        positions.push(pos + node.nodeSize - 1)
        out.push({ text, positions })
        return false
    })
    return out
}

function findTextFragment(doc: PMNode, directive: string): { from: number; to: number } | null {
    const decode = (s: string) => {
        try {
            return decodeURIComponent(s)
        } catch {
            return s
        }
    }
    const parts = directive.split('&')[0].split(',')
    let prefix = ''
    let suffix = ''
    if (parts[0]?.endsWith('-')) prefix = decode(parts.shift()!.slice(0, -1))
    if (parts[parts.length - 1]?.startsWith('-')) suffix = decode(parts.pop()!.slice(1))
    const start = decode(parts[0] ?? '')
    const end = parts[1] !== undefined ? decode(parts[1]) : null
    if (!start) return null
    for (const block of textblocks(doc)) {
        let from = 0
        for (;;) {
            const at = block.text.indexOf(start, from)
            if (at < 0) break
            from = at + 1
            if (prefix && !block.text.slice(0, at).trimEnd().endsWith(prefix)) continue
            let stop = at + start.length
            if (end !== null) {
                const e = block.text.indexOf(end, stop)
                if (e < 0) continue
                stop = e + end.length
            }
            if (suffix && !block.text.slice(stop).trimStart().startsWith(suffix)) continue
            return { from: block.positions[at], to: block.positions[stop - 1] + 1 }
        }
    }
    return null
}
