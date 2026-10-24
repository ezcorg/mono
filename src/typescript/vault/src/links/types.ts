/**
 * The link contracts a host supplies to the editor. The editor renders and
 * follows links through a `LinkResolver` and shows backlinks through a
 * `LinkIndex`; it never decides on its own what a link points at. This
 * package implements both over any `VfsInterface` (`Vault`); another host
 * may implement them any way it likes (icanhaz's links capability does).
 */

/** One link: the note it is in, the vault path it resolves to, its line. */
export interface LinkRef {
    source: string
    target: string
    line: number
}

export interface LinkIndex {
    /** The links into `note` (a vault path). */
    backlinks(note: string): Promise<LinkRef[]>
    /** Every link in the vault whose target does not exist. */
    unresolved(): Promise<LinkRef[]>
    /** Move a note and rewrite every link to it; how many links changed. */
    rename(oldPath: string, newPath: string): Promise<number>
    /** Be told when the answers above may have changed. Returns an unsubscribe. */
    subscribe?(listener: () => void): () => void
}

/** Where a link leads: the vault path it names, and whether that exists yet
 *  (a link to a note not written yet still has a path it would create). */
export interface LinkResolution {
    path: string
    exists: boolean
}

/** A note offered after `[[`: its path, and the text to write between the
 *  brackets so it resolves to that path from the note being edited. */
export interface LinkSuggestion {
    path: string
    link: string
    title?: string
}

export type LinkSyntax = 'wikilink' | 'markdown'

export interface LinkResolver {
    /**
     * Resolve a link target as written (`plan`, `notes/plan.md`, `../a.md`)
     * in the note at `from`. `syntax` says which rules apply: a wikilink
     * resolves by name anywhere in the vault; a Markdown link by path from
     * the note. Null when the target cannot name a file at all.
     */
    resolve(target: string, from: string | null, syntax?: LinkSyntax): Promise<LinkResolution | null>
    /** Notes to offer while typing a wikilink, best first. */
    suggest?(query: string, from: string | null, limit?: number): Promise<LinkSuggestion[]>
    /** Be told when resolutions may have changed (a note created, moved or deleted). */
    subscribe?(listener: () => void): () => void
}
