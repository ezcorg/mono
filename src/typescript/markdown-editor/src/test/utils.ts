import { MarkdownEditor, createEditor, MarkdownEditorOptions } from '../lib/editor'
import { CodeblockFS, type Fs } from '@ezdevlol/codeblock'

/**
 * Test utilities for markdown editor testing
 */

/**
 * Creates a test container element in the DOM
 */
export function createTestContainer(id = 'test-editor'): HTMLElement {
    const container = document.createElement('div')
    container.id = id
    container.style.width = '800px'
    container.style.height = '600px'
    document.body.appendChild(container)
    return container
}

/**
 * Removes a test container from the DOM
 */
export function removeTestContainer(container: HTMLElement): void {
    if (container.parentNode) {
        container.parentNode.removeChild(container)
    }
}

/**
 * Creates a mock filesystem for testing
 */
export async function createMockFS(): Promise<Fs | null> {
    try {
        // Create a minimal filesystem for testing
        const fs = await CodeblockFS.worker()
        return fs
    } catch (error) {
        console.warn('Failed to create filesystem for testing:', error)
        return null
    }
}

/**
 * Creates a test markdown editor instance
 */
export async function createTestEditor(
    container: HTMLElement,
    options: Partial<MarkdownEditorOptions> = {}
): Promise<MarkdownEditor> {
    try {
        const fs = await createMockFS()

        const defaultOptions: MarkdownEditorOptions = {
            element: container,
            content: '# Test Document\n\nThis is a test document.',
            // Only include fs if it was successfully created
            ...(fs ? {
                fs: {
                    fs: fs,
                    filepath: 'test.md',
                    autoSave: false,
                }
            } : {}),
            ...options,
        }

        const editor = createEditor(defaultOptions)

        // Give the editor a moment to initialize
        await new Promise(resolve => setTimeout(resolve, 100))

        return editor
    } catch (error) {
        console.error('Failed to create test editor:', error)
        throw error
    }
}

/**
 * Waits for the editor to be ready and rendered
 */
export function waitForEditor(editor: MarkdownEditor, timeout = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
        const startTime = Date.now()

        const checkReady = () => {
            if (editor.view && editor.view.dom && editor.view.dom.isConnected) {
                resolve()
            } else if (Date.now() - startTime > timeout) {
                reject(new Error('Editor did not become ready within timeout'))
            } else {
                setTimeout(checkReady, 100)
            }
        }

        checkReady()
    })
}

/**
 * Gets the current markdown content from the editor
 */
export function getMarkdownContent(editor: MarkdownEditor): string {
    return editor.storage.markdown.getMarkdown()
}

/**
 * Sets markdown content in the editor
 */
export function setMarkdownContent(editor: MarkdownEditor, content: string): void {
    editor.commands.setContent(content)
}

/**
 * Simulates typing text in the editor
 */
export function typeText(editor: MarkdownEditor, text: string): void {
    // Use insertContentAt with the current selection position to ensure
    // text is inserted exactly where the cursor is
    const { from } = editor.state.selection
    console.log('editor state selection', { from })
    editor.commands.insertContentAt(from, text)
}

/**
 * Simulates key press in the editor
 */
export function pressKey(editor: MarkdownEditor, key: string, modifiers: { ctrl?: boolean, shift?: boolean, alt?: boolean } = {}): void {
    const event = new KeyboardEvent('keydown', {
        key,
        ctrlKey: modifiers.ctrl || false,
        shiftKey: modifiers.shift || false,
        altKey: modifiers.alt || false,
        bubbles: true,
    })

    editor.view.dom.dispatchEvent(event)
}

/**
 * Gets the HTML content of the editor
 */
export function getHTMLContent(editor: MarkdownEditor): string {
    return editor.getHTML()
}

/**
 * Checks if the editor has focus
 */
export function isEditorFocused(editor: MarkdownEditor): boolean {
    return editor.isFocused
}

/**
 * Focuses the editor
 */
export function focusEditor(editor: MarkdownEditor): void {
    editor.commands.focus()
}

/**
 * Gets the current selection in the editor
 */
export function getSelection(editor: MarkdownEditor) {
    return editor.state.selection
}

/**
 * Sets the selection in the editor
 */
export function setSelection(editor: MarkdownEditor, from: number, to?: number): void {
    to ? editor.commands.setTextSelection({ from, to }) : editor.commands.setTextSelection(from)
}

/**
 * Waits for a specific condition to be true
 */
export function waitFor(
    condition: () => boolean,
    timeout = 5000,
    interval = 100
): Promise<void> {
    return new Promise((resolve, reject) => {
        const startTime = Date.now()

        const check = () => {
            if (condition()) {
                resolve()
            } else if (Date.now() - startTime > timeout) {
                reject(new Error('Condition not met within timeout'))
            } else {
                setTimeout(check, interval)
            }
        }

        check()
    })
}

/**
 * Cleanup function to destroy editor and remove container
 */
export function cleanupEditor(editor: MarkdownEditor | undefined, container: HTMLElement): void {
    if (editor && typeof editor.destroy === 'function') {
        try {
            editor.destroy()
        } catch (error) {
            console.warn('Error destroying editor:', error)
        }
    }
    removeTestContainer(container)
}