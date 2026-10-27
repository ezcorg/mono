/**
 * Runs of code blocks: fences standing next to each other at the top of
 * the note, nothing between them. A run is drawn as one window with a tab
 * per fence (code-tabs.ts), folds as one block (folding.ts), and is copied
 * or commented on whole (block-actions.ts). Shared here so folding need
 * not know about tabs. An empty paragraph (written as a non-breaking
 * space) between two fences keeps them apart.
 */
import type { Node as PMNode } from '@tiptap/pm/model'

export const CODE_BLOCK = 'ezcodeBlock'

export interface CodeRun {
    /** The start of the first block and the end of the last. */
    from: number
    to: number
    blocks: { pos: number; node: PMNode }[]
}

/** The runs of `doc`, in order; a lone fence is a run of one. */
export function codeRuns(doc: PMNode): CodeRun[] {
    const runs: CodeRun[] = []
    let run: CodeRun | null = null
    doc.forEach((node, offset) => {
        if (node.type.name !== CODE_BLOCK) {
            run = null
            return
        }
        if (!run) runs.push((run = { from: offset, to: offset + node.nodeSize, blocks: [] }))
        run.blocks.push({ pos: offset, node })
        run.to = offset + node.nodeSize
    })
    return runs
}

/** The run holding the top-level block at `pos`, if that is a code block. */
export function codeRunAt(doc: PMNode, pos: number): CodeRun | null {
    return codeRuns(doc).find((run) => pos >= run.from && pos < run.to) ?? null
}
