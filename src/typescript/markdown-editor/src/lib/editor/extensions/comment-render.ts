/**
 * A comment's Markdown shown as HTML, with nothing in it that would run: a
 * message may come from anyone the vault syncs with, and Markdown lets
 * HTML through. Shared by the margin's cards and the full-size view.
 */
import type { Editor } from '@tiptap/core'

const ALLOWED = new Set([
    'P', 'BR', 'STRONG', 'EM', 'B', 'I', 'S', 'DEL', 'CODE', 'PRE', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'SPAN', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SUP', 'SUB', 'IMG',
])
const DROPPED = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'LINK', 'META', 'BASE', 'FORM', 'SVG', 'MATH'])
const KEPT_ATTRIBUTES: Record<string, string[]> = {
    A: ['href', 'title'],
    IMG: ['src', 'alt', 'title'],
    SPAN: ['data-wikilink', 'data-target', 'data-fragment', 'data-alias'],
    TH: ['align'],
    TD: ['align'],
    OL: ['start'],
}

function sanitize(root: DocumentFragment | Element): void {
    for (const node of [...root.children]) {
        if (DROPPED.has(node.tagName)) {
            node.remove()
            continue
        }
        sanitize(node)
        if (!ALLOWED.has(node.tagName)) {
            node.replaceWith(...node.childNodes)
            continue
        }
        const kept = KEPT_ATTRIBUTES[node.tagName] ?? []
        for (const attr of [...node.attributes]) if (!kept.includes(attr.name)) node.removeAttribute(attr.name)
        const url = node.getAttribute('href') ?? node.getAttribute('src')
        if (url !== null && !/^(?:https?:|mailto:|#|blob:)/i.test(url.trim())) {
            node.removeAttribute('href')
            node.removeAttribute('src')
        }
        if (node.tagName === 'A') {
            node.setAttribute('target', '_blank')
            node.setAttribute('rel', 'noopener noreferrer')
        }
    }
}

/** `markdown` rendered with the note's parser, sanitized. */
export function renderMarkdown(editor: Editor, markdown: string): DocumentFragment {
    const md = (editor.storage as any).markdown?.parser?.md
    const template = document.createElement('template')
    if (md) template.innerHTML = md.render(markdown)
    else {
        const p = document.createElement('p')
        p.textContent = markdown
        template.content.append(p)
    }
    sanitize(template.content)
    return template.content
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
// What is being written is kept in this browser (never in the note, never
// seen by anyone else) until it is posted, so a card closed or a note
// reopened does not lose it.

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
