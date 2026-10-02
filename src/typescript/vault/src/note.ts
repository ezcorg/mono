/**
 * What makes a file a note, and a note's identity: an `id:` in its front
 * matter, generated once and kept through renames and moves (RFC §3). Ids
 * are ULIDs: 26 characters of Crockford base32, time first, so they sort by
 * creation and never collide in practice across devices.
 */
import { extname } from '@joinezco/storage'
import { frontMatterClose, splitLines } from './parse.js'

/** Extensions that are notes: parsed for links, indexed as text, opened as prose. */
export const NOTE_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'markdown', 'mdx'])

/** True when `path` is a Markdown note. */
export function isNote(path: string): boolean {
    return NOTE_EXTENSIONS.has(extname(path))
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A new note id (a ULID). */
export function newNoteId(now: number = Date.now()): string {
    let time = ''
    let t = Math.max(0, Math.floor(now))
    for (let i = 0; i < 10; i++) {
        time = CROCKFORD[t % 32] + time
        t = Math.floor(t / 32)
    }
    const random = new Uint8Array(16)
    crypto.getRandomValues(random)
    let tail = ''
    for (let i = 0; i < 16; i++) tail += CROCKFORD[random[i] % 32]
    return time + tail
}

/** The front matter block at the start of a note: its YAML text (without
 *  the `---` fences), or null when the note has none. */
export function frontMatterOf(text: string): string | null {
    const { lines } = splitLines(text)
    const close = frontMatterClose(lines)
    return close > 0 ? lines.slice(1, close).join('\n') : null
}

/** A note's `id:` from its front matter, or null. */
export function noteIdOf(text: string): string | null {
    const yaml = frontMatterOf(text)
    if (yaml === null) return null
    const m = /^id[ \t]*:[ \t]*(.*?)[ \t]*$/m.exec(yaml)
    if (!m) return null
    const value = m[1].replace(/^(['"])(.*)\1$/, '$2').trim()
    return value || null
}
