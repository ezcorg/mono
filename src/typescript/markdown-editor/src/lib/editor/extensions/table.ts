/**
 * Tables as GFM writes them: tiptap-markdown's serializer, except that every
 * cell is written. Its version skipped a cell with no text of its own, so a
 * cell holding only a footnote reference or an image without alt text came
 * back empty.
 */
import { getHTMLFromFragment } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import type { MarkdownNodeSpec } from 'tiptap-markdown'

const hasSpan = (cell: PMNode) => cell.attrs.colspan > 1 || cell.attrs.rowspan > 1

/** A header row of header cells, body rows of plain cells, one paragraph a
 *  cell and no spans: what GFM can express. */
function isMarkdownSerializable(table: PMNode): boolean {
    let ok = true
    table.forEach((row, _, r) => {
        row.forEach((cell) => {
            const header = cell.type.name === 'tableHeader'
            if (header !== (r === 0) || hasSpan(cell) || cell.childCount > 1) ok = false
        })
    })
    return ok
}

export const MarkdownTable = Table.extend({
    addStorage() {
        return {
            ...this.parent?.(),
            markdown: {
                serialize(this: { editor: { storage: any } }, state: any, node: PMNode) {
                    if (!isMarkdownSerializable(node)) {
                        // What tiptap-markdown does: HTML where allowed, else a marker.
                        if (this.editor.storage.markdown?.options?.html) state.write(getHTMLFromFragment(Fragment.from(node), node.type.schema))
                        else state.write(`[${node.type.name}]`)
                        state.closeBlock(node)
                        return
                    }
                    state.inTable = true
                    node.forEach((row, _, i) => {
                        state.write('| ')
                        row.forEach((cell, __, j) => {
                            if (j) state.write(' | ')
                            if (cell.firstChild) state.renderInline(cell.firstChild)
                        })
                        state.write(' |')
                        state.ensureNewLine()
                        if (!i) {
                            state.write(`| ${Array.from({ length: row.childCount }, () => '---').join(' | ')} |`)
                            state.ensureNewLine()
                        }
                    })
                    state.closeBlock(node)
                    state.inTable = false
                },
                parse: {},
            } as MarkdownNodeSpec,
        }
    },
})
