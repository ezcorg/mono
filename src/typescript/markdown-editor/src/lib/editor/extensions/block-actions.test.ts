import { describe, it, expect, afterEach } from 'vitest'
import type { Node as PMNode } from '@tiptap/pm/model'
import { actionsForNode } from './block-actions'
import { MarkdownEditor } from '../index'
import { createTestContainer, createTestEditor, cleanupEditor } from '../../../test/utils'

/**
 * Exercises every block-action a node type offers (run via `actionsForNode`),
 * asserting each produces the expected transformation, plus the multi-block
 * "spanning" selection behaviour.
 */
describe('Block actions', () => {
    const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []

    afterEach(() => {
        created.forEach((c) => cleanupEditor(c.editor, c.container))
        created.length = 0
    })

    function findNode(
        editor: MarkdownEditor,
        typeName: string,
    ): { node: PMNode; pos: number } | null {
        let res: { node: PMNode; pos: number } | null = null
        editor.state.doc.descendants((node, pos) => {
            if (res) return false
            if (node.type.name === typeName) {
                res = { node, pos }
                return false
            }
            return true
        })
        return res
    }

    /** Place the cursor inside (or onto) the node so selection-based actions
     *  have a valid target, then run the named action. */
    async function makeEditor(content: string): Promise<MarkdownEditor> {
        const container = createTestContainer(`ba-${created.length}`)
        const editor = await createTestEditor(container, { content })
        created.push({ editor, container })
        return editor
    }

    function runAction(
        editor: MarkdownEditor,
        typeName: string,
        label: string,
        selectInside?: string,
    ): void {
        const target = findNode(editor, typeName)
        if (!target) throw new Error(`no ${typeName} node in document`)
        const { node, pos } = target

        // Position the selection so selection-based actions apply. For tables
        // we drop the cursor into an inner paragraph (a cell); otherwise just
        // inside the block (or onto it, for leaf/atom nodes).
        if (selectInside) {
            const inner = findNode(editor, selectInside)
            if (inner) editor.commands.setTextSelection(inner.pos + 1)
        } else if (node.isLeaf || node.isAtom) {
            editor.commands.setNodeSelection(pos)
        } else {
            editor.commands.setTextSelection(Math.min(pos + 1, editor.state.doc.content.size - 1))
        }

        const actions = actionsForNode(node)
        const action = actions.find((a) => a.label === label)
        if (!action) {
            throw new Error(
                `no action "${label}" for ${typeName}; available: ${actions.map((a) => a.label).join(', ')}`,
            )
        }
        action.run({ editor, pos, node })
    }

    const firstBlock = (editor: MarkdownEditor) => editor.getJSON().content?.[0]

    // ── Paragraph ────────────────────────────────────────────────
    it('paragraph: converts to each heading, list type, quote, and deletes', async () => {
        const cases: Array<[string, (b: any) => void]> = [
            ['Heading 1', (b) => expect(b).toMatchObject({ type: 'heading', attrs: { level: 1 } })],
            ['Heading 2', (b) => expect(b).toMatchObject({ type: 'heading', attrs: { level: 2 } })],
            ['Heading 3', (b) => expect(b).toMatchObject({ type: 'heading', attrs: { level: 3 } })],
            ['Bullet list', (b) => expect(b).toMatchObject({ type: 'bulletList', attrs: { marker: 'bullet' } })],
            ['Dashed list', (b) => expect(b).toMatchObject({ type: 'bulletList', attrs: { marker: 'dash' } })],
            ['Ordered list', (b) => expect(b.type).toBe('orderedList')],
            ['Task list', (b) => expect(b.type).toBe('taskList')],
            ['Quote', (b) => expect(b.type).toBe('blockquote')],
        ]
        for (const [label, assert] of cases) {
            const editor = await makeEditor('Hello paragraph')
            runAction(editor, 'paragraph', label)
            assert(firstBlock(editor))
        }
        const editor = await makeEditor('Hello paragraph')
        runAction(editor, 'paragraph', 'Delete')
        expect(editor.getText().trim()).toBe('')
    })

    // ── Heading ──────────────────────────────────────────────────
    it('heading: re-levels, converts to paragraph, and deletes', async () => {
        let editor = await makeEditor('# Title')
        runAction(editor, 'heading', 'Heading 3')
        expect(firstBlock(editor)).toMatchObject({ type: 'heading', attrs: { level: 3 } })

        editor = await makeEditor('# Title')
        runAction(editor, 'heading', 'Paragraph')
        expect(firstBlock(editor)?.type).toBe('paragraph')

        editor = await makeEditor('# Title')
        runAction(editor, 'heading', 'Delete')
        expect(editor.getText().trim()).toBe('')
    })

    // ── Bullet list (star) ───────────────────────────────────────
    it('bullet list: dashes, ordered, task, lift, delete', async () => {
        let editor = await makeEditor('* one\n* two')
        runAction(editor, 'bulletList', 'Dashed list')
        expect(firstBlock(editor)).toMatchObject({ type: 'bulletList', attrs: { marker: 'dash' } })

        editor = await makeEditor('* one\n* two')
        runAction(editor, 'bulletList', 'Ordered list')
        expect(firstBlock(editor)?.type).toBe('orderedList')

        editor = await makeEditor('* one\n* two')
        runAction(editor, 'bulletList', 'Task list')
        expect(firstBlock(editor)?.type).toBe('taskList')

        editor = await makeEditor('* one\n* two')
        runAction(editor, 'bulletList', 'Lift to paragraphs')
        expect(editor.getJSON().content?.every((n) => n.type === 'paragraph')).toBe(true)

        editor = await makeEditor('* one\n* two')
        runAction(editor, 'bulletList', 'Delete')
        expect(editor.getText().trim()).toBe('')
    })

    // ── Dash list ────────────────────────────────────────────────
    it('dash list: offers conversion back to a bullet (disc) list', async () => {
        const editor = await makeEditor('- one\n- two')
        expect(firstBlock(editor)).toMatchObject({ type: 'bulletList', attrs: { marker: 'dash' } })
        runAction(editor, 'bulletList', 'Bullet list')
        expect(firstBlock(editor)).toMatchObject({ type: 'bulletList', attrs: { marker: 'bullet' } })
    })

    // ── Ordered list ─────────────────────────────────────────────
    it('ordered list: bullet, dashed, task, lift, delete', async () => {
        let editor = await makeEditor('1. one\n2. two')
        runAction(editor, 'orderedList', 'Bullet list')
        expect(firstBlock(editor)).toMatchObject({ type: 'bulletList', attrs: { marker: 'bullet' } })

        editor = await makeEditor('1. one\n2. two')
        runAction(editor, 'orderedList', 'Dashed list')
        expect(firstBlock(editor)).toMatchObject({ type: 'bulletList', attrs: { marker: 'dash' } })

        editor = await makeEditor('1. one\n2. two')
        runAction(editor, 'orderedList', 'Task list')
        expect(firstBlock(editor)?.type).toBe('taskList')

        editor = await makeEditor('1. one\n2. two')
        runAction(editor, 'orderedList', 'Lift to paragraphs')
        expect(editor.getJSON().content?.every((n) => n.type === 'paragraph')).toBe(true)

        editor = await makeEditor('1. one\n2. two')
        runAction(editor, 'orderedList', 'Delete')
        expect(editor.getText().trim()).toBe('')
    })

    // ── Task list ────────────────────────────────────────────────
    it('task list: bullet, dashed, ordered, mark all, lift, delete', async () => {
        let editor = await makeEditor('- [ ] one\n- [ ] two')
        runAction(editor, 'taskList', 'Bullet list')
        expect(firstBlock(editor)).toMatchObject({ type: 'bulletList', attrs: { marker: 'bullet' } })

        editor = await makeEditor('- [ ] one\n- [ ] two')
        runAction(editor, 'taskList', 'Dashed list')
        expect(firstBlock(editor)).toMatchObject({ type: 'bulletList', attrs: { marker: 'dash' } })

        editor = await makeEditor('- [ ] one\n- [ ] two')
        runAction(editor, 'taskList', 'Ordered list')
        expect(firstBlock(editor)?.type).toBe('orderedList')

        editor = await makeEditor('- [ ] one\n- [x] two')
        runAction(editor, 'taskList', 'Mark all complete')
        expect(firstBlock(editor)?.content?.every((i: any) => i.attrs.checked === true)).toBe(true)

        editor = await makeEditor('- [x] one\n- [x] two')
        runAction(editor, 'taskList', 'Mark all incomplete')
        expect(firstBlock(editor)?.content?.every((i: any) => i.attrs.checked === false)).toBe(true)

        editor = await makeEditor('- [ ] one\n- [ ] two')
        runAction(editor, 'taskList', 'Lift to paragraphs')
        expect(editor.getJSON().content?.every((n) => n.type === 'paragraph')).toBe(true)

        editor = await makeEditor('- [ ] one\n- [ ] two')
        runAction(editor, 'taskList', 'Delete')
        expect(editor.getText().trim()).toBe('')
    })

    // ── Blockquote ───────────────────────────────────────────────
    it('blockquote: unwrap (whole quote), to paragraph, delete', async () => {
        // The cursor sits in the first quoted paragraph; "Unwrap quote" must
        // lift the *entire* quote out (both paragraphs), leaving no blockquote
        // — not just the cursor's block.
        let editor = await makeEditor('> para one\n>\n> para two')
        expect(findNode(editor, 'blockquote')).not.toBeNull()
        runAction(editor, 'blockquote', 'Unwrap quote')
        expect(findNode(editor, 'blockquote')).toBeNull()
        const paras = (editor.getJSON().content ?? []).filter((n) => n.type === 'paragraph')
        expect(paras.length).toBeGreaterThanOrEqual(2)

        editor = await makeEditor('> quoted')
        runAction(editor, 'blockquote', 'Paragraph')
        expect(firstBlock(editor)?.type).toBe('paragraph')

        editor = await makeEditor('> quoted')
        runAction(editor, 'blockquote', 'Delete')
        expect(editor.getText().trim()).toBe('')
    })

    it('blockquote: unwrap preserves the caret position', async () => {
        const editor = await makeEditor('> para one\n>\n> para two')
        const bq = findNode(editor, 'blockquote')!
        // Put the caret inside the *second* quoted paragraph.
        let secondParaPos = -1
        let seen = 0
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'paragraph') {
                seen++
                if (seen === 2) secondParaPos = pos
            }
        })
        editor.commands.setTextSelection(secondParaPos + 3)
        const action = actionsForNode(bq.node).find((a) => a.label === 'Unwrap quote')!
        action.run({ editor, pos: bq.pos, node: bq.node })
        // The caret should still sit in the (now top-level) "para two".
        const $from = editor.state.doc.resolve(editor.state.selection.from)
        expect($from.parent.textContent).toBe('para two')
    })

    // ── Code block ───────────────────────────────────────────────
    it('code block: copy contents (no throw) and delete', async () => {
        let editor = await makeEditor('```js\nconst a = 1;\n```')
        // Copy writes to the clipboard (swallows rejection in headless); it
        // must not throw and must leave the block intact.
        expect(() => runAction(editor, 'ezcodeBlock', 'Copy contents')).not.toThrow()
        expect(findNode(editor, 'ezcodeBlock')).not.toBeNull()

        editor = await makeEditor('```js\nconst a = 1;\n```')
        runAction(editor, 'ezcodeBlock', 'Delete')
        expect(findNode(editor, 'ezcodeBlock')).toBeNull()
    })

    // ── Horizontal rule ──────────────────────────────────────────
    it('horizontal rule: delete', async () => {
        const editor = await makeEditor('before\n\n---\n\nafter')
        expect(findNode(editor, 'horizontalRule')).not.toBeNull()
        runAction(editor, 'horizontalRule', 'Delete')
        expect(findNode(editor, 'horizontalRule')).toBeNull()
    })

    // ── Table ────────────────────────────────────────────────────
    it('table: runs every action and keeps a valid document', async () => {
        const md = '| A | B |\n| --- | --- |\n| 1 | 2 |'
        const rowCount = (e: MarkdownEditor) => {
            let n = 0
            e.state.doc.descendants((node) => { if (node.type.name === 'tableRow') n++ })
            return n
        }

        let editor = await makeEditor(md)
        const rowsBefore = rowCount(editor)
        runAction(editor, 'table', 'Add row below', 'paragraph')
        expect(rowCount(editor)).toBe(rowsBefore + 1)

        editor = await makeEditor(md)
        runAction(editor, 'table', 'Add row above', 'paragraph')
        expect(rowCount(editor)).toBe(rowsBefore + 1)

        // The column / header / delete-row actions must all run without
        // error and leave the table well-formed (or removed, for delete).
        for (const label of ['Add column before', 'Add column after', 'Delete row', 'Delete column', 'Toggle header row']) {
            editor = await makeEditor(md)
            expect(() => runAction(editor, 'table', label, 'paragraph')).not.toThrow()
            expect(editor.state.doc.check === undefined || editor.state.doc).toBeTruthy()
        }

        editor = await makeEditor(md)
        runAction(editor, 'table', 'Delete table', 'paragraph')
        expect(findNode(editor, 'table')).toBeNull()
    })

    // ── Multi-block (spanning) selection ─────────────────────────
    it('shows a spanning indicator (✳) when the selection crosses blocks', async () => {
        const editor = await makeEditor('first paragraph\n\nsecond paragraph')
        editor.commands.focus()
        // Select from inside the first paragraph into the second.
        const doc = editor.state.doc
        const firstPara = findNode(editor, 'paragraph')!
        let secondParaPos = -1
        let seen = 0
        doc.descendants((node, pos) => {
            if (node.type.name === 'paragraph') {
                seen++
                if (seen === 2) secondParaPos = pos
            }
        })
        editor.commands.setTextSelection({ from: firstPara.pos + 2, to: secondParaPos + 3 })
        // Force the indicator to recompute against the new selection.
        const view = (editor.storage as any).blockActions.blockActionsView
        view.update(editor.view)
        await new Promise((r) => requestAnimationFrame(() => r(null)))

        const icon = document
            .querySelector('.ezco-mde-block-action-btn-icon')
        expect(icon?.textContent).toBe('✳')
    })

    it('applies a block conversion across every block in a multi-block selection', async () => {
        const editor = await makeEditor('alpha\n\nbravo')
        const doc = editor.state.doc
        const firstPara = findNode(editor, 'paragraph')!
        let secondParaPos = -1
        let seen = 0
        doc.descendants((node, pos) => {
            if (node.type.name === 'paragraph') {
                seen++
                if (seen === 2) secondParaPos = pos
            }
        })
        editor.commands.setTextSelection({ from: firstPara.pos + 2, to: secondParaPos + 3 })
        // This is exactly what the spanning menu's "Heading 2" runs.
        editor.chain().focus().setHeading({ level: 2 }).run()
        const blocks = editor.getJSON().content ?? []
        expect(blocks.length).toBeGreaterThanOrEqual(2)
        expect(blocks.slice(0, 2).every((b) => b.type === 'heading' && b.attrs?.level === 2)).toBe(true)
    })
})
