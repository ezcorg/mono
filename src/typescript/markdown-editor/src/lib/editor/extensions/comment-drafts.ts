/**
 * Comments written but not yet published: kept in this browser, per note,
 * until they are published all at once (or one by one) or discarded. A
 * draft is what a comment's document would hold, the reference and the
 * text, plus what it answers when it is a reply; publishing writes the
 * documents in the order the drafts were made, so a reply's parent is
 * there before it.
 */
import type { Wikilink } from '@joinezco/storage'

export interface QueuedComment {
    /** `draft:…`, unique in this browser. */
    id: string
    /** What the comment references: a range of the note (a reply's is made
     *  when it is published, from its parent's text then). */
    link: Wikilink | null
    /** Where its document goes (a reply's follows its parent's). */
    folder: string
    /** The comment it answers, by id, or null for a comment on the note. */
    replyTo: string | null
    body: string
    /** When it was written, `YYYY-MM-DDTHH:MM` in local time, as the
     *  documents' names say it. */
    at: string
}

const QUEUE_PREFIX = 'ezco-mde-comment-queue:'

export const queueKey = (note: string) => `${QUEUE_PREFIX}${note}`

export function readQueue(note: string): QueuedComment[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(queueKey(note)) ?? '[]') as unknown
        return Array.isArray(parsed) ? parsed.filter((q): q is QueuedComment => !!q && typeof q === 'object' && typeof (q as QueuedComment).id === 'string') : []
    } catch {
        return []
    }
}

export function writeQueue(note: string, items: QueuedComment[]): void {
    try {
        if (items.length) localStorage.setItem(queueKey(note), JSON.stringify(items))
        else localStorage.removeItem(queueKey(note))
    } catch {
        // Nothing to keep it in: the drafts are lost with the page.
    }
}

export const draftId = () => `draft:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Now, as a comment document's name says it (`2026-09-28T16:20`). */
export function localStamp(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** `ids` and every draft answering one of them, transitively. */
export function withAnswers(items: QueuedComment[], ids: Iterable<string>): Set<string> {
    const chosen = new Set(ids)
    let grew = true
    while (grew) {
        grew = false
        for (const q of items) {
            if (q.replyTo && chosen.has(q.replyTo) && !chosen.has(q.id)) {
                chosen.add(q.id)
                grew = true
            }
        }
    }
    return chosen
}
