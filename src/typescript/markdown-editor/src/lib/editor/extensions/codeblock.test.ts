import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { EditorView } from '@codemirror/view'
import { memoryVfs, type VfsInterface } from '@joinezco/storage'
import { fenceFor } from './codeblock'
import { clip, getMarkdownContent, mod, trackEditors, waitFor } from '../../../test/utils'

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
 * written, kept out of the note's own list spacing; and used as a person
 * uses one (real keys, the clipboard, undo, the theme).
 */
const { make } = trackEditors({ also: () => document.documentElement.removeAttribute('data-theme') })

const FENCE = '# Code\n\n```js\nfunction a() {\n  return 1\n}\n```\n\n* one\n* two\n'
/** A one-line fence with a paragraph after it: what the keys below act on. */
const USED = '# Code\n\n```js\nlet a = 1\n```\n\nAfter the code.\n'

function openNote(options: { editable?: boolean; content?: string; fs?: VfsInterface } = {}) {
    const { editable, content = FENCE, fs } = options
    return make({
        size: { width: 800, height: 500, scroll: true },
        ...(fs ? { fs: { fs, filepath: 'note.md', autoSave: false } } : { content }),
        // Only when given: `editable: undefined` would make every block read-only.
        ...(editable === undefined ? {} : { editable }),
    })
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
/** How wide a line's leading spaces are drawn: its indentation, in whatever
 *  font the browser running this has (the suite's may have no monospace). */
const indentWidth = (line: Element) => {
    const text = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode() as Text | null
    const spaces = text?.data.match(/^ +/)?.[0].length ?? 0
    if (!text || !spaces) return 0
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, spaces)
    return range.getBoundingClientRect().width
}

