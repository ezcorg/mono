import { Node, Extension, mergeAttributes, InputRule } from '@tiptap/core'
import { Plugin, PluginKey, Selection, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { findWrapping } from '@tiptap/pm/transform'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import StockTaskList from '@tiptap/extension-task-list'
import taskListPlugin from 'markdown-it-task-lists'
import { eachToken, setupOnce } from './markdown-it'

/**
 * Lists: the bullet list with its marker kept (`-` or `*`), the ordered
 * list with its numbering kept (`1.` or `1)`, and letters, `a.` or `a)`,
 * as Pandoc's fancy lists have them), and the way one kind of list item
 * becomes another by typing the other kind's marker.
 *
 * Drop-in replacements for StarterKit's `bulletList` and `orderedList`
 * (same names and schemas, so ListItem, ListKeymap, tiptap-markdown and the
 * block-action menu keep working) with these behaviours layered on:
 *
 * 1. Disambiguated keyboard creation:
 *      `* ` / `+ ` → bullet list immediately.
 *      `- `        → DELAYED. A lone "- " does nothing yet, because it might
 *                    be the start of a task ("- [ ]"). It becomes a bullet
 *                    only once a non-"[" character follows (`- a`, `- 1`, …),
 *                    keeping that character — leaving the task-list rule
 *                    (taskitem.ts) free to win on `- [ ] ` / `- [x] `.
 *      `1. `, `1) `, `a. `, `a) ` → an ordered list, numbered or lettered.
 *
 * 2. Marker distinction: dash lists (`-`) and star lists (`*`) are tracked
 *    separately via a `marker` attribute, rendered differently (dash glyph
 *    vs disc), and round-trip to/from markdown with their original marker;
 *    an ordered list keeps its `delimiter` (`.` or `)`) and its `type`
 *    (`a`, `A`, or numbers).
 *
 * 3. Switching kind mid-flow: typing a *different* marker at the start of a
 *    list item makes the item one of that kind, in a list of its own split
 *    off from the one it was in — matching CommonMark, where changing the
 *    marker begins a new list. (So `- one` ⏎ `* two` yields a dash list
 *    followed by a star list, `- one` ⏎ `1. two` a dash list then a
 *    numbered one, and `- [ ] ` in a bullet item a task.) Nested, the same:
 *    Tab into a bullet item and type `1. ` for a numbered list inside it.
 *
 * 4. A list holding tasks and plain items both (GFM allows it; the schema
 *    does not) is read as a task list and a bullet list side by side.
 */

/** What a list item is made into. */
export interface ListTarget {
    list: 'bulletList' | 'orderedList' | 'taskList'
    item: 'listItem' | 'taskItem'
    /** The list's attributes; all but `start` tell its kind apart. */
    listAttrs?: Record<string, unknown>
    itemAttrs?: Record<string, unknown>
}

/** The depth of the list item `$from` is in, or -1. */
function itemDepth($from: ResolvedPos): number {
    for (let d = $from.depth; d > 0; d--) {
        const name = $from.node(d).type.name
        if (name === 'listItem' || name === 'taskItem') return d
    }
    return -1
}

/** Whether `list` (holding `item`) is already a list of `target`'s kind. */
function isOfKind(list: PMNode, item: PMNode, target: ListTarget): boolean {
    if (list.type.name !== target.list || item.type.name !== target.item) return false
    for (const [key, value] of Object.entries(target.listAttrs ?? {})) {
        if (key !== 'start' && list.attrs[key] !== value) return false
    }
    return true
}

/**
 * The item `$from` is in, made an item of a `target` list: the list is
 * split around it and the item stands alone in a new list of the target's
 * kind, the caret where it was in the item (CommonMark: a change of marker
 * starts a new list). False when `$from` is in no list item, or its list is
 * of that kind already. Call after any marker text has been taken out of
 * the paragraph; `$from` is resolved against `tr.doc`.
 */
export function retypeListItem(tr: Transaction, $from: ResolvedPos, target: ListTarget): boolean {
    const liDepth = itemDepth($from)
    if (liDepth < 1) return false
    const listDepth = liDepth - 1
    const list = $from.node(listDepth)
    const item = $from.node(liDepth)
    if (isOfKind(list, item, target)) return false
    const schema = tr.doc.type.schema
    const listType = schema.nodes[target.list]
    const itemType = schema.nodes[target.item]
    if (!listType || !itemType) return false

    const itemStart = $from.before(liDepth)
    const itemEnd = $from.after(liDepth)
    const caret = $from.pos - itemStart
    const index = $from.index(listDepth)
    // The list split after the item, then before it: the item alone in a
    // list, which is then replaced by one of the target's kind.
    if (index < list.childCount - 1) tr.split(itemEnd, 1)
    if (index > 0) tr.split(itemStart, 1)
    const listPos = index > 0 ? itemStart + 1 : $from.before(listDepth)
    const single = tr.doc.nodeAt(listPos)
    const alone = tr.doc.nodeAt(index > 0 ? itemStart + 2 : itemStart)
    if (!single || !alone) return false
    const itemAttrs = { ...(target.item === 'taskItem' ? { checked: false } : {}), ...target.itemAttrs }
    const made = listType.create(target.listAttrs ?? null, itemType.create(itemAttrs, alone.content))
    tr.replaceWith(listPos, listPos + single.nodeSize, made)
    tr.setSelection(TextSelection.create(tr.doc, listPos + 1 + caret))
    return true
}

/**
 * An input rule that makes the paragraph typed in an item of a `target`
 * list: the item it is in made one of that kind, or, outside a list, the
 * paragraph wrapped in a new list (joined to the list of that kind right
 * before it, when there is one, as Tiptap's `wrappingInputRule` does).
 * `find`'s match gives the target; the marker is taken out of the text.
 */
function listRule(find: RegExp, targetOf: (match: RegExpMatchArray) => ListTarget): InputRule {
    return new InputRule({
        find,
        handler: ({ state, range, match }) => {
            const target = targetOf(match)
            const { tr } = state
            tr.delete(range.from, range.to)
            const $from = tr.doc.resolve(range.from)
            if (retypeListItem(tr, $from, target)) return
            const listType = state.schema.nodes[target.list]
            const blockRange = $from.blockRange()
            const wrapping = blockRange && findWrapping(blockRange, listType, target.listAttrs ?? null)
            if (!wrapping) return null
            tr.wrap(blockRange, wrapping)
            // The item as the marker says (`- [x] ` makes a done task): the
            // wrapping gave it the item type's defaults.
            if (target.itemAttrs) {
                const item = tr.doc.resolve(blockRange.start + 1).nodeAfter
                if (item) tr.setNodeMarkup(blockRange.start + 1, undefined, { ...item.attrs, ...target.itemAttrs })
            }
            // Joined to the list of the same kind right before it.
            const before = tr.doc.resolve(range.from - 1).nodeBefore
            if (before && isOfKind(before, before.firstChild!, target) && continues(before, target)) tr.join(range.from - 1, 2)
        },
    })
}

/** Whether a list of `target`'s kind typed after `list` goes on with its
 *  numbering (any bullet does). */
function continues(list: PMNode, target: ListTarget): boolean {
    if (target.list !== 'orderedList') return true
    const start = Number(target.listAttrs?.start ?? 1)
    return Number(list.attrs.start ?? 1) + list.childCount === start
}

// ── Bullet lists ────────────────────────────────────────────────────────────

// "* " or "+ " at the start of a block — immediate (bullet-dot) list.
const starBulletInputRegex = /^\s*([*+])\s$/

// "- " followed by exactly one character that is neither whitespace nor "[".
// The trailing char is the first content character; we keep it.
const dashBulletInputRegex = /^-\s([^\s[])$/

/**
 * A list holding task items and plain items both (GFM's `- [ ] a` then
 * `- b`) cannot be one list here: each run of a kind becomes a list of its
 * own, in order, so nothing is read as what it is not.
 */
function splitMixedTaskLists(element: HTMLElement) {
    for (const list of [...element.querySelectorAll('ul.contains-task-list')]) {
        const items = [...list.children]
        if (items.every((li) => li.classList.contains('task-list-item'))) continue
        const runs: { task: boolean; items: Element[] }[] = []
        for (const li of items) {
            const task = li.classList.contains('task-list-item')
            const last = runs[runs.length - 1]
            if (last && last.task === task) last.items.push(li)
            else runs.push({ task, items: [li] })
        }
        for (const run of runs) {
            const ul = document.createElement('ul')
            for (const { name, value } of [...list.attributes]) ul.setAttribute(name, value)
            if (!run.task) {
                ul.classList.remove('contains-task-list')
                ul.removeAttribute('data-type')
                if (!ul.classList.length) ul.removeAttribute('class')
            }
            ul.append(...run.items)
            list.before(ul)
        }
        list.remove()
    }
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
                    setup: (markdownit: any) => setupOnce(markdownit, 'bulletMarker', () => {
                        eachToken(markdownit, 'ezco_bullet_marker', 'bullet_list_open', (token) => {
                            if (token.markup === '-') token.attrSet('data-marker', 'dash')
                        })
                    }),
                    updateDOM: splitMixedTaskLists,
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
        return [
            // `* `/`+ `: a bullet-dot list (the item made one, or a fresh
            // list joined to a bullet list before it, but not to a dash one).
            listRule(starBulletInputRegex, () => ({ list: 'bulletList', item: 'listItem', listAttrs: { marker: 'bullet' } })),
            // `- X`: a dash list, keeping X and the cursor right after it.
            new InputRule({
                find: dashBulletInputRegex,
                handler: ({ state, range, match }) => {
                    const keep = match[1]
                    const { tr } = state
                    // The just-typed char isn't in the doc yet; `range` spans
                    // the "- " marker. Replace it with the kept char.
                    tr.insertText(keep, range.from, range.to)
                    const $from = tr.doc.resolve(range.from)
                    const target: ListTarget = { list: 'bulletList', item: 'listItem', listAttrs: { marker: 'dash' } }
                    if (retypeListItem(tr, $from, target)) {
                        tr.setSelection(TextSelection.create(tr.doc, tr.selection.from + 1))
                        return
                    }
                    // Not in a list item — wrap the (now "X…") paragraph in a
                    // new dash list.
                    const blockRange = $from.blockRange()
                    const wrapping = blockRange && findWrapping(blockRange, this.type, { marker: 'dash' })
                    if (!wrapping) return null
                    tr.wrap(blockRange, wrapping)
                    const before = tr.doc.resolve(range.from - 1).nodeBefore
                    if (before && isOfKind(before, before.firstChild!, target)) tr.join(range.from - 1, 2)
                    // Cursor right after the kept char.
                    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(range.to)))
                },
            }),
        ]
    },
})

