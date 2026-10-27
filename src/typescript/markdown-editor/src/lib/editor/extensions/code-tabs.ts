/**
 * Code tabs: fences standing next to each other in the note (nothing
 * between them, code-runs.ts) are one group, drawn as one window with a
 * tab per fence. One block of the group is the active one, shown with the
 * group's tabs in its toolbar (codeblock's `ToolbarHost.tabs`); the others
 * are hidden. A tab pressed shows its block; its × deletes the block, as
 * "Delete" in the block's menu does; "+" after the last adds an empty
 * block to the group and opens its field, so the file chosen becomes the
 * new tab. Which block is active is the view's, like a fold: the note is
 * written as fences, one after another, and reads so anywhere else.
 *
 * Markdown has no way to group fences, so adjacency is the rule, and it
 * is kept deliberate: a fence typed (or asked for by the slash command)
 * right after a group gets an empty paragraph before it, since the group's
 * own "+" is the way to add to it. The caret never lands in a hidden
 * block: arrowing down out of the active block leaves the group, up into
 * it from below enters the active block, and a tab chosen while the caret
 * was in the group moves the caret to the block shown.
 */
import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { getFileIcon, type ToolbarTab } from '@joinezco/codeblock'
import { CODE_BLOCK, codeRunAt, codeRuns, type CodeRun } from './code-runs'
import { foldAt, foldingKey } from './folding'

export interface CodeTabsState {
    /** The blocks chosen to be shown, one in each group that has had a choice made. */
    active: number[]
}

export const codeTabsKey = new PluginKey<CodeTabsState>('codeTabs')

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        codeTabs: {
            /** Show the `index`th block of the group the block at `pos` stands in. */
            activateCodeTab: (pos: number, index: number) => ReturnType
            /** Delete the `index`th block of the group the block at `pos` stands in. */
            closeCodeTab: (pos: number, index: number) => ReturnType
            /** Add an empty block after the group the block at `pos` stands in, shown, its field open. */
            addCodeTab: (pos: number) => ReturnType
        }
    }
}

/** The block shown of `run`: the one chosen, else the first. */
export function activeBlockOf(state: EditorState, run: CodeRun): number {
    const { active } = codeTabsKey.getState(state) ?? { active: [] }
    return run.blocks.find((b) => active.includes(b.pos))?.pos ?? run.blocks[0].pos
}

/** Whether the top-level block at `pos` is a group's hidden one. */
export function isHiddenCodeTab(state: EditorState, pos: number): boolean {
    const run = codeRunAt(state.doc, pos)
    return !!run && run.blocks.length > 1 && activeBlockOf(state, run) !== pos
}

/** What a block is called on its tab: its file, else its language. */
function labelOf(node: PMNode): string {
    const { file, language } = node.attrs as { file?: string | null; language?: string }
    return file || language || 'code'
}

/** The tabs of the group the block at `pos` stands in, for its toolbar. */
export function codeTabsAt(state: EditorState, pos: number): ToolbarTab[] {
    const run = codeRunAt(state.doc, pos)
    if (!run) return []
    const active = activeBlockOf(state, run)
    return run.blocks.map((block, i) => {
        const { file, language } = block.node.attrs as { file?: string | null; language?: string }
        const icon = getFileIcon(file || (language ? `file.${language}` : 'file'))
        return { id: String(i), label: labelOf(block.node), icon: icon.glyph, iconColor: icon.color, active: block.pos === active }
    })
}

/** What `tr`'s block at the selection must not join: a code block right
 *  before it. An empty paragraph goes between, so a fence made by typing
 *  or by the slash command stands apart from a group above it (the group's
 *  "+" is the way in). */
export function keepApartFromCodeAbove(tr: Transaction): void {
    const $from = tr.selection.$from
    if ($from.depth < 1) return
    const index = $from.index(0)
    if (index === 0 || $from.node(1).type.name !== CODE_BLOCK) return
    if (tr.doc.child(index - 1).type.name !== CODE_BLOCK) return
    tr.insert($from.before(1), tr.doc.type.schema.nodes.paragraph.create())
}

/** The top-level block the selection is in or on, if any. */
function blockOfSelection(selection: Selection): number | null {
    if (selection instanceof NodeSelection) return selection.from
    const { $from } = selection
    return $from.depth >= 1 ? $from.before(1) : null
}

