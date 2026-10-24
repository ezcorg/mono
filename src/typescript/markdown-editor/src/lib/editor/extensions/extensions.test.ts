import type { JSONContent } from '@tiptap/core'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { MarkdownEditor } from '../index'
import {
    createTestContainer,
    createTestEditor,
    cleanupEditor,
    getMarkdownContent,
    waitFor,
} from '../../../test/utils'

describe('MarkdownEditor Extensions', () => {
    let container: HTMLElement
    let editor: MarkdownEditor

    beforeEach(async () => {
        container = createTestContainer()
        editor = await createTestEditor(container)
        // await waitForEditor(editor)
    })

    afterEach(() => {
        cleanupEditor(editor, container)
    })

    describe('Task List Extension', () => {
        it('should render task lists correctly', () => {
            editor.commands.setContent('- [ ] Unchecked task\n- [x] Checked task\n- [ ] Another unchecked')

            const uncheckedTasks = editor.view.dom.querySelectorAll('[data-checked="false"]')
            const checkedTasks = editor.view.dom.querySelectorAll('[data-checked="true"]')

            expect(uncheckedTasks.length).toBe(2)
            expect(checkedTasks.length).toBe(1)

            expect(uncheckedTasks[0].textContent).toContain('Unchecked task')
            expect(checkedTasks[0].textContent).toContain('Checked task')
            expect(uncheckedTasks[1].textContent).toContain('Another unchecked')
        })

        it('toggles a task on a click of its checkbox, and back', async () => {
            editor.commands.setContent('- [ ] Task to toggle')
            await new Promise((r) => requestAnimationFrame(r))
            const item = () => editor.view.dom.querySelector('li[data-type="taskItem"]') as HTMLElement
            const checked = () => {
                const json: JSONContent = editor.getJSON()
                return json.content?.[0]?.content?.[0]?.attrs?.checked
            }
            const checkbox = item().querySelector('input[type="checkbox"]') as HTMLInputElement
            expect(checkbox.checked).toBe(false)
            expect(item().getAttribute('data-checked')).toBe('false')

            await userEvent.click(checkbox)
            await waitFor(() => item().getAttribute('data-checked') === 'true', 2000)
            expect(checkbox.checked).toBe(true)
            expect(checked()).toBe(true)
            // (Written back with the marker it was written with.)
            expect(getMarkdownContent(editor).trim()).toBe('- [x] Task to toggle')
            expect(item().textContent).toContain('Task to toggle')

            await userEvent.click(checkbox)
            await waitFor(() => item().getAttribute('data-checked') === 'false', 2000)
            expect(checkbox.checked).toBe(false)
            expect(checked()).toBe(false)
            expect(getMarkdownContent(editor).trim()).toBe('- [ ] Task to toggle')
        })

        it('should handle nested task lists', () => {
            const nestedTasks = `- [ ] Parent task
  - [ ] Child task 1
  - [x] Child task 2
- [x] Another parent task`

            editor.commands.setContent(nestedTasks)

            const allTasks = editor.view.dom.querySelectorAll('[data-checked]')
            expect(allTasks.length).toBe(4)

            const uncheckedTasks = editor.view.dom.querySelectorAll('[data-checked="false"]')
            const checkedTasks = editor.view.dom.querySelectorAll('[data-checked="true"]')

            expect(uncheckedTasks.length).toBe(2)
            expect(checkedTasks.length).toBe(2)

            // Verify task content
            const taskTexts = Array.from(allTasks).map(task => task.textContent?.trim())
            expect(taskTexts).toEqual(expect.arrayContaining([
                expect.stringContaining('Parent task'),
                expect.stringContaining('Child task 1'),
                expect.stringContaining('Child task 2'),
                expect.stringContaining('Another parent task')
            ]))
        })
    })

    describe('Table Extension', () => {
        it('should render tables correctly', () => {
            const tableMarkdown = `| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |`

            editor.commands.setContent(tableMarkdown)

            const table = editor.view.dom.querySelector('table')
            expect(table).toBeTruthy()

            // Tiptap renders header cells as <th> directly in <tr>, without <thead>/<tbody> wrappers
            const headers = table?.querySelectorAll('th')
            expect(headers?.length).toBe(3)
            expect(headers?.[0].textContent?.trim()).toBe('Header 1')
            expect(headers?.[1].textContent?.trim()).toBe('Header 2')
            expect(headers?.[2].textContent?.trim()).toBe('Header 3')

            const dataCells = table?.querySelectorAll('td')
            expect(dataCells?.length).toBe(6)
            expect(dataCells?.[0].textContent?.trim()).toBe('Cell 1')
            expect(dataCells?.[1].textContent?.trim()).toBe('Cell 2')
            expect(dataCells?.[2].textContent?.trim()).toBe('Cell 3')
        })

        // Moving between cells with Tab, Enter and the arrows: table.test.ts.
    })

    describe('Link Extension', () => {
        it('should render links correctly', () => {
            editor.commands.setContent('Visit [Google](https://google.com) for search.')

            const link = editor.view.dom.querySelector('a')
            expect(link).toBeTruthy()
            expect(link?.getAttribute('href')).toBe('https://google.com')
            expect(link?.textContent).toBe('Google')
        })

        it('links a URL typed as a word of its own, once the space after it is typed', async () => {
            editor.commands.setContent('Visit')
            await new Promise((r) => requestAnimationFrame(r))
            editor.commands.focus('end')
            await userEvent.keyboard(' https://example.com')
            // Still being typed: not a link yet.
            expect(editor.view.dom.querySelector('a')).toBeNull()
            await userEvent.keyboard(' for more info.')
            const link = editor.view.dom.querySelector('a[href="https://example.com"]')
            expect(link).not.toBeNull()
            expect(link!.textContent).toBe('https://example.com')
            expect(editor.view.dom.textContent).toBe('Visit https://example.com for more info.')
            // The link ends with the URL: what followed is text.
            expect(getMarkdownContent(editor)).toBe('Visit <https://example.com> for more info.')
        })

        it('should handle email links', () => {
            editor.commands.setContent('Contact us at [email](mailto:test@example.com)')

            const emailLink = editor.view.dom.querySelector('a[href="mailto:test@example.com"]')
            expect(emailLink).toBeTruthy()
            expect(emailLink?.textContent).toBe('email')
            expect(emailLink?.getAttribute('href')).toBe('mailto:test@example.com')
        })
    })

    describe('Code Block Extension', () => {
        it('should render code blocks with syntax highlighting', () => {
            const codeBlock = '```javascript\nfunction hello() {\n  console.log("Hello, World!");\n}\n```'
            editor.commands.setContent(codeBlock)

            // Code blocks render via CodeMirror node view, not <pre>
            const json: JSONContent = editor.getJSON()
            const codeNode = json.content?.find((n) => n.type === 'ezcodeBlock' || n.type === 'codeBlock')
            expect(codeNode).toBeTruthy()
            expect(codeNode?.attrs?.language).toBe('javascript')
            expect(codeNode?.content?.[0]?.text).toContain('function hello')
        })

        it('should handle different programming languages', () => {
            const pythonCode = '```python\ndef hello():\n    print("Hello, World!")\n```'
            editor.commands.setContent(pythonCode)

            const json: JSONContent = editor.getJSON()
            const codeNode = json.content?.find((n) => n.type === 'ezcodeBlock' || n.type === 'codeBlock')
            expect(codeNode).toBeTruthy()
            expect(codeNode?.attrs?.language).toBe('python')
            expect(codeNode?.content?.[0]?.text).toContain('def hello')
        })

        it('should handle code blocks without language specification', () => {
            const plainCode = '```\nplain text code\nno syntax highlighting\n```'
            editor.commands.setContent(plainCode)

            const json: JSONContent = editor.getJSON()
            const codeNode = json.content?.find((n) => n.type === 'ezcodeBlock' || n.type === 'codeBlock')
            expect(codeNode).toBeTruthy()
            expect(codeNode?.content?.[0]?.text).toContain('plain text code')
        })

        it('should handle inline code', () => {
            editor.commands.setContent('Use the `console.log()` function to debug.')

            const codeElement = editor.view.dom.querySelector('code')
            expect(codeElement).toBeTruthy()
            expect(codeElement?.textContent).toBe('console.log()')
        })
    })

    // The slash menu (typed, filtered, arrowed, run, closed): slash-commands.test.ts.

    describe('File System Integration', () => {
        it('should handle file references in code blocks', () => {
            const fileReference = '```src/example.js\nconsole.log("File content");\n```'
            editor.commands.setContent(fileReference)

            // Verify via JSON — CodeMirror node view doesn't render <pre>
            const json: JSONContent = editor.getJSON()
            const codeNode = json.content?.find((n) => n.type === 'ezcodeBlock' || n.type === 'codeBlock')
            expect(codeNode).toBeTruthy()
            expect(codeNode?.content?.[0]?.text).toContain('console.log')
            expect(codeNode?.content?.[0]?.text).toContain('File content')
        })

        it('should maintain file system state', () => {
            // Test that the editor maintains its filesystem integration
            expect(editor.storage).toBeDefined()
            expect(editor.storage.markdown).toBeDefined()
        })
    })

    describe('Markdown Storage', () => {
        it('should provide markdown storage interface', () => {
            expect(editor.storage.markdown).toBeDefined()
            expect(typeof editor.storage.markdown.getMarkdown).toBe('function')
        })

        it('should sync markdown content with storage', () => {
            const testContent = '# Storage Test\n\nThis tests the storage interface.'
            editor.commands.setContent(testContent)

            const storedContent = editor.storage.markdown.getMarkdown()
            expect(storedContent).toContain('# Storage Test')
            expect(storedContent).toContain('This tests the storage interface.')
        })
    })

    describe('Extension Interactions', () => {
        it('should handle multiple extensions working together', () => {
            const complexContent = `# Document with Multiple Features

## Task List
- [ ] Incomplete task
- [x] Complete task

## Code Example
\`\`\`javascript
function example() {
  return "Hello, World!";
}
\`\`\`

## Table
| Feature | Status |
|---------|--------|
| Tasks   | ✓      |
| Code    | ✓      |
| Tables  | ✓      |

## Links
Visit [our website](https://example.com) for more info.`

            editor.commands.setContent(complexContent)

            // Verify all extensions are working
            const h1 = editor.view.dom.querySelector('h1')
            const h2Elements = editor.view.dom.querySelectorAll('h2')
            expect(h1).toBeTruthy()
            expect(h1?.textContent).toContain('Document with Multiple Features')
            expect(h2Elements.length).toBeGreaterThan(0)

            // Task lists
            const taskElements = editor.view.dom.querySelectorAll('[data-checked]')
            expect(taskElements.length).toBe(2)
            expect(editor.view.dom.querySelector('[data-checked="false"]')).toBeTruthy()
            expect(editor.view.dom.querySelector('[data-checked="true"]')).toBeTruthy()

            // Code blocks (verified via JSON since CodeMirror node view replaces <pre>)
            const json: JSONContent = editor.getJSON()
            const codeNode = json.content?.find((n) => n.type === 'ezcodeBlock' || n.type === 'codeBlock')
            expect(codeNode).toBeTruthy()
            expect(codeNode?.content?.[0]?.text).toContain('function example')

            // Tables
            const table = editor.view.dom.querySelector('table')
            expect(table).toBeTruthy()
            const tableHeaders = table?.querySelectorAll('th')
            expect(tableHeaders?.length).toBe(2)

            // Links
            const link = editor.view.dom.querySelector('a[href="https://example.com"]')
            expect(link).toBeTruthy()
            expect(link?.textContent).toBe('our website')
        })
    })
})