// ── Ordered lists ───────────────────────────────────────────────────────────

/** `n` as a list of `type` counts it: `3`, `c`, `C` (then `aa`, as a
 *  spreadsheet's columns go). */
export function orderedLabel(n: number, type: string | null): string {
    if (type !== 'a' && type !== 'A') return String(n)
    let s = ''
    for (let k = Math.max(1, Math.floor(n)); k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(97 + ((k - 1) % 26)) + s
    return type === 'A' ? s.toUpperCase() : s
}

/** The number a letter marker stands for: `a` 1, `z` 26, `aa` 27. */
export function letterIndex(letters: string): number {
    let n = 0
    for (const ch of letters.toLowerCase()) n = n * 26 + (ch.charCodeAt(0) - 96)
    return n
}

/** A letter marker at the start of `line`, Pandoc's way: a lowercase letter
 *  and `.` or `)`, or an uppercase one and `)`, followed by a space (or the
 *  end); an uppercase letter and `.` need two spaces, so an initial ("B.
 *  Russell") is not a list. The marker's length, and what it says. */
function letterMarker(line: string): { length: number; letter: string; delimiter: '.' | ')' } | null {
    const m = /^([a-zA-Z])([.)])( {1,}|$)/.exec(line)
    if (!m) return null
    const [, letter, delimiter, spaces] = m
    if (/[A-Z]/.test(letter) && delimiter === '.' && spaces.length < 2) return null
    return { length: 2, letter, delimiter: delimiter as '.' | ')' }
}

