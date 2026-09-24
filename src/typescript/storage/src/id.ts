/**
 * Note identity: an `id:` in a note's front matter, generated once and kept
 * through renames and moves (RFC §3). Ids are ULIDs: 26 characters of
 * Crockford base32, time first, so they sort by creation and never collide
 * in practice across devices.
 */

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
    const m = /^---\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)
    return m ? m[1] ?? '' : null
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
