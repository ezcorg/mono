/**
 * A comment written in full: a sheet over the note's edge holding the
 * comment's document in an editor of the note's make, the note still in
 * view, and still there to select from, beside it. Select text in the note
 * and ask for a comment (⌘⌥M, or Comment in the selection menu) while the
 * sheet is open, and the selection is quoted into the sheet, where the
 * answer is written under it: one document answering several passages.
 * What is written is saved to the document as it is typed.
 *
 * When the pointer leaves the sheet it fades and slides to the edge,
 * leaving a handle; the handle, a quote, or the pointer's return brings
 * it back. It lives in a frame the size of the note's own, which clips it
 * as it slides, so nothing of it shows past the note's edge. Escape closes
 * it; a document closed with nothing written under its reference is
 * removed again.
 */
import { Editor, Extension, type AnyExtension } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { VfsInterface } from '@joinezco/storage'
import { referencesIn, type Wikilink } from '@joinezco/vault'
import { byline, fallbackExtensions, when } from './comment-render'
import { authorOf } from './comments'
import { button, el, glyph, labelled } from '../ui/dom'
import { CLOSE_ICON, FILE_ICON } from '../ui/icons'
import { followPage, observeResize, rafThrottle, restable, scrollerOf, type Restable } from '../ui/layout'

export interface SheetOptions {
    /** The note's editor: the sheet sits over its edge, and links followed
     *  in the sheet open there. */
    host: Editor
    /** The comment's document. */
    path: string
    fs: VfsInterface
    /** What the sheet's editor is built from (the note's setup without its chrome). */
    extensions?: AnyExtension[]
    /** Load the document as a note in the editor itself. */
    openAsNote: () => void
    /** Remove the document: closed with nothing under its reference. */
    remove: () => Promise<void>
    onClose: () => void
}

/** How long after a keystroke the document is written. */
const SAVE_AFTER = 500

/**
 * Put `clip` (fixed on the page) over the part of `root` in view: within
 * the area it scrolls in, and within the window. What stands over the
 * note's edge (the sheet, the comments panel with no room beside the note)
 * lives in such a frame, which clips it as it slides. Returns the frame's
 * size.
 */
export function frameOver(clip: HTMLElement, root: HTMLElement): { width: number; height: number } {
    const r = root.getBoundingClientRect()
    const scroller = scrollerOf(root)
    let top = r.top
    let bottom = r.bottom
    let left = r.left
    let right = r.right
    if (scroller) {
        const s = scroller.getBoundingClientRect()
        top = Math.max(top, s.top)
        bottom = Math.min(bottom, s.bottom)
        left = Math.max(left, s.left)
        right = Math.min(right, s.right)
    }
    top = Math.max(top, 0)
    bottom = Math.min(bottom, window.innerHeight)
    left = Math.max(left, 0)
    right = Math.min(right, window.innerWidth)
    const width = Math.max(0, right - left)
    const height = Math.max(0, bottom - top)
    clip.style.top = `${Math.round(top)}px`
    clip.style.left = `${Math.round(left)}px`
    clip.style.width = `${Math.round(width)}px`
    clip.style.height = `${Math.round(height)}px`
    return { width, height }
}

export class Sheet {
    readonly dom: HTMLElement
    /** The sheet's clip: the note's frame, over the page, clipping the sheet. */
    private readonly clip: HTMLElement
    readonly editor: Editor
    readonly path: string
    private readonly root: HTMLElement
    private latest = ''
    private dirty = false
    private saving: Promise<void> = Promise.resolve()
    private saveTimer = 0
    private closed = false
    /** Aside when left alone, back on the pointer, focus or the handle. */
    private readonly resting: Restable
    private readonly placing = rafThrottle(() => this.fit())
    private readonly unfollow: () => void
    private readonly unobserve: () => void