/**
 * markdown-it reads lettered lists through its own list rule: each letter
 * marker of the list is written as `1` for the time the rule runs (the
 * same length, so every offset holds), and the list it makes is marked
 * with its type and where it starts; the letters are put back after. A
 * lettered list interrupts a paragraph only when it starts at `a`, as a
 * numbered one only when it starts at 1.
 */
function letteredListRule(md: any) {
    const list = md.block.ruler.__rules__.find((r: any) => r.name === 'list')?.fn
    if (!list) return
    md.block.ruler.before('list', 'ezco_lettered_list', (state: any, startLine: number, endLine: number, silent: boolean) => {
        if (state.sCount[startLine] - state.blkIndent >= 4) return false
        const indent = state.sCount[startLine]
        const lineAt = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n])
        const first = letterMarker(lineAt(startLine))
        if (!first) return false
        if (silent) return state.parentType !== 'paragraph' || first.letter.toLowerCase() === 'a'
        // The lines that are items of this list: the same indent and kind of
        // marker, until a line less indented (that is not blank) ends it. A
        // numbered item with the same delimiter at the same indent ends it
        // too: the list rule, which cannot tell `1)` from a letter written
        // as `1)`, is held to the lines before it.
        const at: number[] = []
        let stop = endLine
        for (let n = startLine; n < endLine; n++) {
            if (state.isEmpty(n)) continue
            if (state.sCount[n] < indent) break
            if (state.sCount[n] !== indent) continue
            const line = lineAt(n)
            const m = letterMarker(line)
            if (!m || m.delimiter !== first.delimiter) {
                if (n === startLine) return false
                const number = /^\d{1,9}([.)])(\s|$)/.exec(line)
                if (number && number[1] === first.delimiter) {
                    stop = n
                    break
                }
                continue
            }
            at.push(state.bMarks[n] + state.tShift[n])
        }
        const src: string = state.src
        let swapped = src
        for (const pos of at) swapped = swapped.slice(0, pos) + '1' + swapped.slice(pos + 1)
        state.src = swapped
        const listTokIdx = state.tokens.length
        let made = false
        try {
            made = list(state, startLine, stop, false)
        } finally {
            state.src = src
        }
        if (!made) return false
        const open = state.tokens[listTokIdx]
        if (open?.type === 'ordered_list_open') {
            open.attrSet('type', /[A-Z]/.test(first.letter) ? 'A' : 'a')
            const start = letterIndex(first.letter)
            if (start !== 1) open.attrSet('start', String(start))
            else open.attrs = (open.attrs ?? []).filter(([name]: [string]) => name !== 'start')
        }
        return true
    }, { alt: ['paragraph', 'reference', 'blockquote'] })
}

