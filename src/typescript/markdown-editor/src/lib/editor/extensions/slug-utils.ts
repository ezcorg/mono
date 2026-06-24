import type { Node as PMNode } from '@tiptap/pm/model'

/** Slugify heading text into a URL-fragment-safe id (lowercase, hyphenated). */
export function slugify(text: string): string {
    return text
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '') // strip combining diacritics
        .replace(/[^a-z0-9]+/g, '-') // runs of non-alphanumerics → one hyphen
        .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
}

export interface HeadingSlug {
    /** Position immediately before the heading node. */
    pos: number
    /** The heading node's size (so callers can decorate `[pos, pos+nodeSize]`). */
    nodeSize: number
    /** Unique, deduplicated slug derived from the heading's text. */
    slug: string
}

/**
 * Walk a document's headings in order and assign each a unique slug from its
 * text content, deduplicating collisions (`intro`, `intro-1`, …) and giving
 * empty / symbol-only headings a stable fallback (`section`, `section-1`).
 *
 * Shared by the heading-anchor decorations (which set the DOM `id`) and the
 * outline sidebar (which sets the `href`), so the two always agree.
 */
export function computeHeadingSlugs(doc: PMNode): HeadingSlug[] {
    const out: HeadingSlug[] = []
    const seen = new Map<string, number>()
    doc.descendants((node, pos) => {
        if (node.type.name !== 'heading') return true
        const base = slugify(node.textContent) || 'section'
        const count = seen.get(base) ?? 0
        seen.set(base, count + 1)
        out.push({
            pos,
            nodeSize: node.nodeSize,
            slug: count === 0 ? base : `${base}-${count}`,
        })
        return false // headings have no heading descendants
    })
    return out
}
