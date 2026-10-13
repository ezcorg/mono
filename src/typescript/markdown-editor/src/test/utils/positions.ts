import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'

/** Places in the note, found by what is written there. */

/** Where `text` first occurs (within one text node), or -1. */
export function posOf(editor: Editor, text: string): number {
    let at = -1
    editor.state.doc.descendants((node, pos) => {
        if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text)
        return at < 0
    })
    return at
}

/** `text`'s first occurrence, as a range. */
export function rangeOf(editor: Editor, text: string): { from: number; to: number } {
    const from = posOf(editor, text)
    return { from, to: from + text.length }
}

/** The start of the text node reading exactly `text`, or -1. */
export function startOf(editor: Editor, text: string): number {
    let at = -1
    editor.state.doc.descendants((node, pos) => {
        if (at < 0 && node.isText && node.text === text) at = pos
        return at < 0
    })
    return at
}

/** The end of the text node reading exactly `text`, or -1. */
export function endOf(editor: Editor, text: string): number {
    let at = -1
    editor.state.doc.descendants((node, pos) => {
        if (at < 0 && node.isText && node.text === text) at = pos + node.nodeSize
        return at < 0
    })
    return at
}

/** The first node of type `typeName`, with its position. */
export function findNode(editor: Editor, typeName: string): { node: PMNode; pos: number } | null {
    let found: { node: PMNode; pos: number } | null = null
    editor.state.doc.descendants((node, pos) => {
        if (found) return false
        if (node.type.name === typeName) {
            found = { node, pos }
            return false
        }
        return true
    })
    return found
}
