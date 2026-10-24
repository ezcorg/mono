import { describe, it, expect, vi } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import type { JSONContent } from '@tiptap/core'
import { actionsForNode } from './block-actions'
import { MarkdownEditor } from '../index'
import { createTestContainer, createTestEditor, findNode, frames, getMarkdownContent, menuItem, menuLabels, trackEditors, waitFor } from '../../../test/utils'

/**
 * Exercises every block-action a node type offers (run via `actionsForNode`),
 * asserting each produces the expected transformation, plus the multi-block
 * "spanning" selection behaviour; then the menu as a person reaches it: a
 * glyph pressed in the gutter, an item pressed or chosen with the keys.
 */
describe('Block actions', () => {
    const { created } = trackEditors()

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
    it('code block: copy contents writes the source to the clipboard and keeps the block; delete removes it', async () => {
        let editor = await makeEditor('```js\nconst a = 1;\nconst b = 2;\n```')
        const markdown = getMarkdownContent(editor)
        // The browser's clipboard is not readable here: the write is caught
        // on its way, and restored after.
        const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
        try {
            runAction(editor, 'ezcodeBlock', 'Copy contents')
            expect(writeText).toHaveBeenCalledTimes(1)
            expect(writeText).toHaveBeenCalledWith('const a = 1;\nconst b = 2;')
            expect(findNode(editor, 'ezcodeBlock')).not.toBeNull()
            expect(getMarkdownContent(editor)).toBe(markdown)
            // A rejected write (no permission) is swallowed, the block untouched.
            writeText.mockRejectedValueOnce(new DOMException('Write permission denied.', 'NotAllowedError'))
            runAction(editor, 'ezcodeBlock', 'Copy contents')
            await new Promise((r) => setTimeout(r, 0))
            expect(writeText).toHaveBeenCalledTimes(2)
            expect(getMarkdownContent(editor)).toBe(markdown)
        } finally {
            writeText.mockRestore()
        }

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
    it('table: each action leaves the cells it should, run from the first header cell', async () => {
        const md = '| A | B |\n| --- | --- |\n| 1 | 2 |'
        /** The table's cells, row by row, as text. */
        const cells = (e: MarkdownEditor): string[][] | null => {
            const table = findNode(e, 'table')
            if (!table) return null
            const rows: string[][] = []
            table.node.forEach((row) => {
                const texts: string[] = []
                row.forEach((cell) => texts.push(cell.textContent))
                rows.push(texts)
            })
            return rows
        }
        /** Whether the first row is all header cells. */
        const headed = (e: MarkdownEditor): boolean => {
            const first = findNode(e, 'table')!.node.firstChild!
            let all = true
            first.forEach((cell) => { if (cell.type.name !== 'tableHeader') all = false })
            return all
        }
        // (The cursor goes into the first paragraph, which is the A header cell's.)
        const cases: Array<[string, string[][] | null, boolean | null]> = [
            ['Add row above', [['', ''], ['A', 'B'], ['1', '2']], false],
            ['Add row below', [['A', 'B'], ['', ''], ['1', '2']], true],
            ['Add column before', [['', 'A', 'B'], ['', '1', '2']], true],
            ['Add column after', [['A', '', 'B'], ['1', '', '2']], true],
            ['Delete row', [['1', '2']], false],
            ['Delete column', [['B'], ['2']], true],
            ['Toggle header row', [['A', 'B'], ['1', '2']], false],
            ['Delete table', null, null],
        ]
        for (const [label, expected, header] of cases) {
            const editor = await makeEditor(md)
            expect(cells(editor)).toEqual([['A', 'B'], ['1', '2']])
            expect(headed(editor)).toBe(true)
            runAction(editor, 'table', label, 'paragraph')
            expect(cells(editor), label).toEqual(expected)
            if (header !== null) expect(headed(editor), label).toBe(header)
            // The note is still a note (and the caret in it, the action's chain focusing).
            expect(() => editor.state.doc.check()).not.toThrow()
            expect(editor.isFocused).toBe(true)
        }
        // Toggled twice, the header row is back; a row added above it then
        // serializes as the table's first row, the header after.
        const editor = await makeEditor(md)
        runAction(editor, 'table', 'Toggle header row', 'paragraph')
        runAction(editor, 'table', 'Toggle header row', 'paragraph')
        expect(headed(editor)).toBe(true)
        expect(getMarkdownContent(editor).trimEnd()).toBe(md)
        runAction(editor, 'table', 'Add row below', 'paragraph')
        expect(getMarkdownContent(editor).trimEnd()).toBe('| A | B |\n| --- | --- |\n|  |  |\n| 1 | 2 |')
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
        const indicator = container.querySelector('.ezco-mde-block-action-btn') as HTMLElement
        expect(getComputedStyle(indicator.querySelector('.ezco-mde-block-action-btn-icon') as HTMLElement).visibility).toBe('hidden')
        // The indicator's line stands between the glyph and the text, as far
        // from the glyph's edge as from the text (within a pixel or two, a
        // glyph being as wide as its drawing), and the glyphs are centred on
        // the indicator's own centre (where its star stands for a span).
        await waitFor(() => indicator.style.opacity === '1', 2000)
        const line = indicator.getBoundingClientRect().right - parseFloat(getComputedStyle(indicator).borderRightWidth)
        const drawn = (pilcrow.querySelector('svg') as SVGElement).getBoundingClientRect()
        const toLine = line - drawn.right
        const toText = text.left - indicator.getBoundingClientRect().right
        expect(toText).toBeGreaterThan(4)
        expect(Math.abs(toLine - toText)).toBeLessThan(2.5)
        const mid = (r: DOMRect) => r.left + r.width / 2
        const content = indicator.getBoundingClientRect()
        const inner = { left: content.left + parseFloat(getComputedStyle(indicator).paddingLeft), right: line - parseFloat(getComputedStyle(indicator).paddingRight) }
        expect(Math.abs(mid(pilcrow.getBoundingClientRect()) - (inner.left + inner.right) / 2)).toBeLessThan(1)
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

    // ── The menu, as a person reaches it ─────────────────────────
    const menu = () => document.querySelector<HTMLElement>('.ezco-mde-block-action-menu')
    /** The label of the item holding the focus, if one does. */
    const focused = () => (document.activeElement as HTMLElement | null)?.closest('.ezco-mde-context-menu-item')?.querySelector('.ezco-mde-context-menu-item-label')?.textContent ?? null
    /** The glyph of block `index` (not the active one, whose glyph stands
     *  under the indicator) pressed: its menu open, the first item focused. */
    const openGlyph = async (container: HTMLElement, index: number): Promise<HTMLElement> => {
        await frames()
        await userEvent.click(glyphs(container)[index])
        await waitFor(() => !!menu(), 2000)
        await waitFor(() => focused() !== null, 2000)
        return menu()!
    }
    /** The indicator (the active block's own handle) pressed: its menu open. */
    const openIndicator = async (container: HTMLElement): Promise<HTMLElement> => {
        const indicator = container.querySelector('.ezco-mde-block-action-btn') as HTMLElement
        await waitFor(() => indicator.style.opacity === '1', 2000)
        await userEvent.click(indicator)
        await waitFor(() => !!menu(), 2000)
        await waitFor(() => focused() !== null, 2000)
        return menu()!
    }

    it('a glyph pressed opens its block’s menu; an item pressed converts the block and the note keeps the focus', async () => {
        const editor = await makeEditor('# Title\n\n* one\n* two')
        const container = created[created.length - 1].container
        const open = await openGlyph(container, 1)
        expect(menuLabels(open)).toEqual(['Dashed list', 'Numbered list', 'Lettered list', 'Task list', 'Lift to paragraphs', 'Fold', 'Delete'])
        expect(focused()).toBe('Dashed list')
        // Under the glyph, in its column.
        const glyph = glyphs(container)[1].getBoundingClientRect()
        expect(open.getBoundingClientRect().top).toBeGreaterThanOrEqual(glyph.bottom - 1)
        await userEvent.click(menuItem('Numbered list', open)!)
        await waitFor(() => !menu(), 2000)
        expect(editor.getJSON().content?.[1]?.type).toBe('orderedList')
        expect(getMarkdownContent(editor)).toBe('# Title\n\n1. one\n2. two')
        expect(editor.isFocused).toBe(true)
        // The list's glyph says so now. Back in the list (see the case below
        // for where the caret went), the list is the active block and its
        // handle is the indicator: pressed, it opens the way back.
        await frames()
        expect(glyphs(container)[1].textContent).toBe('1.')
        editor.commands.setTextSelection(findNode(editor, 'orderedList')!.pos + 3)
        const again = await openIndicator(container)
        expect(menuLabels(again)).toEqual(['Lettered list', 'Bullet list', 'Dashed list', 'Task list', 'Lift to paragraphs', 'Fold', 'Delete'])
        await userEvent.click(menuItem('Task list', again)!)
        await waitFor(() => !menu(), 2000)
        // (A task list writes itself loose, `* [ ]`: lists.test.ts.)
        const tasks: JSONContent = editor.getJSON().content![1]
        expect(tasks.type).toBe('taskList')
        expect(tasks.content!.map((i) => [i.type, i.attrs?.checked, i.content?.[0]?.content?.[0]?.text])).toEqual([['taskItem', false, 'one'], ['taskItem', false, 'two']])
    })

    // Bug: `convertList` replaces the list with `replaceRangeWith` and never
    // maps the caret into the new list, so it lands in the block after it.
    it('a list converted from its menu keeps the caret in the list', async () => {
        const editor = await makeEditor('# Title\n\n* one\n* two')
        const container = created[created.length - 1].container
        const open = await openGlyph(container, 1)
        expect(editor.state.selection.$from.parent.textContent).toBe('one')
        await userEvent.click(menuItem('Numbered list', open)!)
        await waitFor(() => !menu(), 2000)
        expect(getMarkdownContent(editor)).toBe('# Title\n\n1. one\n2. two')
        expect(editor.state.selection.$from.node(1).type.name).toBe('orderedList')
        expect(editor.state.selection.$from.parent.textContent).toBe('one')
    })

    it('the arrows move the focused item (Home and End to the ends), Enter runs it', async () => {
        const editor = await makeEditor('# Title\n\nA paragraph.')
        const container = created[created.length - 1].container
        await openGlyph(container, 1)
        expect(focused()).toBe('Heading 1')
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Heading 2')
        await userEvent.keyboard('{ArrowDown}{ArrowDown}')
        expect(focused()).toBe('Bullet list')
        await userEvent.keyboard('{ArrowUp}')
        expect(focused()).toBe('Heading 3')
        await userEvent.keyboard('{End}')
        expect(focused()).toBe('Delete')
        await userEvent.keyboard('{ArrowDown}')
        expect(focused()).toBe('Heading 1')
        await userEvent.keyboard('{Home}{ArrowUp}')
        expect(focused()).toBe('Delete')
        // The keys went to the menu, not the note.
        expect(editor.state.doc.textContent).toBe('TitleA paragraph.')
        await userEvent.keyboard('{Home}{ArrowDown}{ArrowDown}{Enter}')
        await waitFor(() => !menu(), 2000)
        expect(getMarkdownContent(editor)).toBe('# Title\n\n### A paragraph.')
        expect(editor.isFocused).toBe(true)
        expect(editor.state.selection.$from.parent.type.name).toBe('heading')
    })

    it('Escape closes the menu and puts the caret back where it was, the note focused and unchanged', async () => {
        const editor = await makeEditor('# Title\n\nA paragraph.')
        const container = created[created.length - 1].container
        const markdown = getMarkdownContent(editor)
        await openGlyph(container, 1)
        // The glyph put the caret into its block before opening.
        const at = editor.state.selection.from
        expect(editor.state.selection.$from.parent.textContent).toBe('A paragraph.')
        expect(editor.isFocused).toBe(false)
        await userEvent.keyboard('{Escape}')
        await waitFor(() => !menu(), 2000)
        expect(editor.isFocused).toBe(true)
        expect(editor.state.selection.from).toBe(at)
        expect(editor.state.selection.empty).toBe(true)
        expect(getMarkdownContent(editor)).toBe(markdown)
        // Typing goes on in the note, at the caret.
        await userEvent.keyboard('X')
        expect(editor.state.selection.$from.parent.textContent).toBe('XA paragraph.')
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
