/**
 * Edits into open documents: how something other than the person typing
 * (an agent, a language tool, a collaborator's client) changes a file that
 * is open, without touching the disk under the editor (RFC §3). The editor
 * is the writer of record for its open file: an edit comes to it, in the
 * shape of an LSP text edit on a document version, is applied as one
 * transaction that keeps the caret, and is then saved (through the version
 * log, when there is one).
 *
 *     const docs = openDocuments(editor)
 *     const doc = await docs.read('notes/plan.md')        // { text, version }
 *     await docs.edit('notes/plan.md', doc.version, [
 *         { range: { start: { line: 4, character: 0 }, end: { line: 4, character: 6 } }, text: 'Last' },
 *     ])
 *
 * `text` is the file as it would be saved (the Markdown of a note, the text
 * of a code file), and ranges are in it. An edit on a version the document
 * has moved on from is refused: read again.
 */
import { createDocument, type Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { normalizePath } from '@joinezco/storage'
import type { FileSystemStorage } from './filesystem'

/** A place in the text: LSP's, 0-based, characters in UTF-16 code units. */
export interface TextPosition {
    line: number
    character: number
}

/** A span of the text, as offsets or as positions. */
export type TextRange = { from: number; to: number } | { start: TextPosition; end: TextPosition }

export interface TextEdit {
    range: TextRange
    text: string
}

export interface OpenDocument {
    path: string
    /** The file as it would be saved. */
    text: string
    /** Moves on with every change to the document, saved or not. */
    version: number
}

export type EditResult =
    | { ok: true; version: number }
    /** `not-open`: some other file is open. `stale`: the document changed
     *  since `base` (read it again). `invalid`: edits overlap, or fall outside
     *  the text. */
    | { ok: false; reason: 'not-open' | 'stale' | 'invalid'; version?: number }

/** What an editor offers its host for the documents it has open. */
export interface OpenDocuments {
    read(path: string): Promise<OpenDocument | null>
    edit(path: string, base: number, edits: TextEdit[]): Promise<EditResult>
}

export function openDocuments(editor: Editor): OpenDocuments {
    const persistence = () => (editor.storage as any).persistence as FileSystemStorage | undefined
    const isOpen = (path: string) => {
        const open = persistence()?.options.filepath
        return !!open && normalizePath(open) === normalizePath(path)
    }
    const textOf = (storage: FileSystemStorage) =>
        storage.codeView ? storage.codeView.state.doc.toString() : ((editor.storage as any).markdown.getMarkdown() as string)

    return {
        async read(path) {
            const storage = persistence()
            if (!storage || !isOpen(path)) return null
            return { path: normalizePath(path), text: textOf(storage), version: storage.documentVersion }
        },

        async edit(path, base, edits) {
            const storage = persistence()
            if (!storage || !isOpen(path)) return { ok: false, reason: 'not-open' }
            if (storage.documentVersion !== base) return { ok: false, reason: 'stale', version: storage.documentVersion }
            const text = textOf(storage)
            const changes = offsetsOf(text, edits)
            if (!changes) return { ok: false, reason: 'invalid', version: storage.documentVersion }

            if (storage.codeView) {
                // CodeMirror maps the selection through the change itself.
                storage.codeView.dispatch({ changes: changes.map(({ from, to, text: insert }) => ({ from, to, insert })), userEvent: 'input.edit' })
            } else {
                replaceChanged(editor, applyTo(text, changes))
            }
            await storage.save()
            return { ok: true, version: storage.documentVersion }
        },
    }
}

/** Offsets for `edits` in `text`, in order; null if any overlap or fall
 *  outside it. */
function offsetsOf(text: string, edits: TextEdit[]): { from: number; to: number; text: string }[] | null {
    const lineStarts = [0]
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1)
    const offset = (p: TextPosition) => {
        if (p.line < 0 || p.line >= lineStarts.length || p.character < 0) return -1
        const lineEnd = p.line + 1 < lineStarts.length ? lineStarts[p.line + 1] - 1 : text.length
        return Math.min(lineStarts[p.line] + p.character, lineEnd)
    }
    const changes = edits.map(({ range, text: insert }) =>
        'from' in range ? { from: range.from, to: range.to, text: insert } : { from: offset(range.start), to: offset(range.end), text: insert },
    )
    changes.sort((a, b) => a.from - b.from || a.to - b.to)
    for (let i = 0; i < changes.length; i++) {
        const { from, to } = changes[i]
        if (from < 0 || to < from || to > text.length) return null
        if (i > 0 && from < changes[i - 1].to) return null
    }
    return changes
}

function applyTo(text: string, changes: { from: number; to: number; text: string }[]): string {
    let out = ''
    let at = 0
    for (const { from, to, text: insert } of changes) {
        out += text.slice(at, from) + insert
        at = to
    }
    return out + text.slice(at)
}

/**
 * Make the note's document the one `markdown` parses to, replacing only the
 * part that differs: one transaction, in the undo history, the selection
 * mapped through it (so a caret outside the changed part stays put).
 */
function replaceChanged(editor: Editor, markdown: string): void {
    const html = (editor.storage as any).markdown.parser.parse(markdown)
    const next = createDocument(html, editor.schema, editor.options.parseOptions)
    const current = editor.state.doc
    const start = current.content.findDiffStart(next.content)
    if (start === null) return
    let { a: endA, b: endB } = current.content.findDiffEnd(next.content)!
    // Where the two differ by repeated content, the ends can cross the start.
    const overlap = start - Math.min(endA, endB)
    if (overlap > 0) {
        endA += overlap
        endB += overlap
    }
    // Its own step in the undo history, apart from what the user typed.
    editor.view.dispatch(closeHistory(editor.state.tr.replace(start, endA, next.slice(start, endB))).setMeta('ezco-edit', true))
}