const cmOf = (c: HTMLElement) => c.querySelector('.ezco-mde-body > .cm-editor') as HTMLElement
const contentOf = (c: HTMLElement) => cmOf(c).querySelector('.cm-content') as HTMLElement
const toolbarOf = (c: HTMLElement) => cmOf(c).querySelector('.cm-toolbar-input') as HTMLInputElement
/** The block set up with its toolbar (its filesystem has arrived), a frame later. */
async function ready(c: HTMLElement) {
    await waitFor(() => !!c.querySelector('.ezco-mde-body > .cm-editor .cm-toolbar-input'), 5000)
    await new Promise((r) => requestAnimationFrame(r))
}
/** Into the code by a real click, CodeMirror focused. */
async function into(c: HTMLElement) {
    await userEvent.click(contentOf(c))
    const view = EditorView.findFromDOM(cmOf(c))!
    await waitFor(() => view.hasFocus, 2000)
    return view
}
/** `color` as the browser computes it (`#1e1e1e` as `rgb(30, 30, 30)`). */
function computed(color: string) {
    const probe = document.createElement('div')
    probe.style.backgroundColor = color
    document.body.append(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
}

describe('A code block in the note', () => {
    it('can be typed into from the start, given with the note, and shows its indentation', async () => {
        const { container } = openNote()
        await waitFor(() => !!container.querySelector('.ezco-mde-body > .cm-editor .cm-line'), 5000)
        const content = container.querySelector('.ezco-mde-body > .cm-editor .cm-content') as HTMLElement
        expect(content.getAttribute('contenteditable')).toBe('true')
        const lines = [...content.querySelectorAll('.cm-line')]
        expect(lines[1].textContent).toBe('  return 1')
        // Its indentation is kept: the second line starts its two spaces in.
        expect(indentWidth(lines[1])).toBeGreaterThan(0)
        expect(lineLeft(lines[1]) - lineLeft(lines[0])).toBeCloseTo(indentWidth(lines[1]), 0)
    })

    it('keeps its indentation when it is only shown', async () => {
        const { container } = openNote({ editable: false })
        await waitFor(() => !!container.querySelector('.ezco-mde-body > .cm-editor .cm-line'), 5000)
        const content = container.querySelector('.ezco-mde-body > .cm-editor .cm-content') as HTMLElement
        expect(content.getAttribute('contenteditable')).toBe('false')
        expect(['pre', 'break-spaces', 'pre-wrap']).toContain(getComputedStyle(content).whiteSpace)
        const lines = [...content.querySelectorAll('.cm-line')]
        expect(indentWidth(lines[1])).toBeGreaterThan(0)
        expect(lineLeft(lines[1]) - lineLeft(lines[0])).toBeCloseTo(indentWidth(lines[1]), 0)
    })

    it('keeps the note’s list spacing out of its own lists (its toolbar’s results)', async () => {
        const { container } = openNote({ fs: memoryVfs({ 'note.md': FENCE }) })
        await ready(container)
        // The block's own toolbar, opened: its results are a list in the note's body.
        await userEvent.click(toolbarOf(container))
        const rows = () => [...cmOf(container).querySelectorAll('.cm-search-results > .cm-search-result')] as HTMLElement[]
        await waitFor(() => rows().length >= 2, 3000)
        const second = rows()[1]
        expect(getComputedStyle(second).marginTop).toBe('0px')
        expect(getComputedStyle(second.lastElementChild as HTMLElement).marginTop).toBe('0px')
        // The note's own items keep their room.
        const items = [...container.querySelectorAll('.ezco-mde-body > ul > li')] as HTMLElement[]
        expect(parseFloat(getComputedStyle(items[1]).marginTop)).toBeGreaterThan(0)
    })
})

describe('A code block, used', () => {
    it('takes what is typed; ArrowDown on its last line goes to the paragraph after, ArrowUp from there comes back', async () => {
        const { editor, container } = openNote({ content: USED })
        await ready(container)
        await into(container)
        await userEvent.keyboard('{End} + 1')
        await waitFor(() => getMarkdownContent(editor).includes('```js\nlet a = 1 + 1\n```'), 2000)
        await userEvent.keyboard('{ArrowDown}')
        await waitFor(() => editor.state.selection.$from.parent.textContent === 'After the code.', 2000)
        expect(document.activeElement).toBe(editor.view.dom)
        await userEvent.keyboard('{ArrowUp}')
        // Back in the code, on its last line.
        await waitFor(() => document.activeElement === contentOf(container), 2000)
        const view = EditorView.findFromDOM(cmOf(container))!
        expect(view.hasFocus).toBe(true)
        expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(view.state.doc.lines)
    })

    it('goes away on Backspace once it is empty, the caret landing before it', async () => {
        const { editor, container } = openNote({ content: USED })
        await ready(container)
        await into(container)
        await userEvent.keyboard(mod('a') + '{Backspace}')
        await waitFor(() => getMarkdownContent(editor).includes('```js\n```'), 2000)
        expect(cmOf(container)).not.toBeNull()
        await userEvent.keyboard('{Backspace}')
        await waitFor(() => !container.querySelector('.ezco-mde-body > .cm-editor'), 2000)
        expect(getMarkdownContent(editor)).toBe('# Code\n\nAfter the code.')
        expect(editor.state.selection.$from.parent.type.name).toBe('heading')
        expect(document.activeElement).toBe(editor.view.dom)
    })

    it('is saved as a file of another language from its toolbar, which the fence then names', async () => {
        // The toolbar sets no language by itself: a language typed there
        // offers to save the block as a file of it, and the fence follows the file.
        const fs = memoryVfs({ 'note.md': USED })
        const { editor, container } = openNote({ fs })
        await ready(container)
        const input = toolbarOf(container)
        expect(input.value).toBe('js')
        await userEvent.click(input)
        await userEvent.clear(input)
        await userEvent.type(input, 'python')
        const result = (label: string) =>
            [...cmOf(container).querySelectorAll('.cm-search-result')].find((r) => r.querySelector('.cm-search-result-label')?.textContent === label) as HTMLElement | undefined
        await waitFor(() => !!result('Save as'), 3000)
        result('Save as')!.click()
        await waitFor(() => input.placeholder === 'filename.py', 2000)
        await userEvent.keyboard('calc{Enter}')
        await waitFor(() => getMarkdownContent(editor).includes('```calc.py\nlet a = 1\n```'), 5000)
        expect(await fs.readFile('calc.py')).toBe('let a = 1')
        expect(editor.state.doc.child(1).attrs).toMatchObject({ file: 'calc.py', language: 'python' })
    })

    it('copies and cuts from inside CodeMirror, and takes a paste there', async () => {
        const { editor, container } = openNote({ content: USED })
        await ready(container)
        await into(container)
        await userEvent.keyboard(mod('a'))
        const copy = clip(contentOf(container), 'copy')
        expect(copy.handled).toBe(true)
        expect(copy.text).toBe('let a = 1')
        expect(getMarkdownContent(editor)).toContain('```js\nlet a = 1\n```')
        const cut = clip(contentOf(container), 'cut')
        expect(cut.text).toBe('let a = 1')
        await waitFor(() => getMarkdownContent(editor).includes('```js\n```'), 2000)
        const data = new DataTransfer()
        data.setData('text/plain', 'let b = 2')
        contentOf(container).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        await waitFor(() => getMarkdownContent(editor).includes('```js\nlet b = 2\n```'), 2000)
    })

    it('undoes across its boundary in the order typed: the paragraph’s text first, then its own', async () => {
        const { editor, container } = openNote({ content: USED })
        await ready(container)
        await into(container)
        await userEvent.keyboard('{End} + 1')
        await waitFor(() => getMarkdownContent(editor).includes('let a = 1 + 1'), 2000)
        await userEvent.keyboard('{ArrowDown}')
        await waitFor(() => editor.state.selection.$from.parent.textContent === 'After the code.', 2000)
        await userEvent.keyboard('{End} Then.')
        await waitFor(() => getMarkdownContent(editor).includes('After the code. Then.'), 2000)
        const undo = async (until: () => boolean) => {
            for (let i = 0; i < 8 && !until(); i++) {
                await userEvent.keyboard(mod('z'))
                await new Promise((r) => setTimeout(r, 50))
            }
            expect(until()).toBe(true)
        }
        await undo(() => !getMarkdownContent(editor).includes('Then.'))
        expect(getMarkdownContent(editor)).toContain('let a = 1 + 1')
        await undo(() => getMarkdownContent(editor).includes('```js\nlet a = 1\n```'))
        expect(getMarkdownContent(editor)).toBe('# Code\n\n```js\nlet a = 1\n```\n\nAfter the code.')
    })

    it('follows the theme: dark on the root, its CodeMirror reads dark, as does a block made while it is', async () => {
        const { editor, container } = openNote({ content: USED })
        await ready(container)
        const cm = cmOf(container)
        // The code's surface is the scroller (the block is bare behind its tabs).
        const surface = (el: HTMLElement) => getComputedStyle(el.querySelector('.cm-scroller') as HTMLElement).backgroundColor
        const token = () => computed(getComputedStyle(cm).getPropertyValue('--cm-background').trim())
        await waitFor(() => surface(cm) === token(), 2000)
        const light = surface(cm)
        document.documentElement.setAttribute('data-theme', 'dark')
        expect(editor.commands.setCodeblockTheme({ dark: true })).toBe(true)
        await waitFor(() => cm.getAttribute('data-theme') === 'dark', 2000)
        const dark = surface(cm)
        expect(dark).not.toBe(light)
        expect(dark).toBe(token())
        // A block made while the root is dark starts dark.
        const second = openNote({ content: USED })
        await ready(second.container)
        await waitFor(() => surface(cmOf(second.container)) === dark, 2000)
        expect(cmOf(second.container).getAttribute('data-theme')).toBe('dark')
    })
})
