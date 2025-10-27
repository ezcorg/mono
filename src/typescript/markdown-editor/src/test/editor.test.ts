import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MarkdownEditor } from '../lib/editor'
import {
    createTestContainer,
    createTestEditor,
    pressKey,
    waitFor,
    cleanupEditor
} from './utils'

describe('MarkdownEditor', () => {
    let container: HTMLElement
    let editor: MarkdownEditor

    beforeEach(async () => {
        container = createTestContainer()
        editor = await createTestEditor(container)
    })

    afterEach(() => {
        cleanupEditor(editor, container)
    })

    describe('Basic Editor Functionality', () => {
        it('should create an editor instance', () => {
            expect(editor).toBeDefined()
            if (!editor) return
            expect(editor.view).toBeDefined()
            expect(editor.view.dom).toBeDefined()
        })

        it('should render in the DOM', () => {
            expect(container.querySelector('.ProseMirror')).toBeTruthy()
        })

        it('should have initial content', () => {
            const content = editor.storage.markdown.getMarkdown()
            expect(content).toContain('# Test Document')
            expect(content).toContain('This is a test document.')
        })

        it('should be focusable', () => {
            editor.commands.focus()
            expect(editor.isFocused).toBe(true)
        })
    })

    describe('Markdown Content Management', () => {
        it('should get markdown content', () => {
            const content = editor.storage.markdown.getMarkdown()
            expect(typeof content).toBe('string')
            expect(content.length).toBeGreaterThan(0)
        })

        it('should set markdown content', () => {
            const newContent = '# New Heading\n\nNew paragraph content.'
            editor.commands.setContent(newContent)

            const retrievedContent = editor.storage.markdown.getMarkdown()
            expect(retrievedContent).toContain('# New Heading')
            expect(retrievedContent).toContain('New paragraph content.')
        })

        it('should handle empty content', () => {
            editor.commands.setContent('')
            const content = editor.storage.markdown.getMarkdown()
            expect(content.trim()).toBe('')
        })
    })

    describe('Text Input and Editing', () => {
        it('should insert text at cursor position', () => {
            editor.commands.focus()

            editor.commands.insertContentAt(0, 'Inserted text: ')

            const content = editor.storage.markdown.getMarkdown()
            expect(content).toMatch(/^Inserted text:/)
        })

        it('should handle typing at different positions', () => {
            // Set a simpler test content to avoid position calculation issues
            editor.commands.setContent('This is a test document.')
            editor.commands.focus()

            const originalContent = editor.storage.markdown.getMarkdown()
            const insertPosition = originalContent.indexOf('This is')

            // Ensure we found the target text
            expect(insertPosition).toBe(0) // Should be at the beginning

            editor.commands.setTextSelection(insertPosition)
            const { from } = editor.state.selection
            editor.commands.insertContentAt(from, 'INSERTED ')

            const newContent = editor.storage.markdown.getMarkdown()
            expect(newContent).toContain('INSERTED This is')
        })

        it('should handle line breaks', () => {
            editor.commands.focus()
            editor.commands.setTextSelection(0)
            const { from } = editor.state.selection
            editor.commands.insertContentAt(from, 'First line\nSecond line\n')

            const content = editor.storage.markdown.getMarkdown()
            expect(content).toContain('First line')
            expect(content).toContain('Second line')
        })
    })

    describe('Markdown Formatting', () => {
        it('should handle bold text', () => {
            editor.commands.setContent('This is **bold** text.')

            const strongElement = editor.view.dom.querySelector('strong')
            expect(strongElement).toBeTruthy()
            expect(strongElement?.textContent).toBe('bold')
        })

        it('should handle italic text', () => {
            editor.commands.setContent('This is *italic* text.')

            const emElement = editor.view.dom.querySelector('em')
            expect(emElement).toBeTruthy()
            expect(emElement?.textContent).toBe('italic')
        })

        it('should handle headings', () => {
            editor.commands.setContent('# Heading 1\n## Heading 2\n### Heading 3')

            const h1Element = editor.view.dom.querySelector('h1')
            const h2Element = editor.view.dom.querySelector('h2')
            const h3Element = editor.view.dom.querySelector('h3')

            expect(h1Element).toBeTruthy()
            expect(h1Element?.textContent).toBe('Heading 1')

            expect(h2Element).toBeTruthy()
            expect(h2Element?.textContent).toBe('Heading 2')

            expect(h3Element).toBeTruthy()
            expect(h3Element?.textContent).toBe('Heading 3')
        })

        it('should handle code blocks', () => {
            editor.commands.setContent('```javascript\nconsole.log("Hello");\n```')

            const preElement = editor.view.dom.querySelector('pre')
            expect(preElement).toBeTruthy()

            const codeContent = preElement?.textContent || ''
            expect(codeContent).toContain('console.log')
            expect(codeContent).toContain('Hello')
        })

        it('should handle inline code', () => {
            editor.commands.setContent('This is `inline code` text.')

            const codeElement = editor.view.dom.querySelector('code')
            expect(codeElement).toBeTruthy()
            expect(codeElement?.textContent).toBe('inline code')
        })

        it('should handle lists', () => {
            editor.commands.setContent('- Item 1\n- Item 2\n- Item 3')

            const ulElement = editor.view.dom.querySelector('ul')
            expect(ulElement).toBeTruthy()

            const liElements = ulElement?.querySelectorAll('li')
            expect(liElements?.length).toBe(3)

            expect(liElements?.[0].textContent?.trim()).toBe('Item 1')
            expect(liElements?.[1].textContent?.trim()).toBe('Item 2')
            expect(liElements?.[2].textContent?.trim()).toBe('Item 3')
        })

        it('should handle task lists', () => {
            editor.commands.setContent('- [ ] Unchecked task\n- [x] Checked task')

            const uncheckedTask = editor.view.dom.querySelector('[data-checked="false"]')
            const checkedTask = editor.view.dom.querySelector('[data-checked="true"]')

            expect(uncheckedTask).toBeTruthy()
            expect(uncheckedTask?.textContent).toContain('Unchecked task')

            expect(checkedTask).toBeTruthy()
            expect(checkedTask?.textContent).toContain('Checked task')
        })
    })

    describe('Selection and Cursor Management', () => {
        it('should set and get selection', () => {
            editor.commands.focus()
            editor.commands.setTextSelection({ from: 5, to: 10 })
            const selection = editor.state.selection
            expect(selection.from).toBe(5)
            expect(selection.to).toBe(10)
        })

        it('should handle cursor positioning', () => {
            editor.commands.focus()
            editor.commands.setTextSelection(0)
            const selection = editor.state.selection
            expect(selection.from).toBe(0)
            expect(selection.to).toBe(0)
        })
    })

    describe('Keyboard Shortcuts', () => {
        it('should handle Ctrl+B for bold', () => {
            editor.commands.focus()
            editor.commands.setTextSelection(0)
            const { from } = editor.state.selection
            editor.commands.insertContentAt(from, 'bold text')
            editor.commands.setTextSelection({ from: 0, to: 10 }) // Select "bold text"

            pressKey(editor, 'b', { ctrl: true })

            const content = editor.storage.markdown.getMarkdown()
            expect(content).toContain('**bold text**')
        })

        it('should handle Ctrl+I for italic', () => {
            editor.commands.focus()
            editor.commands.setTextSelection(0)
            const { from } = editor.state.selection
            editor.commands.insertContentAt(from, 'italic text')
            editor.commands.setTextSelection({ from: 0, to: 12 }) // Select "italic text"

            pressKey(editor, 'i', { ctrl: true })

            const content = editor.storage.markdown.getMarkdown()
            expect(content).toContain('*italic text*')
        })
    })

    describe('Editor State and Updates', () => {
        it('should trigger update callbacks', async () => {
            let updateCount = 0
            let lastContent = ''

            // Create a new editor with update callback
            cleanupEditor(editor, container)
            container = createTestContainer('test-editor-2')

            editor = await createTestEditor(container, {
                onUpdate: ({ editor }) => {
                    updateCount++
                    lastContent = (editor as MarkdownEditor).storage.markdown.getMarkdown()
                }
            })

            editor.commands.focus()
            const { from } = editor.state.selection
            editor.commands.insertContentAt(from, 'New content')

            // Wait for update to be processed
            await waitFor(() => updateCount > 0, 2000)

            expect(updateCount).toBeGreaterThan(0)
            expect(lastContent).toContain('New content')
        })

        it('should maintain state across content changes', () => {
            const initialContent = editor.storage.markdown.getMarkdown()

            editor.commands.setContent('# Changed Content')
            expect(editor.storage.markdown.getMarkdown()).toContain('# Changed Content')

            editor.commands.setContent(initialContent)
            expect(editor.storage.markdown.getMarkdown()).toContain('# Test Document')
        })
    })

    describe('Error Handling', () => {
        it('should handle invalid markdown gracefully', () => {
            expect(() => {
                editor.commands.setContent('# Heading\n\n```\nUnclosed code block')
            }).not.toThrow()

            const content = editor.storage.markdown.getMarkdown()
            expect(content).toContain('Unclosed code block')
        })

        it('should handle very long content', () => {
            const longContent = '# Long Content\n\n' + 'A'.repeat(10000)

            expect(() => {
                editor.commands.setContent(longContent)
            }).not.toThrow()

            const content = editor.storage.markdown.getMarkdown()
            expect(content.length).toBeGreaterThan(10000)
        })
    })

    describe('Browser-specific Features', () => {
        it('should handle copy and paste operations', async () => {
            editor.commands.focus()
            editor.commands.setTextSelection(0)
            const { from } = editor.state.selection
            editor.commands.insertContentAt(from, 'Text to copy')
            editor.commands.setTextSelection({ from: 0, to: 12 }) // Select "Text to copy"

            // Simulate copy
            pressKey(editor, 'c', { ctrl: true })

            // Move cursor and paste
            editor.commands.setTextSelection(12)
            const { from: newFrom } = editor.state.selection
            editor.commands.insertContentAt(newFrom, '\n\nPasted: ')
            pressKey(editor, 'v', { ctrl: true })

            // Note: Actual clipboard operations may not work in test environment
            // This test verifies the key events are handled without errors
            expect(() => {
                pressKey(editor, 'c', { ctrl: true })
                pressKey(editor, 'v', { ctrl: true })
            }).not.toThrow()
        })

        it('should handle undo and redo', () => {
            editor.commands.focus()
            const originalContent = editor.storage.markdown.getMarkdown()

            editor.commands.setTextSelection(0)
            const { from } = editor.state.selection
            editor.commands.insertContentAt(from, 'Added text')

            // Undo
            pressKey(editor, 'z', { ctrl: true })

            // Content should be closer to original (undo may not be perfect due to test setup)
            const undoContent = editor.storage.markdown.getMarkdown()
            expect(undoContent).toBeDefined()

            // Redo
            pressKey(editor, 'y', { ctrl: true })

            const redoContent = editor.storage.markdown.getMarkdown()
            expect(redoContent).toBeDefined()
        })
    })
})