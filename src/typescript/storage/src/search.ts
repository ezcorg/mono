/**
 * Search over a folder of files, as a host provides it: files by their path
 * and name, and text files by what they say. The vault package implements
 * it over a `Vault`'s index; an index held elsewhere (a daemon, a peer) can
 * serve it too, which is why it is asynchronous. The toolbar (the command
 * palette) and the code block take this interface, not an index.
 */

export interface SearchHit {
    /** The file's vault path. */
    path: string
    score: number
    /** Whether the query matched the file's path and name, or a note's text. */
    match: 'path' | 'content'
    /** A note's title (its first heading, else its name). */
    title?: string
    /** For a content match: the text around the first place it matched. */
    snippet?: string
    /** For a content match: the 1-based line of that place. */
    line?: number
}

export interface SearchOptions {
    /** At most this many hits (default 50). */
    limit?: number
    /** Search notes' text as well as paths (default true). */
    content?: boolean
}

export interface FileSearch {
    search(query: string, options?: SearchOptions): Promise<SearchHit[]>
}
