import { describe, it, expect, afterEach } from 'vitest'
import { createEditor, MarkdownEditor } from '../index'
import { cleanupEditor, waitFor } from '../../../test/utils'

/** The outline follows the reader, and a click on it is believed. */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const NOTE = ['# Start', ...Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1} of the first part.`), '## Middle', 'A line.', '## End', 'The last line.'].join('\n\n')

describe('The outline', () => {
    it('lights the entry clicked, though its heading cannot reach the top, and the last one at the end', async () => {
        const container = document.createElement('div')
        container.style.cssText = 'width: 900px; height: 420px; overflow-y: auto;'
        document.body.append(container)
        const editor = createEditor({ element: container, content: NOTE, sidebar: {} })
        created.push({ editor, container })
        await waitFor(() => container.querySelectorAll('.ezco-mde-sidebar-link').length === 3, 5000)
        const links = [...container.querySelectorAll<HTMLElement>('.ezco-mde-sidebar-link')]
        expect(links[0].classList.contains('is-active')).toBe(true)
        // "End" cannot reach the top of so short a document; clicked, it is lit all the same.
        links[2].click()
        await waitFor(() => container.scrollTop + container.clientHeight >= container.scrollHeight - 2, 3000)
        await new Promise((r) => setTimeout(r, 1400))
        expect(links[2].classList.contains('is-active')).toBe(true)
        // Scrolled back up by hand, the entry for the top lights again.
        container.scrollTop = 0
        container.dispatchEvent(new Event('scroll'))
        await waitFor(() => links[0].classList.contains('is-active'), 2000)
        // Scrolled to the end by hand, the last heading in view is lit.
        container.scrollTop = container.scrollHeight
        container.dispatchEvent(new Event('scroll'))
        await waitFor(() => links[2].classList.contains('is-active'), 2000)
    })

    it('scrolls itself to keep the lit entry in view, never the note', async () => {
        const container = document.createElement('div')
        container.style.cssText = 'width: 900px; height: 300px; overflow-y: auto;'
        document.body.append(container)
        const many = Array.from({ length: 40 }, (_, i) => `## Section ${i + 1}\n\nA line or two under it.`).join('\n\n')
        const editor = createEditor({ element: container, content: `# Start\n\n${many}`, sidebar: {} })
        created.push({ editor, container })
        await waitFor(() => container.querySelectorAll('.ezco-mde-sidebar-link').length === 41, 5000)
        const rail = container.querySelector('.ezco-mde-rail') as HTMLElement
        await waitFor(() => rail.scrollHeight > rail.clientHeight, 3000)
        // The note takes focus a moment after it is made, and brings its
        // caret into view: scroll after that, not before.
        await waitFor(() => editor.isFocused, 3000)
        expect(rail.scrollTop).toBe(0)
        container.scrollTop = container.scrollHeight
        container.dispatchEvent(new Event('scroll'))
        const links = [...container.querySelectorAll<HTMLElement>('.ezco-mde-sidebar-link')]
        await waitFor(() => links[40].classList.contains('is-active'), 2000)
        const inView = () => {
            const lit = links[40].getBoundingClientRect()
            const frame = rail.getBoundingClientRect()
            return lit.bottom <= frame.bottom + 1 && lit.top >= frame.top - 1
        }
        await waitFor(inView, 3000)
        expect(rail.scrollTop).toBeGreaterThan(0)
        // The note stayed where the reader put it.
        expect(container.scrollTop + container.clientHeight).toBeGreaterThanOrEqual(container.scrollHeight - 2)
    })
})
