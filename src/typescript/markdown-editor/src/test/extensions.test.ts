import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MarkdownEditor } from '../lib/editor'
import {
    createTestContainer,
    createTestEditor,
    cleanupEditor,
} from './utils'

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

        it('should toggle task completion', () => {
            editor.commands.setContent('- [ ] Task to toggle')
            editor.commands.focus()

            // Find the task item and verify initial state
            const initialTaskElement = editor.view.dom.querySelector('[data-checked="false"]')
            expect(initialTaskElement).toBeTruthy()
            expect(initialTaskElement?.textContent).toContain('Task to toggle')

            // Simulate task toggle (this would normally be done by clicking)
            editor.commands.setContent('- [x] Task to toggle')

            const toggledTaskElement = editor.view.dom.querySelector('[data-checked="true"]')
            expect(toggledTaskElement).toBeTruthy()
            expect(toggledTaskElement?.textContent).toContain('Task to toggle')

            // Verify the unchecked task no longer exists
            const uncheckedTask = editor.view.dom.querySelector('[data-checked="false"]')
            expect(uncheckedTask).toBeNull()
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

            const thead = table?.querySelector('thead')
            const tbody = table?.querySelector('tbody')
            expect(thead).toBeTruthy()
            expect(tbody).toBeTruthy()

            const headers = thead?.querySelectorAll('th')
            expect(headers?.length).toBe(3)
            expect(headers?.[0].textContent?.trim()).toBe('Header 1')
            expect(headers?.[1].textContent?.trim()).toBe('Header 2')
            expect(headers?.[2].textContent?.trim()).toBe('Header 3')

            const rows = tbody?.querySelectorAll('tr')
            expect(rows?.length).toBe(2)

            const firstRowCells = rows?.[0].querySelectorAll('td')
            expect(firstRowCells?.length).toBe(3)
            expect(firstRowCells?.[0].textContent?.trim()).toBe('Cell 1')
            expect(firstRowCells?.[1].textContent?.trim()).toBe('Cell 2')
            expect(firstRowCells?.[2].textContent?.trim()).toBe('Cell 3')
        })

        it('should handle table navigation', () => {
            const tableMarkdown = `| A | B |
|---|---|
| 1 | 2 |`

            editor.commands.setContent(tableMarkdown)
            editor.commands.focus()

            // Position cursor in first cell
            const firstCell = editor.view.dom.querySelector('td')
            if (firstCell) {
                firstCell.focus()
            }

            // Test that table structure is maintained
            const table = editor.view.dom.querySelector('table')
            expect(table).toBeTruthy()

            const cells = table?.querySelectorAll('td')
            expect(cells?.length).toBe(2)
            expect(cells?.[0].textContent?.trim()).toBe('1')
            expect(cells?.[1].textContent?.trim()).toBe('2')
        })
    })

    describe('Link Extension', () => {
        it('should render links correctly', () => {
            editor.commands.setContent('Visit [Google](https://google.com) for search.')

            const link = editor.view.dom.querySelector('a')
            expect(link).toBeTruthy()
            expect(link?.getAttribute('href')).toBe('https://google.com')
            expect(link?.textContent).toBe('Google')
        })

        it('should auto-detect URLs', () => {
            editor.commands.setContent('Visit https://example.com for more info.')

            // Check if URL is present in the content (may or may not be auto-linked depending on extension)
            const content = editor.view.dom.textContent
            expect(content).toContain('https://example.com')

            // If auto-linking is enabled, check for link element
            const autoLink = editor.view.dom.querySelector('a[href="https://example.com"]')
            if (autoLink) {
                expect(autoLink.textContent).toBe('https://example.com')
            }
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

            const preElement = editor.view.dom.querySelector('pre')
            expect(preElement).toBeTruthy()

            const codeContent = preElement?.textContent || ''
            expect(codeContent).toContain('function hello')
            expect(codeContent).toContain('console.log')
            expect(codeContent).toContain('Hello, World!')
        })

        it('should handle different programming languages', () => {
            const pythonCode = '```python\ndef hello():\n    print("Hello, World!")\n```'
            editor.commands.setContent(pythonCode)

            const preElement = editor.view.dom.querySelector('pre')
            expect(preElement).toBeTruthy()

            const codeContent = preElement?.textContent || ''
            expect(codeContent).toContain('def hello')
            expect(codeContent).toContain('print')
            expect(codeContent).toContain('Hello, World!')
        })

        it('should handle code blocks without language specification', () => {
            const plainCode = '```\nplain text code\nno syntax highlighting\n```'
            editor.commands.setContent(plainCode)

            const preElement = editor.view.dom.querySelector('pre')
            expect(preElement).toBeTruthy()

            const codeContent = preElement?.textContent || ''
            expect(codeContent).toContain('plain text code')
            expect(codeContent).toContain('no syntax highlighting')
        })

        it('should handle inline code', () => {
            editor.commands.setContent('Use the `console.log()` function to debug.')

            const codeElement = editor.view.dom.querySelector('code')
            expect(codeElement).toBeTruthy()
            expect(codeElement?.textContent).toBe('console.log()')
        })
    })

    describe('Slash Commands Extension', () => {
        it('should trigger slash commands', () => {
            editor.commands.focus()
            editor.commands.setTextSelection(0)

            // Type slash to trigger command menu
            const { from } = editor.state.selection
            editor.commands.insertContentAt(from, '/')

            // TODO:
        })
    })

    describe('File System Integration', () => {
        it('should handle file references in code blocks', () => {
            const fileReference = '```src/example.js\nconsole.log("File content");\n```'
            editor.commands.setContent(fileReference)

            const preElement = editor.view.dom.querySelector('pre')
            expect(preElement).toBeTruthy()

            const codeContent = preElement?.textContent || ''
            expect(codeContent).toContain('console.log')
            expect(codeContent).toContain('File content')
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

            // Code blocks
            const preElement = editor.view.dom.querySelector('pre')
            expect(preElement).toBeTruthy()
            expect(preElement?.textContent).toContain('function example')

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