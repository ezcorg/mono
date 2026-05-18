import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MarkdownEditor } from '../lib/editor'
import {
    createTestContainer,
    createTestEditor,
    cleanupEditor,
    waitFor,
} from './utils'

/**
 * Pixel-precise layout assertions for markdown-editor elements rendered
 * onto real DOM. These tests rely on the playwright browser provider
 * (configured via `browser.enabled: true` in vitest.config.ts) for
 * actual computed styles and bounding rects — happy-dom returns zero
 * rects, so the assertions only make sense in a real browser.
 *
 * The relationships under test are *relative* — e.g. "the right edge
 * of element A must align with the right edge of element B" — rather
 * than absolute pixel positions, so they remain stable across font
 * stacks, scrollbars, and zoom changes.
 */
describe('MarkdownEditor layout alignment', () => {
    let container: HTMLElement
    let editor: MarkdownEditor

    beforeEach(async () => {
        container = createTestContainer()
        // Use a codeblock-heavy document so the toolbar + line-number
        // gutter both render and can be measured against each other.
        editor = await createTestEditor(container, {
            content:
                '# Layout test\n\n```js\nconst hello = "world";\nconsole.log(hello);\n```\n',
        })
    })

    afterEach(() => {
        cleanupEditor(editor, container)
    })

    /**
     * Get a single element inside the editor, or `null` if absent.
     * Defaults to searching anywhere in the test container; pass `root`
     * to scope to a specific subtree (essential when the document-level
     * markdown-editor toolbar and the per-codeblock toolbar both render
     * `.cm-toolbar-state-icon-container` and we need the codeblock one).
     */
    function find<T extends Element = Element>(
        selector: string,
        root: Element = container,
    ): T | null {
        return root.querySelector<T>(selector)
    }

    /** Wait until the first matching element (scoped to `root`) has a non-zero rect. */
    async function waitForRect(selector: string, root: Element = container): Promise<void> {
        await waitFor(() => {
            const el = find(selector, root)
            if (!el) return false
            const r = el.getBoundingClientRect()
            return r.width > 0 && r.height > 0
        })
    }

    /** Wait for the embedded codeblock's `.cm-editor` to mount and have a non-zero rect. */
    async function getCodeblockEditor(): Promise<HTMLElement> {
        await waitForRect('.cm-editor')
        return container.querySelector<HTMLElement>('.cm-editor')!
    }

    describe('Codeblock toolbar gutter alignment', () => {
        it('aligns the right edge of .cm-toolbar-state-icon-container with the right edge of .cm-lineNumbers', async () => {
            const cmEditor = await getCodeblockEditor()
            await waitForRect('.cm-toolbar-state-icon-container', cmEditor)
            await waitForRect('.cm-lineNumbers', cmEditor)
            // Give the gutter-width ResizeObserver a frame to settle —
            // `--cm-gutter-width` is computed off `.cm-gutters` rect width,
            // and the toolbar layout depends on the resulting var.
            await new Promise(r => requestAnimationFrame(() => r(null)))

            const stateIconContainer = find('.cm-toolbar-state-icon-container', cmEditor)!
            const lineNumbers = find('.cm-lineNumbers', cmEditor)!

            const stateRight = stateIconContainer.getBoundingClientRect().right
            const lineNumbersRight = lineNumbers.getBoundingClientRect().right

            // Sub-pixel rounding can leave a hair of difference between
            // a flex-sized box and a CM-internal gutter — anything within
            // a single CSS pixel reads as aligned to the eye.
            expect(Math.abs(stateRight - lineNumbersRight)).toBeLessThanOrEqual(1)
        })

        it('right-aligns the state icon glyph with the first line-number gutter cell', async () => {
            const cmEditor = await getCodeblockEditor()
            await waitForRect('.cm-toolbar-state-icon-container', cmEditor)
            await waitForRect('.cm-lineNumbers', cmEditor)
            // Wait for at least one visible line-number cell. CM may
            // render an invisible "spacer" cell before real lines; pick
            // the first cell with text content.
            await waitFor(() => {
                const cells = cmEditor.querySelectorAll('.cm-lineNumbers .cm-gutterElement')
                return Array.from(cells).some(c => c.textContent?.trim().length! > 0)
            })
            await new Promise(r => requestAnimationFrame(() => r(null)))

            const stateIcon = find('.cm-toolbar-state-icon', cmEditor)!
            const firstNumberedCell = Array.from(
                cmEditor.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'),
            ).find(c => c.textContent?.trim().length! > 0)!

            // Both elements use the same `padding-right` (1ch + 3px)
            // and are right-aligned within their container, so their
            // right edges should match column-for-column.
            const stateRight = stateIcon.getBoundingClientRect().right
            const lineRight = firstNumberedCell.getBoundingClientRect().right

            expect(Math.abs(stateRight - lineRight)).toBeLessThanOrEqual(1)
        })

        it('aligns the spinner right edge with the line-number column right edge', async () => {
            const cmEditor = await getCodeblockEditor()
            await waitForRect('.cm-toolbar-state-icon-container', cmEditor)
            const stateIconContainer = find('.cm-toolbar-state-icon-container', cmEditor)!

            // Replace the glyph with a spinner element to measure its
            // resting position — we don't depend on file-load timing.
            const existing = stateIconContainer.querySelector('.cm-toolbar-state-icon')
            if (existing) existing.remove()
            const spinner = document.createElement('div')
            spinner.className = 'cm-loading'
            stateIconContainer.appendChild(spinner)
            await new Promise(r => requestAnimationFrame(() => r(null)))

            await waitForRect('.cm-loading', cmEditor)
            await waitForRect('.cm-lineNumbers', cmEditor)

            const spinnerRect = spinner.getBoundingClientRect()
            const lineNumbers = find('.cm-lineNumbers', cmEditor)!.getBoundingClientRect()

            // The spinner sits inside a flex container sized to
            // lineno-width; `margin-left: auto` pushes its right edge
            // to the container's right edge, which by our state-icon
            // container width rule matches `.cm-lineNumbers`' right edge.
            expect(Math.abs(spinnerRect.right - lineNumbers.right)).toBeLessThanOrEqual(1)
        })
    })
})
