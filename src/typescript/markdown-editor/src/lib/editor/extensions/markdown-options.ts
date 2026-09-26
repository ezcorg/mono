/**
 * The Markdown (de)serialization options, one set for every editor built
 * here (the note's, a comment's), so a document round-trips the same
 * whichever built it.
 */
export const MARKDOWN_OPTIONS = {
    html: false,
    tightLists: true,
    tightListClass: 'tight',
    bulletListMarker: '*',
    linkify: true,
    breaks: true,
    transformPastedText: true,
    transformCopiedText: true,
} as const
