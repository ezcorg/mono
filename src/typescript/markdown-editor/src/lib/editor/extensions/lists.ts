import { Node, Extension, mergeAttributes, wrappingInputRule, InputRule } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { findWrapping, canSplit } from '@tiptap/pm/transform'
import type { NodeType, ResolvedPos } from '@tiptap/pm/model'
import type { MarkdownNodeSpec } from 'tiptap-markdown'

/**
 * Bullet list with disambiguated dash input and a dash/star marker
 * distinction.
 *
 * Drop-in replacement for StarterKit's `bulletList` (same name/schema, so
 * ListItem, ListKeymap, tiptap-markdown serialization, and the block-action
 * menu keep working) with these behaviours layered on:
 *
 * 1. Disambiguated keyboard creation:
 *      `* ` / `+ ` → bullet list immediately.
 *      `- `        → DELAYED. A lone "- " does nothing yet, because it might
 *                    be the start of a task ("- [ ]"). It becomes a bullet
 *                    only once a non-"[" character follows (`- a`, `- 1`, …),
 *                    keeping that character — leaving the task-list rule
 *                    (taskitem.ts) free to win on `- [ ] ` / `- [x] `.
 *      `1. ` (ordered) is unaffected — it comes from StarterKit's OrderedList.
 *
 * 2. Marker distinction: dash lists (`-`) and star lists (`*`) are tracked
 *    separately via a `marker` attribute, rendered differently (dash glyph
 *    vs disc), and round-trip to/from markdown with their original marker.
 *
 * 3. Switching marker mid-flow: typing a *different* marker at the start of a
 *    list item starts a new, adjacent list with that marker — matching
 *    CommonMark, where changing the bullet marker begins a new list. (So
 *    `- one` ⏎ `* two` yields a dash list followed by a star list, instead
 *    of "* two" landing as literal text in a dash item.)
 */

// "* " or "+ " at the start of a block — immediate (bullet-dot) list.
const starBulletInputRegex = /^\s*([*+])\s$/

// "- " followed by exactly one character that is neither whitespace nor "[".
// The trailing char is the first content character; we keep it.
const dashBulletInputRegex = /^-\s([^\s[])$/

/**
 * If `$from` sits in a bullet list item whose list uses a *different* marker
 * than `newMarker`, split the list before that item so the item begins a new
 * adjacent list with `newMarker`. Returns true if it acted. `$from` and the
 * positions are resolved against `tr.doc` (call after any marker text has
 * already been removed from the paragraph).
 */
function switchListMarker(
    tr: Transaction,
    $from: ResolvedPos,
    type: NodeType,
    newMarker: 'dash' | 'bullet',
): boolean {
    let liDepth = -1
    for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'listItem') {
            liDepth = d
            break
        }
    }
    if (liDepth < 1) return false
    const listDepth = liDepth - 1
    const listNode = $from.node(listDepth)
    if (listNode.type !== type || listNode.attrs.marker === newMarker) return false

    const typesAfter = [{ type, attrs: { marker: newMarker } }]
    if ($from.index(listDepth) === 0) {
        // First item — nothing to split off; retype the whole (typically
        // single-item) list's marker.
        tr.setNodeMarkup($from.before(listDepth), undefined, {
            ...listNode.attrs,
            marker: newMarker,
        })
        return true
    }
    const liStart = $from.before(liDepth)
    if (!canSplit(tr.doc, liStart, 1, typesAfter)) return false
    tr.split(liStart, 1, typesAfter)
    return true
}

