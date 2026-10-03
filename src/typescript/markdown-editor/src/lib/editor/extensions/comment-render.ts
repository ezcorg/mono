/**
 * A comment's Markdown shown as the note shows it: a read-only editor of
 * the note's own make (the host's extensions, so the same code blocks over
 * the same files, the same links), so what a card or an embed shows is
 * exactly what the editor would show, a fence inside a fence included.
 * Nothing in it runs: the schema is the sanitizer, and raw HTML is text to
 * the note's parser. Shared by the margin's cards, the sheet and the embed.
 *
 * A view knows the editor it is shown in (`hostEditor` on its storage), so
 * a link followed inside it opens in the note's editor, not in the view.
 */
import { Editor, Extension, type AnyExtension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { minimalSetup } from '../minimal'
import { locateTextFragment } from './fragment'

export interface ReadOnlyView {
    dom: HTMLElement
    editor: Editor
    destroy(): void
}

export interface ReadOnlyOptions {
    /** The extensions to build the view from (the note's setup without its
     *  chrome); a lean set otherwise. */
    extensions?: AnyExtension[]
    /** Classes on the editable, besides `ezco-mde-body`. */
    className?: string
    /** A text fragment (`:~:text=…`) to mark in the text, as the quoted
     *  part of a passage shown with what is around it. */
    highlight?: string | null
}

/** The extensions a view of a note's text is built from when the host
 *  gave none: the syntax, links resolved as the host resolves them. */
export function fallbackExtensions(host: Editor): AnyExtension[] {
    const wikilink = host.extensionManager.extensions.find((e) => e.name === 'wikilink')
    return minimalSetup({
        links: { resolver: wikilink?.options.resolver, open: wikilink?.options.open },
        frontMatter: false,
        footnotes: false,
        callouts: false,
    })
}

/** The quoted part of a passage, marked. */
const highlightOf = (fragment: string) =>
    Extension.create({
        name: 'quotedHighlight',
        addProseMirrorPlugins() {
            return [
                new Plugin({
                    key: new PluginKey('quotedHighlight'),
                    props: {
                        decorations(state) {
                            const found = locateTextFragment(state.doc, fragment, undefined, undefined, true)
                            if (!found) return DecorationSet.empty
                            return DecorationSet.create(state.doc, [Decoration.inline(found.from, found.to, { class: 'ezco-mde-embed-quoted' })])
                        },
                    },
                }),
            ]
        },
    })

/** `markdown`, shown read-only as the note would show it. */
export function renderReadOnly(host: Editor, markdown: string, options: ReadOnlyOptions = {}): ReadOnlyView {
    const dom = document.createElement('div')
    dom.className = 'ezco-mde-readonly'
    const extensions = [...(options.extensions ?? fallbackExtensions(host))]
    if (options.highlight) extensions.push(highlightOf(options.highlight))
    const editor = new Editor({
        element: dom,
        extensions,
        content: markdown,
        editable: false,
        editorProps: { attributes: { class: `ezco-mde-body ${options.className ?? ''}`.trim() } },
    })
    ;(editor.storage as any).hostEditor = host
    return {
        dom,
        editor,
        destroy() {
            editor.destroy()
            dom.remove()
        },
    }
}

/** `2026-09-13T12:04Z` as the reader's clock shows it; the year when it is
 *  not this one. */
export function when(time: string): string {
    const date = new Date(time)
    if (Number.isNaN(date.getTime())) return time
    const thisYear = date.getFullYear() === new Date().getFullYear()
    return date.toLocaleString(undefined, { year: thisYear ? undefined : 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ── Drafts ──────────────────────────────────────────────────────────────────
// What is being written is a draft: kept in this browser (never in the
// note, never seen by anyone else) until it is posted, so a card closed or
// a note reopened does not lose it. Nothing has to be asked for.

const DRAFT_PREFIX = 'ezco-mde-comment-draft:'

export const draftKey = (note: string | null, thread: string, path: string) => `${DRAFT_PREFIX}${note ?? ''}:${thread}:${path}`

export function readDraft(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

export function writeDraft(key: string, markdown: string): void {
    try {
        if (markdown.trim()) localStorage.setItem(key, markdown)
        else localStorage.removeItem(key)
    } catch {
        // Nothing to keep it in: the composer still has it while open.
    }
}

export function clearDraft(key: string): void {
    try {
        localStorage.removeItem(key)
    } catch {
        // As above.
    }
}