/** The delimiter `node` is written with: its own, unless the ordered list
 *  right before it counts the same way (numbers, or the same letters) and
 *  was written with the same one (then the other, so the two stay two). */
function delimiterFor(node: PMNode, parent: PMNode | null, index: number): '.' | ')' {
    const own = (node.attrs.delimiter === ')' ? ')' : '.') as '.' | ')'
    const before = parent && index > 0 ? parent.child(index - 1) : null
    if (!before || before.type !== node.type || (before.attrs.type ?? null) !== (node.attrs.type ?? null)) return own
    const previous = delimiterFor(before, parent, index - 1)
    return previous === own ? (own === '.' ? ')' : '.') : own
}

export const OrderedList = Node.create({
    name: 'orderedList',

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
            start: {
                default: 1,
                parseHTML: (element) => (element.hasAttribute('start') ? parseInt(element.getAttribute('start') || '', 10) : 1),
                renderHTML: (attributes) => (attributes.start !== 1 ? { start: attributes.start } : {}),
            },
            // `a` or `A` for a lettered list; null for numbers. Rendered as
            // the HTML attribute and as `data-list-type` for the stylesheet:
            // selectors match `type` without regard to case, as HTML has it,
            // so the counter's style keys on the data attribute instead.
            type: {
                default: null,
                parseHTML: (element) => {
                    const type = element.getAttribute('data-list-type') ?? element.getAttribute('type')
                    return type === 'a' || type === 'A' ? type : null
                },
                renderHTML: (attributes) => (attributes.type ? { type: attributes.type, 'data-list-type': attributes.type } : {}),
            },
            // `.` or `)` after the number or letter.
            delimiter: {
                default: '.',
                parseHTML: (element) => (element.getAttribute('data-delimiter') === ')' ? ')' : '.'),
                renderHTML: (attributes) => (attributes.delimiter === ')' ? { 'data-delimiter': ')' } : {}),
            },
        }
    },

    parseHTML() {
        return [{ tag: 'ol' }]
    },

    renderHTML({ HTMLAttributes }) {
        return ['ol', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
    },

    addStorage() {
        return {
            markdown: {
                // Numbers or letters, each with the list's delimiter (an
                // uppercase letter and `.` take two spaces, as Pandoc reads
                // them); two lists in a row take different delimiters so they
                // are read back as two.
                serialize(state, node, parent, index) {
                    const start = Number(node.attrs.start) || 1
                    const type = node.attrs.type as string | null
                    const delimiter = delimiterFor(node, parent, index)
                    const labels = Array.from({ length: node.childCount }, (_, i) => orderedLabel(start + i, type))
                    const width = Math.max(...labels.map((l) => l.length))
                    const gap = type === 'A' && delimiter === '.' ? '  ' : ' '
                    state.renderList(node, state.repeat(' ', width + 1 + gap.length), (i) => state.repeat(' ', width - labels[i].length) + labels[i] + delimiter + gap)
                },
                parse: {
                    setup: (markdownit: any) => setupOnce(markdownit, 'orderedList', () => {
                        letteredListRule(markdownit)
                        // A list written `1)` keeps its delimiter.
                        eachToken(markdownit, 'ezco_ordered_delimiter', 'ordered_list_open', (token) => {
                            if (token.markup === ')') token.attrSet('data-delimiter', ')')
                        })
                    }),
                },
            } as MarkdownNodeSpec,
        }
    },

    addCommands() {
        return {
            toggleOrderedList:
                () =>
                ({ commands }) =>
                    commands.toggleList(this.name, this.options.itemTypeName, false),
        }
    },

    addKeyboardShortcuts() {
        return {
            'Mod-Shift-7': () => this.editor.commands.toggleOrderedList(),
        }
    },

    addInputRules() {
        return [
            // `1. ` or `1) `: numbered, from that number.
            listRule(/^(\d+)([.)])\s$/, (match) => ({ list: 'orderedList', item: 'listItem', listAttrs: { start: +match[1], type: null, delimiter: match[2] } })),
            // `a. ` or `a) `: lettered, from that letter.
            listRule(/^([a-z])([.)])\s$/, (match) => ({ list: 'orderedList', item: 'listItem', listAttrs: { start: letterIndex(match[1]), type: 'a', delimiter: match[2] } })),
        ]
    },
})