    constructor(private readonly options: SheetOptions) {
        const { host, path } = options
        this.path = path
        this.root = (host.view.dom.closest('.ezco-mde') as HTMLElement | null) ?? host.view.dom
        // Its own `.ezco-mde`, so the theme's variables reach it where it
        // sits (on the page, over everything), in the theme the note is in.
        this.clip = el('div', 'ezco-mde-comment-sheet-frame')
        this.dom = el('aside', 'ezco-mde ezco-mde-comment-sheet')
        this.dom.setAttribute('role', 'dialog')
        this.dom.setAttribute('aria-label', 'Comment')
        const theme = this.root.closest('[data-theme]')?.getAttribute('data-theme')
        if (theme) this.dom.dataset.theme = theme
        this.clip.append(this.dom)

        const by = authorOf(path)
        const handle = labelled(button('ezco-mde-comment-sheet-handle'), 'Show the comment')
        handle.append(el('span', 'ezco-mde-comment-sheet-handle-label', byline(by)))
        handle.addEventListener('click', () => {
            this.resting.wake()
            this.editor.commands.focus()
        })

        const head = el('header', 'ezco-mde-comment-sheet-head')
        const title = el('span', 'ezco-mde-comment-sheet-title')
        title.append(el('span', 'ezco-mde-comment-author', byline(by)))
        if (by.time) {
            const at = el('time', 'ezco-mde-comment-time', when(by.time))
            at.dateTime = by.time
            title.append(at)
        }
        const tools = el('span', 'ezco-mde-comment-sheet-tools')
        tools.append(glyph(FILE_ICON, 'Open as file', 'ezco-mde-comment-tool', () => options.openAsNote()), glyph(CLOSE_ICON, 'Close', 'ezco-mde-comment-tool', () => void this.close()))
        head.append(title, tools)

        const text = el('div', 'ezco-mde-comment-sheet-text')
        const sheet = this
        const keys = Extension.create({
            name: 'sheetKeys',
            addKeyboardShortcuts() {
                return { Escape: () => (void sheet.close(), true) }
            },
        })
        this.editor = new Editor({
            element: text,
            // The keys last: an open menu (emoji, slash) takes Escape first.
            extensions: [...(options.extensions ?? fallbackExtensions(host)), keys],
            editorProps: { attributes: { 'aria-label': 'Comment', class: 'ezco-mde-body ezco-mde-comment-sheet-body' } },
            onUpdate: () => this.changed(),
        })
        ;(this.editor.storage as any).hostEditor = host

        const hint = el('div', 'ezco-mde-comment-sheet-hint', 'Select text in the note and press ⌘⌥M (Ctrl+Alt+M) to quote it here.')
        this.dom.append(handle, head, text, hint)

        this.resting = restable(this.dom)
        // The sheet's keys and clicks are its own, not the note's.
        for (const type of ['mousedown', 'click', 'keydown'] as const) this.dom.addEventListener(type, (e) => e.stopPropagation())

        document.body.append(this.clip)
        this.unfollow = followPage(this.placing.schedule)
        this.unobserve = observeResize(this.root, this.placing.schedule)
        this.fit()
        void this.load()
    }

    /** The document's text, with the caret at its end: under the reference,
     *  in a paragraph of its own when there is none yet. */
    private async load() {
        const text = await this.options.fs.readFile(this.path).catch(() => '')
        if (this.closed) return
        this.latest = text
        this.editor.commands.setContent(text, { emitUpdate: false })
        const { state, view } = this.editor
        const tr = state.tr
        const last = state.doc.lastChild
        const reference = !!last && last.isTextblock && last.childCount > 0 && last.content.content.every((n) => n.type.name === 'embed')
        if (!last || !last.isTextblock || reference) tr.insert(state.doc.content.size, state.schema.nodes.paragraph.create())
        tr.setSelection(TextSelection.atEnd(tr.doc)).setMeta('addToHistory', false).scrollIntoView()
        view.dispatch(tr)
        this.resting.wake()
        view.focus()
    }

    /** Quote a passage: its reference at the end of the document, and a
     *  paragraph under it for the answer, where the caret goes. */
    quote(link: Wikilink) {
        const { state, view } = this.editor
        const { schema } = state
        const embed = schema.nodes.embed.create({ target: link.target, fragment: link.fragment, alias: link.alias })
        const reference = schema.nodes.paragraph.create(null, embed)
        const answer = schema.nodes.paragraph.create()
        let tr = state.tr
        let at = state.doc.content.size
        const last = state.doc.lastChild
        if (last && last.type.name === 'paragraph' && last.content.size === 0) {
            at -= last.nodeSize
            tr = tr.delete(at, state.doc.content.size)
        }
        tr = tr.insert(at, Fragment.from([reference, answer]))
        tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView()
        view.dispatch(tr)
        this.resting.wake()
        view.focus()
    }

    private markdown(): string {
        const md = ((this.editor.storage as any).markdown.getMarkdown() as string).replace(/\s+$/, '')
        return md ? `${md}\n` : ''
    }

    private changed() {
        this.dirty = true
        clearTimeout(this.saveTimer)
        this.saveTimer = window.setTimeout(() => void this.save(), SAVE_AFTER)
    }

    /** Write the document, if what is in the sheet differs from what was last written. */
    save(): Promise<void> {
        clearTimeout(this.saveTimer)
        if (!this.dirty || this.editor.isDestroyed) return this.saving
        this.dirty = false
        const text = this.markdown()
        if (text === this.latest) return this.saving
        this.latest = text
        this.saving = this.saving.then(() => this.options.fs.writeFile(this.path, text)).catch((error) => console.error('The comment could not be written', error))
        return this.saving
    }

    /** The frame over the note's frame: the part of the editor in view,
     *  within the area it scrolls in. The sheet stands at its right edge. */
    private fit() {
        const { width } = frameOver(this.clip, this.root)
        this.dom.style.width = `${Math.round(Math.min(width, Math.min(560, Math.max(320, width * 0.55))))}px`
    }

    /** Written, then put away; the document removed when nothing was written under its reference. */
    async close() {
        if (this.closed) return
        this.closed = true
        await this.save()
        const empty = !referencesIn(this.latest).length
        this.destroy()
        if (empty) await this.options.remove().catch(() => undefined)
        this.options.onClose()
    }

    destroy() {
        this.closed = true
        clearTimeout(this.saveTimer)
        this.resting.stop()
        this.placing.cancel()
        this.unfollow()
        this.unobserve()
        this.editor.destroy()
        this.clip.remove()
    }
}
