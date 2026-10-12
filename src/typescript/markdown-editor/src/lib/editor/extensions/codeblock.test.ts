import { describe, it, expect, afterEach } from 'vitest'
import { fenceFor } from './codeblock'
import { createEditor, MarkdownEditor } from '../index'
import { cleanupEditor, waitFor } from '../../../test/utils'

/**
 * The fence a code block is written with. A closing fence is backticks and
 * nothing else, so only a bare run inside the code can end the block early:
 * the fence is made longer than any such run. A run with a language or a
 * path after it only opens a fence, and changes nothing.
 */
describe('A code block’s fence', () => {
    it('is three backticks when nothing inside could close it', () => {
        expect(fenceFor('const x = 1\n')).toBe('```')
        expect(fenceFor('')).toBe('```')
        // An opener with a language inside (unclosed) cannot close the block.
        expect(fenceFor('# A\n\n```ts\nconst x = 1\n')).toBe('```')
        // Nor can a tilde fence, or backticks after other text.
        expect(fenceFor('~~~\ncode\n~~~\n')).toBe('```')
        expect(fenceFor('see ```\n')).toBe('```')
    })

    it('is longer than any bare run inside, which is what a closing fence is', () => {
        expect(fenceFor('# A\n\n```ts\nconst x = 1\n```\n\nafter\n')).toBe('````')
        // Up to three spaces before the run still make a closing fence.
        expect(fenceFor('   ```   \n')).toBe('````')
        // One more than the longest, however long.
        expect(fenceFor('````md\n```\n````\n')).toBe('`````')
    })
})

/**
 * A code block in the note, in the browser: typed into, its code as
 * written, kept out of the note's own list spacing.
 */
const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const FENCE = '# Code\n\n```js\nfunction a() {\n  return 1\n}\n```\n\n* one\n* two\n'

function openNote(options: { editable?: boolean } = {}) {
    const container = document.createElement('div')
    container.style.cssText = 'width: 800px; height: 500px; overflow-y: auto;'
    document.body.append(container)
    const editor = createEditor({ element: container, content: FENCE, ...options })
    created.push({ editor, container })
    return { editor, container }
}

/** Where a line's first character that is not a space is drawn. */
const lineLeft = (line: Element) => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
        const at = text.data.search(/\S/)
        if (at < 0) continue
        const range = document.createRange()
        range.setStart(text, at)
        range.setEnd(text, at + 1)
        return range.getBoundingClientRect().left
    }
    return NaN
}

describe('A code block in the note', () => {
    it('can be typed into from the start, given with the note, and shows its indentation', async () => {
        const { container } = openNote()
        await waitFor(() => !!container.querySelector('.ezco-mde-body > .cm-editor .cm-line'), 5000)
        const content = container.querySelector('.ezco-mde-body > .cm-editor .cm-content') as HTMLElement
        expect(content.getAttribute('contenteditable')).toBe('true')
        const lines = [...content.querySelectorAll('.cm-line')]
        expect(lines[1].textContent).toBe('  return 1')
        expect(lineLeft(lines[1])).toBeGreaterThan(lineLeft(lines[0]) + 10)
    })

    it('keeps its indentation when it is only shown', async () => {
        const { container } = openNote({ editable: false })
        await waitFor(() => !!container.querySelector('.ezco-mde-body > .cm-editor .cm-line'), 5000)
        const content = container.querySelector('.ezco-mde-body > .cm-editor .cm-content') as HTMLElement
        expect(content.getAttribute('contenteditable')).toBe('false')
        expect(['pre', 'break-spaces', 'pre-wrap']).toContain(getComputedStyle(content).whiteSpace)
        const lines = [...content.querySelectorAll('.cm-line')]
        expect(lineLeft(lines[1])).toBeGreaterThan(lineLeft(lines[0]) + 10)
    })

    it('keeps the note’s list spacing out of its own lists (a toolbar’s search results)', async () => {
        const { container } = openNote()
        await waitFor(() => !!container.querySelector('.ezco-mde-body > .cm-editor .cm-line'), 5000)
        const cm = container.querySelector('.ezco-mde-body > .cm-editor') as HTMLElement
        const results = document.createElement('ul')
        results.className = 'cm-search-results'
        for (const label of ['a.ts', 'b.ts']) {
            const li = document.createElement('li')
            li.className = 'cm-search-result'
            const icon = document.createElement('div')
            icon.className = 'cm-search-result-icon-container'
            const text = document.createElement('div')
            text.className = 'cm-search-result-label'
            text.textContent = label
            li.append(icon, text)
            results.append(li)
        }
        cm.append(results)
        const [, second] = [...results.children] as HTMLElement[]
        expect(getComputedStyle(second).marginTop).toBe('0px')
        expect(getComputedStyle(second.lastElementChild as HTMLElement).marginTop).toBe('0px')
        // The note's own items keep their room.
        const items = [...container.querySelectorAll('.ezco-mde-body > ul > li')] as HTMLElement[]
        expect(parseFloat(getComputedStyle(items[1]).marginTop)).toBeGreaterThan(0)
    })
})