export const BulletList = Node.create({
    name: 'bulletList',

    addOptions() {
        return {
            itemTypeName: 'listItem',
            HTMLAttributes: {},
        }
    },

    group: 'block list',

    content() {
        return `${this.options.itemTypeName}+`
    },

    addAttributes() {
        return {
            // 'dash' for `-` lists (rendered with a dash glyph), 'bullet'
            // for `*`/`+` lists (rendered with the usual disc).
            marker: {
                default: 'bullet',
                parseHTML: (element) =>
                    element.getAttribute('data-marker') === 'dash' ? 'dash' : 'bullet',
                renderHTML: (attributes) =>
                    attributes.marker === 'dash' ? { 'data-marker': 'dash' } : {},
            },
        }
    },

    parseHTML() {
        return [{ tag: 'ul' }]
    },

    renderHTML({ HTMLAttributes }) {
        return ['ul', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
    },

    addStorage() {
        return {
            markdown: {
                // Serialize with the list's own marker so `-` and `*` lists
                // round-trip as themselves (overrides tiptap-markdown's
                // default, which forces the global `bulletListMarker`).
                serialize(state, node) {
                    const marker = node.attrs.marker === 'dash' ? '-' : '*'
                    return state.renderList(node, '  ', () => `${marker} `)
                },
                parse: {
                    // Tag dash-marked bullet lists during markdown-it parsing
                    // so the resulting <ul> carries data-marker="dash", which
                    // `addAttributes` reads back. (`*`/`+` stay the default
                    // bullet marker.)
                    setup(markdownit: any) {
                        if (markdownit.__ezcoBulletMarker) return
                        markdownit.__ezcoBulletMarker = true
                        markdownit.core.ruler.push('ezco_bullet_marker', (state: any) => {
                            for (const token of state.tokens) {
                                if (token.type === 'bullet_list_open' && token.markup === '-') {
                                    token.attrSet('data-marker', 'dash')
                                }
                            }
                        })
                    },
                },
            } as MarkdownNodeSpec,
        }
    },

    addCommands() {
        return {
            toggleBulletList:
                () =>
                ({ commands }) =>
                    commands.toggleList(this.name, this.options.itemTypeName, false),
        }
    },

    addKeyboardShortcuts() {
        return {
            'Mod-Shift-8': () => this.editor.commands.toggleBulletList(),
        }
    },

    addInputRules() {
        const type = this.type
        return [
            // `* `/`+ ` inside a dash list → split off a new star list.
            new InputRule({
                find: /^([*+])\s$/,
                handler: ({ state, range }) => {
                    const { tr } = state
                    tr.delete(range.from, range.to)
                    if (!switchListMarker(tr, tr.doc.resolve(range.from), type, 'bullet')) {
                        return null
                    }
                },
            }),
            // `* `/`+ ` elsewhere → a fresh bullet-dot list (joins an adjacent
            // bullet list, but not a dash one).
            wrappingInputRule({
                find: starBulletInputRegex,
                type,
                getAttributes: () => ({ marker: 'bullet' }),
                joinPredicate: (_match, node) => node.attrs.marker === 'bullet',
            }),
            // `- X` → dash list (or, inside a star list, split off a new dash
            // list), keeping X and the cursor right after it.
            new InputRule({
                find: dashBulletInputRegex,
                handler: ({ state, range, match }) => {
                    const keep = match[1]
                    const { tr } = state
                    // The just-typed char isn't in the doc yet; `range` spans
                    // the "- " marker. Replace it with the kept char.
                    tr.insertText(keep, range.from, range.to)
                    const $from = tr.doc.resolve(range.from)
                    if (switchListMarker(tr, $from, type, 'dash')) return
                    // Not inside a differently-marked list — wrap the (now
                    // "X…") paragraph in a new dash list.
                    const blockRange = $from.blockRange()
                    const wrapping = blockRange && findWrapping(blockRange, type, { marker: 'dash' })
                    if (!wrapping) return null
                    tr.wrap(blockRange, wrapping)
                    // Cursor right after the kept char.
                    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(range.to)))
                },
            }),
        ]
    },
})

/**
 * Ordered lists are numbered with a CSS counter (so the number sits
 * left-aligned in the shared decoration gutter — see styles.ts). A bare
 * `counter-reset` in CSS always restarts at 1, which would drop an ordered
 * list's `start` attribute (e.g. markdown `3. …`). This plugin re-applies a
 * non-default `start` by decorating each `<ol>` with an inline `counter-reset`
 * seeding the counter to `start - 1`. (Lists that start at 1 need nothing —
 * the stylesheet's reset covers them, including nested lists, which each reset
 * their own counter.)
 */
/**
 * When a bullet-list item is indented (Tab → sinkListItem), the new nested
 * `bulletList` is created with the default marker ('bullet'), so indenting a
 * dash list would turn the sublist into a dotted list. This keymap runs the
 * sink and then makes the new nested list's marker match the parent's, so a
 * dash list stays dashed at every level. (Parsing already preserves the
 * marker; this only fixes interactive nesting.)
 */
export const DashListKeymap = Extension.create({
    name: 'dashListKeymap',
    // Above the list keymap (so this Tab runs first) but below the selection
    // menu (priority 1000), which Tabs to its button on a non-empty selection.
    priority: 200,

    addKeyboardShortcuts() {
        return {
            Tab: () => {
                const editor = this.editor
                if (!editor.can().sinkListItem('listItem')) return false
                const { $from } = editor.state.selection
                // Marker of the bullet list we're sinking within (if any).
                let marker: string | null = null
                for (let d = $from.depth; d > 0; d--) {
                    const name = $from.node(d).type.name
                    if (name === 'bulletList') { marker = $from.node(d).attrs.marker; break }
                    if (name === 'orderedList' || name === 'taskList') break
                }
                if (marker == null) return false // not a bullet list → default sink
                return editor
                    .chain()
                    .sinkListItem('listItem')
                    .command(({ tr }) => {
                        // Set the now-nested bulletList's marker to the parent's.
                        const $pos = tr.selection.$from
                        for (let d = $pos.depth; d > 0; d--) {
                            const node = $pos.node(d)
                            if (node.type.name === 'bulletList') {
                                if (node.attrs.marker !== marker) {
                                    tr.setNodeMarkup($pos.before(d), undefined, { ...node.attrs, marker })
                                }
                                break
                            }
                        }
                        return true
                    })
                    .run()
            },
        }
    },
})

export const OrderedListStart = Extension.create({
    name: 'orderedListStart',

    addProseMirrorPlugins() {
        return [
            new Plugin({
                key: new PluginKey('orderedListStart'),
                props: {
                    decorations(state) {
                        const decorations: Decoration[] = []
                        state.doc.descendants((node, pos) => {
                            if (node.type.name !== 'orderedList') return
                            const start = Number(node.attrs.start ?? 1)
                            if (!Number.isFinite(start) || start === 1) return
                            decorations.push(
                                Decoration.node(pos, pos + node.nodeSize, {
                                    style: `counter-reset: ezco-mde-ol ${start - 1}`,
                                }),
                            )
                        })
                        return decorations.length
                            ? DecorationSet.create(state.doc, decorations)
                            : DecorationSet.empty
                    },
                },
            }),
        ]
    },
})
