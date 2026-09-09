import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MarkdownEditor } from '../index'
import {
    createTestContainer,
    createTestEditor,
    cleanupEditor,
    waitFor,
} from '../../../test/utils'

/**
 * Pixel-precise list-alignment assertions (Playwright browser provider —
 * happy-dom returns zero rects).
 *
 * The contract, across all four list types (ordered `1.`, bullet `*`, dash
 * `-`, task `- [ ]`), at every nesting level:
 *   1. every decoration (number / bullet / dash / checkbox) shares a start-x
 *   2. every item's text shares a start-x
 *
 * Mirrors the nested example from the spec: each list type with an "Outer"
 * item and a nested "Inner" list of the same type. (The lists are separated by
 * a paragraph so adjacent same-marker lists don't merge during markdown
 * parsing — the alignment property is what's under test, not the parser.)
 */
describe('MarkdownEditor list alignment', () => {
    let container: HTMLElement
    let editor: MarkdownEditor

    const CONTENT = [
        '1. Outer',
        '    1. Inner',
        '',
        'sep',
        '',
        '* Outer',
        '    * Inner',
        '',
        'sep',
        '',
        '- Outer',
        '    - Inner',
        '',
        'sep',
        '',
        '- [ ] Outer',
        '    - [ ] Inner',
    ].join('\n')

    beforeEach(async () => {
        container = createTestContainer()
        editor = await createTestEditor(container, { content: CONTENT })
        await waitFor(() => container.querySelectorAll('.ezco-mde-body >ul, .ezco-mde-body >ol').length >= 4)
        await new Promise((r) => requestAnimationFrame(() => r(null)))
    })

    afterEach(() => {
        cleanupEditor(editor, container)
    })

    type Metrics = { kind: string; decorationX: number; textX: number }

    function kindOf(list: Element): string {
        if (list.getAttribute('data-type') === 'taskList') return 'task'
        if (list.tagName === 'OL') return 'ordered'
        return list.getAttribute('data-marker') === 'dash' ? 'dash' : 'bullet'
    }

    /** Measure a list's first item. Decoration-x is the checkbox for tasks, or
     *  the item's left edge (where the absolutely-positioned `::before` is
     *  pinned) for the others. Text-x is the item's own paragraph. */
    function measureItem(list: Element): Metrics | null {
        const li = list.querySelector(':scope > li')
        if (!li) return null
        const p = li.querySelector(':scope > p') ?? li.querySelector(':scope > div > p')
        if (!p) return null
        const input = li.querySelector(':scope > label > input') as HTMLElement | null
        return {
            kind: kindOf(list),
            decorationX: (input ?? li).getBoundingClientRect().left,
            textX: p.getBoundingClientRect().left,
        }
    }

    function spread(values: number[]): number {
        return Math.max(...values) - Math.min(...values)
    }

    function topLevel(): Metrics[] {
        return Array.from(container.querySelectorAll('.ezco-mde-body >ul, .ezco-mde-body >ol'))
            .map(measureItem)
            .filter((m): m is Metrics => m !== null)
    }

    function nested(): Metrics[] {
        return Array.from(container.querySelectorAll('.ezco-mde-body >ul > li, .ezco-mde-body >ol > li'))
            .map((li) => li.querySelector(':scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol'))
            .filter((l): l is Element => l !== null)
            .map(measureItem)
            .filter((m): m is Metrics => m !== null)
    }

    it('renders all four list types, nested, at both levels', () => {
        expect(new Set(topLevel().map((m) => m.kind))).toEqual(new Set(['ordered', 'bullet', 'dash', 'task']))
        expect(new Set(nested().map((m) => m.kind))).toEqual(new Set(['ordered', 'bullet', 'dash', 'task']))
    })

    it('aligns every decoration and every text start-x at the top level', () => {
        const m = topLevel()
        expect(m).toHaveLength(4)
        expect(spread(m.map((x) => x.decorationX))).toBeLessThanOrEqual(1)
        expect(spread(m.map((x) => x.textX))).toBeLessThanOrEqual(1)
        // Text hangs to the right of the decoration.
        for (const x of m) expect(x.textX).toBeGreaterThan(x.decorationX)
    })

    it('aligns every decoration and every text start-x at the nested level', () => {
        const m = nested()
        expect(m).toHaveLength(4)
        expect(spread(m.map((x) => x.decorationX))).toBeLessThanOrEqual(1)
        expect(spread(m.map((x) => x.textX))).toBeLessThanOrEqual(1)
    })

    it('indents the nested level one gutter past its parent', () => {
        const parent = topLevel()
        const child = nested()
        // Nested decoration column == parent text column (a hanging-indent list).
        expect(Math.abs(child[0].decorationX - parent[0].textX)).toBeLessThanOrEqual(1)
    })
})
