import { describe, it, expect, afterEach } from 'vitest'
import { memoryVfs } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
import { createEditor, MarkdownEditor } from '../index'
import { cleanupEditor, waitFor } from '../../../test/utils'

/** The rail beside the note folds away and comes back. */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement; vault: Vault }> = []
afterEach(() => {
    created.forEach(({ editor, container, vault }) => {
        cleanupEditor(editor, container)
        vault.close()
    })
    created.length = 0
})

const frames = async (n = 3) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r))
}

describe('The rail', () => {
    it('folds away on its chevron, comes back on it, and for a panel asked for while folded', async () => {
        const vault = await Vault.open(memoryVfs({ 'Review.md': '# Review\n\n## One\n\ntext\n\n## Two\n\nmore\n' }), { watch: false })
        const container = document.createElement('div')
        container.style.cssText = 'width: 900px; height: 600px; overflow-y: auto;'
        document.body.append(container)
        const editor = createEditor({
            element: container,
            fs: { fs: vault.fs, filepath: 'Review.md', autoSave: false },
            links: { resolver: vault.links, index: vault.links },
            search: vault.search,
            files: vault.files,
            sidebar: {},
            fileTree: {},
        })
        created.push({ editor, container, vault })
        await waitFor(() => !!container.querySelector('.ezco-mde-rail .ezco-mde-sidebar li, .ezco-mde-rail .ezco-mde-sidebar a'), 5000)
        const rail = container.querySelector('.ezco-mde-rail') as HTMLElement
        const toggle = rail.querySelector(':scope > .ezco-mde-rail-toggle') as HTMLButtonElement
        expect(toggle).not.toBeNull()
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
        const open = rail.getBoundingClientRect().width
        expect(open).toBeGreaterThan(60)
        // Folded: nothing of the rail but the chevron, turned the other way.
        toggle.click()
        await waitFor(() => rail.classList.contains('is-collapsed'), 2000)
        await frames()
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        expect(rail.getBoundingClientRect().width).toBeLessThan(30)
        expect(getComputedStyle(rail.querySelector('.ezco-mde-sidebar') as HTMLElement).display).toBe('none')
        // The chevron is reachable: nothing beside the rail (the gutter) covers it.
        const r = toggle.getBoundingClientRect()
        expect(toggle.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))).toBe(true)
        // Back, from the keyboard's command.
        expect(editor.commands.toggleRail()).toBe(true)
        await waitFor(() => !rail.classList.contains('is-collapsed'), 2000)
        await frames()
        expect(rail.getBoundingClientRect().width).toBe(open)
        // Folded again, a panel asked for (the file tree) brings it back.
        toggle.click()
        await waitFor(() => rail.classList.contains('is-collapsed'), 2000)
        editor.commands.toggleFileTree()
        await waitFor(() => !rail.classList.contains('is-collapsed'), 2000)
        await waitFor(() => !(container.querySelector('.ezco-mde-files') as HTMLElement).hidden, 2000)
    })
})
