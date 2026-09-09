import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { computeHeadingSlugs } from './slug-utils'

/**
 * Give every heading a real DOM `id` derived from its text (slugified +
 * deduplicated via `computeHeadingSlugs`), so the document has actual header
 * anchors: the outline sidebar links to `#<id>`, and any heading is
 * deep-linkable / its link is copyable.
 *
 * Applied as node Decorations (recomputed per editor state, the same pattern as
 * `OrderedListStart` in lists.ts), so the ids live only in the rendered DOM and
 * never leak into Markdown serialization (`getMarkdown()` stays clean).
 */
export const HeadingAnchors = Extension.create({
    name: 'headingAnchors',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('headingAnchors'),
                props: {
                    decorations(state) {
                        const slugs = computeHeadingSlugs(state.doc)
                        if (!slugs.length) return DecorationSet.empty
                        return DecorationSet.create(
                            state.doc,
                            slugs.map(({ pos, nodeSize, slug }) =>
                                Decoration.node(pos, pos + nodeSize, { id: slug }),
                            ),
                        )
                    },
                },
            }),
        ]
    },
})