/**
 * The task list, written back as it was written: tiptap-markdown gives
 * only bullet and numbered lists a `tight` attribute and writes every task
 * list with its one `bulletListMarker`, so `- [ ] a` on two lines came back
 * as `* [ ] a` with a blank line between. This one keeps the marker (the
 * bullet list's `data-marker` rule tags task lists too, since they are
 * bullet lists to markdown-it) and the tightness, and serializes as the
 * bullet list does; the parse is tiptap-markdown's (its task-list plugin,
 * applied once), with `data-type` set for the node to be found.
 */
export const TaskList = StockTaskList.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            marker: {
                default: 'bullet',
                parseHTML: (element: HTMLElement) => (element.getAttribute('data-marker') === 'dash' ? 'dash' : 'bullet'),
                renderHTML: (attributes: Record<string, unknown>) => (attributes.marker === 'dash' ? { 'data-marker': 'dash' } : {}),
            },
            tight: {
                default: true,
                parseHTML: (element: HTMLElement) => element.getAttribute('data-tight') === 'true' || !element.querySelector('p'),
                renderHTML: (attributes: Record<string, unknown>) => (attributes.tight ? { class: 'tight', 'data-tight': 'true' } : {}),
            },
        }
    },

    addStorage() {
        return {
            markdown: {
                serialize(state, node) {
                    const marker = node.attrs.marker === 'dash' ? '-' : '*'
                    return state.renderList(node, '  ', () => `${marker} `)
                },
                parse: {
                    setup: (markdownit: any) => setupOnce(markdownit, 'taskList', () => markdownit.use(taskListPlugin)),
                    updateDOM(element: HTMLElement) {
                        for (const list of element.querySelectorAll('.contains-task-list')) list.setAttribute('data-type', 'taskList')
                    },
                },
            } as MarkdownNodeSpec,
        }
    },
})

