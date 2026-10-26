import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { memoryVfs, type VfsInterface } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import {
    createTestContainer,
    createTestEditor,
    cleanupEditor,
    waitFor,
} from '../../../test/utils'

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
            // Let the gutter-width ResizeObserver publish its vars and the
            // layout settle for a frame before comparing edges.
            await new Promise(r => requestAnimationFrame(() => r(null)))

            const stateIcon = find('.cm-toolbar-state-icon', cmEditor)!
            const firstNumberedCell = Array.from(
                cmEditor.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'),
            ).find(c => c.textContent?.trim().length! > 0)!

            // Both elements use the same `padding-right` (3px) and are
            // right-aligned within their container, so their right edges
            // should match column-for-column.
            const stateRight = stateIcon.getBoundingClientRect().right
            const lineRight = firstNumberedCell.getBoundingClientRect().right

            expect(Math.abs(stateRight - lineRight)).toBeLessThanOrEqual(1)
        })

        it('aligns the spinner right edge with the line-number column right edge', async () => {
            // The spinner is the one the block's toolbar shows while a file it
            // opens is read: an editor of its own over a vault whose read of
            // that file is held until the spinner has been measured.
            const store = memoryVfs({ 'note.md': '# Layout\n\n```js\nconst a = 1\n```\n', 'src/lib.ts': 'export const x = 1\n' })
            let release = () => {}
            const fs: VfsInterface = {
                ...store,
                readBytes: (path) =>
                    path === 'src/lib.ts'
                        ? new Promise((resolve) => {
                              release = () => resolve(store.readBytes(path))
                          })
                        : store.readBytes(path),
            }
            const host = createTestContainer('layout-spinner')
            const slow = createEditor({ element: host, fs: { fs, filepath: 'note.md' } })
            try {
                await waitFor(() => !!host.querySelector('.ezco-mde-body > .cm-editor .cm-toolbar-input'))
                const cmEditor = host.querySelector('.ezco-mde-body > .cm-editor') as HTMLElement
                const input = cmEditor.querySelector('.cm-toolbar-input') as HTMLInputElement
                // The file, picked from the block's toolbar (asked again until
                // the editor's vault has indexed it).
                const hit = () => cmEditor.querySelector('.cm-search-result.cm-file-result') as HTMLElement | null
                for (let i = 0; i < 30 && !hit(); i++) {
                    input.focus()
                    input.value = 'src/lib.ts'
                    input.dispatchEvent(new Event('input', { bubbles: true }))
                    await new Promise((r) => setTimeout(r, 100))
                }
                expect(hit()?.textContent).toContain('src/lib.ts')
                hit()!.click()
                await waitForRect('.cm-toolbar-state-icon-container .cm-loading', cmEditor)
                await waitForRect('.cm-lineNumbers', cmEditor)
                await new Promise(r => requestAnimationFrame(() => r(null)))

                // The spinner spins: its box as drawn turns with it, up to
                // 4px wider at the diagonal. Its resting box is what lines up.
                const spinner = find<HTMLElement>('.cm-loading', cmEditor)!
                spinner.getAnimations().forEach((a) => a.cancel())
                const spinnerRect = spinner.getBoundingClientRect()
                const lineNumbers = find('.cm-lineNumbers', cmEditor)!.getBoundingClientRect()

                // The spinner sits inside a flex container sized to the FULL
                // gutter width. `margin-left: auto` pushes it right, and
                // `margin-right: calc(--cm-gutter-width - --cm-gutter-lineno-width)`
                // pulls its right edge back off the far gutter edge onto the
                // line-number column's right edge — so the loading indicator
                // stays in the same column as the file-type glyph it replaces.
                // 2px tolerance: `--cm-gutter-lineno-width` is republished from a
                // ResizeObserver and lags the gutter's min-width widening by a hair
                // in the headless provider (it lines up exactly once settled).
                expect(Math.abs(spinnerRect.right - lineNumbers.right)).toBeLessThanOrEqual(2)

                // The read done, the spinner goes and the file is in the block.
                release()
                await waitFor(() => !cmEditor.querySelector('.cm-loading'), 3000)
                await waitFor(() => cmEditor.querySelector('.cm-content')?.textContent?.includes('x = 1') ?? false, 3000)
            } finally {
                cleanupEditor(slow, host)
            }
        })
    })
})