export const CodeTabs = Extension.create({
    name: 'codeTabs',

    addCommands() {
        return {
            activateCodeTab:
                (pos, index) =>
                ({ state, tr, dispatch }) => {
                    const run = codeRunAt(state.doc, pos)
                    const block = run?.blocks[index]
                    if (!run || !block) return false
                    if (dispatch) {
                        tr.setMeta(codeTabsKey, { activate: block.pos })
                        // A folded group shows its first block alone: a tab
                        // chosen in one opens it.
                        const fold = foldAt(state, run.from)
                        if (fold) tr.setMeta(foldingKey, { remove: fold })
                    }
                    return true
                },
            closeCodeTab:
                (pos, index) =>
                ({ state, tr, dispatch, view }) => {
                    const run = codeRunAt(state.doc, pos)
                    const block = run?.blocks[index]
                    if (!run || !block) return false
                    if (dispatch) {
                        // The shown block closed: the tab beside it is shown
                        // next (the one after, else before). Another closed:
                        // the shown block stays (its position mapped).
                        const wasShown = activeBlockOf(state, run) === block.pos
                        const next = run.blocks[index + 1] ?? run.blocks[index - 1]
                        tr.delete(block.pos, block.pos + block.node.nodeSize)
                        if (wasShown && next) tr.setMeta(codeTabsKey, { activate: next.pos > block.pos ? next.pos - block.node.nodeSize : next.pos })
                        if (wasShown) tr.setSelection(Selection.near(tr.doc.resolve(Math.min(block.pos, tr.doc.content.size)), next && next.pos < block.pos ? -1 : 1))
                        view.focus()
                    }
                    return true
                },
            addCodeTab:
                (pos) =>
                ({ state, tr, dispatch }) => {
                    const run = codeRunAt(state.doc, pos)
                    if (!run) return false
                    if (dispatch) {
                        const block = state.schema.nodes[CODE_BLOCK].create({ language: '' })
                        tr.insert(run.to, block)
                        tr.setMeta(codeTabsKey, { activate: run.to })
                        // The caret inside: its view, made for an empty block,
                        // opens its field (codeblock.ts, `wasCreatedEmpty`).
                        tr.setSelection(TextSelection.near(tr.doc.resolve(run.to + 1)))
                    }
                    return true
                },
        }
    },

    addProseMirrorPlugins() {
        return [
            new Plugin<CodeTabsState>({
                key: codeTabsKey,
                state: {
                    init: () => ({ active: [] }),
                    apply(tr, value) {
                        let active = value.active
                        if (tr.docChanged) {
                            // Mapped by the token before the block (assoc -1): a
                            // block given a file is replaced around its content
                            // (`setNodeMarkup`), and by the token after, that
                            // replacement reads as the position deleted. What is
                            // at the mapped position must still be a code block.
                            active = active
                                .map((pos) => {
                                    const mapped = tr.mapping.mapResult(pos, -1)
                                    return mapped.deletedAfter && mapped.deletedBefore ? -1 : mapped.pos
                                })
                                .filter((pos) => pos >= 0 && tr.doc.nodeAt(pos)?.type.name === CODE_BLOCK)
                        }
                        const meta = tr.getMeta(codeTabsKey) as { activate?: number } | undefined
                        if (meta?.activate !== undefined) {
                            const run = codeRunAt(tr.doc, meta.activate)
                            active = active.filter((pos) => !run || pos < run.from || pos >= run.to)
                            active = [...active, meta.activate]
                        }
                        return active === value.active ? value : { active }
                    },
                },
                appendTransaction(transactions, oldState, newState) {
                    // The caret out of a hidden block. From the shown block it
                    // is leaving the group: on past it in that direction. From
                    // outside it is entering the group: into the shown block
                    // (its end from below, its start from above). Anywhere
                    // else (a tab chosen while the caret was in the group): the
                    // shown block's start.
                    const pos = blockOfSelection(newState.selection)
                    if (pos === null || !isHiddenCodeTab(newState, pos)) return null
                    const run = codeRunAt(newState.doc, pos)!
                    const shown = activeBlockOf(newState, run)
                    const shownNode = newState.doc.nodeAt(shown)!
                    const start = TextSelection.create(newState.doc, shown + 1)
                    const end = TextSelection.create(newState.doc, shown + shownNode.nodeSize - 1)
                    const moved = transactions.some((tr) => tr.selectionSet)
                    const wasIn = blockOfSelection(oldState.selection)
                    const was = oldState.selection.from
                    let selection: Selection = start
                    if (moved && wasIn === shown) {
                        if (pos > shown) selection = run.to < newState.doc.content.size ? Selection.near(newState.doc.resolve(run.to), 1) : end
                        else selection = run.from > 0 ? Selection.near(newState.doc.resolve(run.from), -1) : start
                    } else if (moved && was >= run.to) selection = end
                    return newState.tr.setSelection(selection)
                },
                props: {
                    decorations(state) {
                        const decorations: Decoration[] = []
                        for (const run of codeRuns(state.doc)) {
                            const shown = activeBlockOf(state, run)
                            // What the group's tabs are, as a string: a change in
                            // it (a block added, taken, renamed, or shown instead)
                            // reaches every block's view, which draws its tabs again.
                            const tabs = run.blocks.map((b) => `${labelOf(b.node)}${b.pos === shown ? '*' : ''}`).join('|')
                            // An attribute, not a class: CodeMirror writes the
                            // block's `class` whole whenever its own changes (on
                            // focus, say), and a class ProseMirror added would go
                            // with it.
                            for (const block of run.blocks) {
                                const hidden = run.blocks.length > 1 && block.pos !== shown
                                decorations.push(
                                    Decoration.node(block.pos, block.pos + block.node.nodeSize, { 'data-tab-hidden': hidden ? 'true' : 'false' }, { tabs }),
                                )
                            }
                        }
                        return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty
                    },
                },
            }),
        ]
    },
})
