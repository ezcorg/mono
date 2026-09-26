/**
 * Tables as GFM writes them: tiptap-markdown's serializer, except that every
 * cell is written and nothing is ever lost. Its version skipped a cell with
 * no text of its own, so a cell holding only a footnote reference or an
 * image without alt text came back empty, and wrote a table it could not
 * express (a cell holding two blocks, which Enter in a cell makes; a table
 * whose first row is not all headers; a spanning cell) as the text
 * `[table]`, which is where the table went on the next save.
 *
 * GFM has one line a cell, a header row and no spans. A cell's blocks are
 * written on that line separated by spaces; a table without a header row
 * gets an empty one, so its rows all stay rows; a span is written as the
 * cell's text, its reach given up. What the syntax cannot say is lost, the
 * words never are.
 */
import { getHTMLFromFragment } from '@tiptap/core'
import { Table } from '@tiptap/extension-table'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import type { MarkdownNodeSpec } from 'tiptap-markdown'

const hasSpan = (cell: PMNode) => cell.attrs.colspan > 1 || cell.attrs.rowspan > 1

/** A header row of header cells, body rows of plain cells, one paragraph a
 *  cell and no spans: what GFM can express as it is. */
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

/** Whether the first row is all header cells. */
const hasHeaderRow = (table: PMNode) => {
    const first = table.firstChild
    if (!first) return false
    let headers = true
    first.forEach((cell) => {
        if (cell.type.name !== 'tableHeader') headers = false
    })
    return headers
}

/** A cell's blocks on one line: inline content as it is, anything else as
 *  its text, blocks separated by a space. */
function renderCell(state: any, cell: PMNode) {
    cell.forEach((block, _, i) => {
        if (i) state.write(' ')
        if (block.isTextblock) state.renderInline(block)
        else state.text(block.textContent)
    })
}

export const MarkdownTable = Table.extend({
    addStorage() {
        return {
            ...this.parent?.(),
            markdown: {
                serialize(this: { editor: { storage: any } }, state: any, node: PMNode) {
                    if (!isMarkdownSerializable(node) && this.editor.storage.markdown?.options?.html) {
                        // HTML says all of it, where HTML is allowed.
                        state.write(getHTMLFromFragment(Fragment.from(node), node.type.schema))
                        state.closeBlock(node)
                        return
                    }
                    state.inTable = true
                    const columns = Math.max(...Array.from({ length: node.childCount }, (_, i) => node.child(i).childCount), 1)
                    const separator = () => {
                        state.write(`| ${Array.from({ length: columns }, () => '---').join(' | ')} |`)
                        state.ensureNewLine()
                    }
                    if (!hasHeaderRow(node)) {
                        // No header row to write: an empty one keeps every
                        // row a row.
                        state.write(`| ${Array.from({ length: columns }, () => '').join(' | ')} |`)
                        state.ensureNewLine()
                        separator()
                    }
                    node.forEach((row, _, i) => {
                        state.write('| ')
                        row.forEach((cell, __, j) => {
                            if (j) state.write(' | ')
                            renderCell(state, cell)
                        })
                        state.write(' |')
                        state.ensureNewLine()
                        if (!i && hasHeaderRow(node)) separator()
                    })
                    state.closeBlock(node)
                    state.inTable = false
                },
                parse: {},
            } as MarkdownNodeSpec,
        }
    },
})
