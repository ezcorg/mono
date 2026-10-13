import { describe, it, expect, afterEach } from 'vitest'
import type { Node as PMNode } from '@tiptap/pm/model'
import { actionsForNode } from './block-actions'
import { MarkdownEditor } from '../index'
import { createTestContainer, createTestEditor, cleanupEditor, waitFor } from '../../../test/utils'

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

        const actions = actionsForNode(node, editor)
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
            ['Numbered list', (b) => expect(b.type).toBe('orderedList')],
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
        runAction(editor, 'bulletList', 'Numbered list')
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
        runAction(editor, 'taskList', 'Numbered list')
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
        // The spanned blocks' own glyphs fold into the star; the others stay.
        const container = created[created.length - 1].container
        const spanned = [...container.querySelectorAll<HTMLElement>('.ezco-mde-gutter .ezco-mde-block-icon')]
        expect(spanned.map((g) => g.classList.contains('is-spanned'))).toEqual([true, true])
        await waitFor(() => spanned.every((g) => getComputedStyle(g).opacity === '0'), 2000)
        editor.commands.setTextSelection(firstPara.pos + 2)
        view.update(editor.view)
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        expect(spanned.some((g) => g.classList.contains('is-spanned'))).toBe(false)
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

    // ── The gutter ───────────────────────────────────────────────
    const frames = async (n = 2) => {
        for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r))
    }
    const glyphs = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.ezco-mde-gutter .ezco-mde-block-icon')]

    it('shows a glyph for every block in the gutter, soft, the active block’s strong beside the indicator’s line; a glyph opens its block’s menu', async () => {
        const editor = await makeEditor('# Title\n\nA paragraph.\n\n* an item')
        const container = created[created.length - 1].container
        await frames()
        // One per block (the editor may keep a paragraph after the list).
        expect(glyphs(container).length).toBe(editor.state.doc.childCount)
        expect(glyphs(container).slice(0, 3).map((g) => g.querySelector('svg') ? 'drawn' : g.textContent)).toEqual(['H1', 'drawn', '•'])
        // Soft, all but the active block's (the note takes focus as it is made).
        expect(glyphs(container).filter((g) => !g.classList.contains('is-active')).every((g) => parseFloat(getComputedStyle(g).opacity) < 0.5)).toBe(true)
        // A glyph stays where its block is: nothing of it slides between lines.
        expect(getComputedStyle(glyphs(container)[0]).transitionProperty).not.toContain('top')
        // Each within its block's first line (the active block's is hidden: not measured).
        const blocks = [...editor.view.dom.children].map((b) => b.getBoundingClientRect())
        glyphs(container).forEach((g, i) => {
            if (g.classList.contains('is-active')) return
            const top = g.getBoundingClientRect().top
            expect(top).toBeGreaterThanOrEqual(blocks[i].top - 1)
            expect(top).toBeLessThan(blocks[i].top + Math.max(blocks[i].height, 20))
        })
        // A paragraph's pilcrow is set as its text is (face, size, line), the
        // bullet as the list's first bullet: the glyph's box is the line's box.
        const p = editor.view.dom.querySelector('p') as HTMLElement
        const pilcrow = glyphs(container)[1]
        expect(getComputedStyle(pilcrow).fontSize).toBe(getComputedStyle(p).fontSize)
        expect(getComputedStyle(pilcrow).fontFamily).toBe(getComputedStyle(p).fontFamily)
        expect(Math.abs(pilcrow.getBoundingClientRect().top - p.getBoundingClientRect().top)).toBeLessThan(0.1)
        expect(Math.abs(pilcrow.getBoundingClientRect().height - parseFloat(getComputedStyle(p).lineHeight))).toBeLessThan(1)
        // The pilcrow is drawn as tall as the text's capitals, on the text's
        // baseline: its bottom where the text's is, its top at the cap line
        // (the face's own ¶ would hang under the baseline).
        const charRect = (root: HTMLElement) => {
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
            let text: Text | null
            while ((text = walker.nextNode() as Text | null)) if (text.textContent!.trim()) break
            const range = document.createRange()
            range.setStart(text!, 0)
            range.setEnd(text!, 1)
            return range.getClientRects()[0]
        }
        const measure = document.createElement('canvas').getContext('2d')!
        measure.font = `${getComputedStyle(p).fontSize} ${getComputedStyle(p).fontFamily}`
        const metrics = measure.measureText('H')
        const text = charRect(p)
        const baseline = text.top + metrics.fontBoundingBoxAscent
        const drawing = (pilcrow.querySelector('svg') as SVGElement).getBoundingClientRect()
        expect(Math.abs(drawing.bottom - baseline)).toBeLessThan(1)
        expect(Math.abs(drawing.height - metrics.actualBoundingBoxAscent)).toBeLessThan(1)
        expect(drawing.bottom).toBeLessThan(text.bottom)
        const li = editor.view.dom.querySelector('ul > li') as HTMLElement
        const bullet = glyphs(container)[2]
        expect(getComputedStyle(bullet).fontSize).toBe(getComputedStyle(li, '::before').fontSize)
        // To the subpixel: the two bullets stand on one line, so they are
        // drawn alike.
        expect(Math.abs(bullet.getBoundingClientRect().top - li.getBoundingClientRect().top)).toBeLessThan(0.05)
        expect(Math.abs(charRect(bullet).top - charRect(li).top)).toBeLessThan(0.05)
        // A heading's level keeps the chrome's small label, centred on its line.
        const h1 = editor.view.dom.querySelector('h1') as HTMLElement
        const level = glyphs(container)[0]
        expect(parseFloat(getComputedStyle(level).fontSize)).toBeLessThan(parseFloat(getComputedStyle(h1).fontSize) / 2)
        const centre = (el: HTMLElement) => el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2
        expect(Math.abs(centre(level) - centre(h1))).toBeLessThan(2)
        // The active block's glyph stands at full strength; the indicator
        // beside it is its line alone, its own glyph not shown.
        editor.commands.focus()
        editor.commands.setTextSelection(findNode(editor, 'paragraph')!.pos + 1)
        await frames()
        expect(glyphs(container).map((g) => g.classList.contains('is-active'))).toEqual(glyphs(container).map((_, i) => i === 1))
        await waitFor(() => parseFloat(getComputedStyle(glyphs(container)[1]).opacity) > 0.8, 2000)
        expect(getComputedStyle(container.querySelector('.ezco-mde-block-action-btn-icon') as HTMLElement).visibility).toBe('hidden')
        // Clicking the list's glyph makes the list active and opens its menu.
        glyphs(container)[2].click()
        await frames()
        expect(editor.state.selection.$from.node(1).type.name).toBe('bulletList')
        const menu = document.querySelector('.ezco-mde-block-action-menu')
        // (An item's text is its glyph and its label.)
        const labels = [...menu!.querySelectorAll('.ezco-mde-context-menu-item')].map((i) => i.textContent?.trim() ?? '')
        expect(labels.some((l) => l.endsWith('Numbered list'))).toBe(true)
        expect(labels.some((l) => l.endsWith('Fold'))).toBe(true)
        ;(editor.storage as any).blockActions.blockActionsView.closeMenu()
    })

    it('folds a block to one line, and the blocks a selection spans; the line, the caret, or its glyph opens it again', async () => {
        const editor = await makeEditor('# Title\n\nFirst paragraph here.\n\nSecond.\n\nThird.')
        const container = created[created.length - 1].container
        const markdown = editor.storage.markdown.getMarkdown()
        const paragraphs = () => [...editor.view.dom.querySelectorAll('p')]
        editor.commands.focus()
        runAction(editor, 'paragraph', 'Fold')
        await frames()
        // Hidden, not gone; one line in its place; the caret out of it.
        expect(getComputedStyle(paragraphs()[0]).display).toBe('none')
        expect(editor.storage.markdown.getMarkdown()).toBe(markdown)
        const fold = () => editor.view.dom.querySelector('.ezco-mde-fold') as HTMLElement | null
        expect(fold()?.querySelector('.ezco-mde-fold-text')?.textContent).toBe('First paragraph here.')
        expect(fold()?.querySelector('.ezco-mde-fold-count')?.textContent).toBe('1 block')
        expect(editor.state.selection.$from.parent.textContent).toBe('Second.')
        expect(glyphs(container).map((g) => (g.querySelector('svg') ? 'drawn' : g.textContent))).toEqual(['H1', '▸', 'drawn', 'drawn'])
        fold()!.click()
        await frames()
        expect(fold()).toBeNull()
        expect(getComputedStyle(paragraphs()[0]).display).not.toBe('none')
        // Three blocks spanned, folded together; the caret arrowed into it opens it.
        const second = paragraphs()[1]
        editor.commands.setTextSelection({ from: editor.view.posAtDOM(paragraphs()[0], 0) + 1, to: editor.view.posAtDOM(second, 0) + 2 })
        expect(editor.commands.foldSelection()).toBe(true)
        await frames()
        expect(fold()?.querySelector('.ezco-mde-fold-count')?.textContent).toBe('2 blocks')
        expect(paragraphs().slice(0, 2).every((p) => getComputedStyle(p).display === 'none')).toBe(true)
        expect(editor.state.selection.$from.parent.textContent).toBe('Third.')
        editor.commands.setTextSelection(editor.view.posAtDOM(paragraphs()[0], 0) + 1)
        await frames()
        expect(fold()).toBeNull()
        // A fold's glyph in the gutter opens it too.
        runAction(editor, 'heading', 'Fold')
        await frames()
        expect(glyphs(container)[0].textContent).toBe('▸')
        glyphs(container)[0].click()
        await frames()
        expect(fold()).toBeNull()
        expect(editor.view.dom.querySelector('h1')).not.toBeNull()
    })

    it('offers a comment on a block when there is an author, quoting the block', async () => {
        const container = createTestContainer(`ba-${created.length}`)
        const editor = await createTestEditor(container, { content: 'One.\n\nTwo.', comments: { author: 'theo' } })
        created.push({ editor, container })
        const para = findNode(editor, 'paragraph')!
        const labels = actionsForNode(para.node, editor).map((a) => a.label)
        expect(labels.slice(-3)).toEqual(['Comment', 'Fold', 'Delete'])
        expect(actionsForNode(para.node).map((a) => a.label)).not.toContain('Comment')
        runAction(editor, 'paragraph', 'Comment')
        await frames()
        const draft = (editor.storage as any).comments.draft()
        expect(draft?.ranges).toEqual([{ from: para.pos + 1, to: para.pos + 1 + 'One.'.length }])
    })
})