/** The task-list input rules, for taskitem.ts: `- [ ] ` (or `[ ] ` in a
 *  list item) makes the item a task, or wraps the paragraph in a task list. */
export function taskListRules(regex: RegExp): InputRule[] {
    const target = (checked: string): ListTarget => ({ list: 'taskList', item: 'taskItem', itemAttrs: { checked: checked === 'x' || checked === 'X' } })
    return [
        listRule(regex, (match) => target(match[1])),
        new InputRule({
            find: /^\[( |x|X)\]\s$/,
            handler: ({ state, range, match }) => {
                const { tr } = state
                tr.delete(range.from, range.to)
                if (!retypeListItem(tr, tr.doc.resolve(range.from), target(match[1]))) return null
            },
        }),
    ]
}

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

/** The item types a list holds (a plain or a task item). */
const ITEM_TYPES = new Set(['listItem', 'taskItem'])

/**
 * Backspace in an empty list item takes the item away and nothing else:
 * the caret goes to the end of the line before it, and the items after it
 * stay where they are, at their depth. (Tiptap's list keymap lifts the
 * item instead, which makes the items after it the lifted item's own, and
 * lifting again puts them out of their list: a level lost for every
 * Backspace. Taking an item out of a list stays an act of its own: ⇧Tab,
 * or Outdent.) An empty item that holds a list of its own (Enter at the end
 * of an item that has one leaves the list in the new item) joins the item
 * before it, which gets the list back. The first item of a list that has
 * nothing before it, or holds a list, is lifted as before.
 */
export const ListItemBackspace = Extension.create({
    name: 'listItemBackspace',
    // Above Tiptap's list keymap (101), which would lift the item.
    priority: 110,

    addKeyboardShortcuts() {
        return {
            Backspace: ({ editor }) => {
                if (editor.commands.undoInputRule()) return true
                const { state } = editor
                const { $from, empty } = state.selection
                if (!empty || $from.depth < 2 || $from.parent.content.size || $from.parentOffset) return false
                const itemDepth = $from.depth - 1
                const item = $from.node(itemDepth)
                // The empty paragraph is the item's first child.
                if (!ITEM_TYPES.has(item.type.name) || $from.index(itemDepth) !== 0) return false
                const holdsList = item.childCount > 1
                const start = $from.before(itemDepth)
                const end = $from.after(itemDepth)
                const tr = state.tr
                if ($from.index(itemDepth - 1) > 0) {
                    // An item before it in the list.
                    if (holdsList) {
                        // Joined to the item before; the empty paragraph (now
                        // right before the join) goes.
                        tr.join(start)
                        tr.delete(start - 1, start + 1)
                        tr.setSelection(Selection.near(tr.doc.resolve(start - 1), -1))
                    } else {
                        tr.delete(start, end)
                        tr.setSelection(Selection.near(tr.doc.resolve(start), -1))
                    }
                } else {
                    // The first item of a list in an item (the parent's text
                    // is the line before): the item goes, or the whole list
                    // when it is the only one.
                    const listDepth = itemDepth - 1
                    if (holdsList || listDepth < 1 || !ITEM_TYPES.has($from.node(listDepth - 1).type.name)) return false
                    const only = $from.node(listDepth).childCount === 1
                    const from = only ? $from.before(listDepth) : start
                    tr.delete(from, only ? $from.after(listDepth) : end)
                    tr.setSelection(Selection.near(tr.doc.resolve(from), -1))
                }
                editor.view.dispatch(tr.scrollIntoView())
                return true
            },
        }
    },
})
