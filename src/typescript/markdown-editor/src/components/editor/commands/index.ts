import { SlashCommand } from '../extensions/slash-commands'
import { extToLanguageMap } from '@ezdevlol/codeblock'
import { CodeblockFS } from '@ezdevlol/codeblock'

// File picker utility function that reads file content and returns both filename and content
const openFilePicker = async (fs: any): Promise<{ filename: string; content: string } | null> => {
    return new Promise((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '*/*'
        input.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0]
            if (file) {
                try {
                    // Read file content
                    const content = await file.text()
                    console.log('File picker read content:', content.length, 'characters from', file.name, fs)

                    // If filesystem is available, try to copy file
                    if (fs) {
                        try {
                            // Create directory structure if needed
                            const pathParts = file.name.split('/')
                            if (pathParts.length > 1) {
                                const dirPath = pathParts.slice(0, -1).join('/')
                                try {
                                    await fs.mkdir(dirPath, { recursive: true })
                                } catch (error) {
                                    // Directory might already exist, ignore error
                                }
                            }

                            // Write file to in-app filesystem
                            await fs.writeFile(file.name, content)
                            console.log('File copied to in-app filesystem')
                        } catch (error) {
                            console.error('Failed to copy file to in-app filesystem:', error)
                        }
                    }

                    resolve({ filename: file.name, content })
                } catch (error) {
                    console.error('Failed to read file content:', error)
                    resolve(null)
                }
            } else {
                resolve(null)
            }
        }
        input.oncancel = () => resolve(null)
        input.click()
    })
}

// File picker modal utility function with typeahead
const openFilePickerModal = async (fs: any): Promise<string | { filename: string; content: string } | null> => {
    console.log('openFilePickerModal called with fs:', fs)
    return new Promise(async (resolve) => {
        let resolved = false
        const safeResolve = (value: string | { filename: string; content: string } | null) => {
            if (!resolved) {
                resolved = true
                resolve(value)
            }
        }
        // Get all files from filesystem for suggestions
        let allFiles: string[] = []
        if (fs) {
            try {
                for await (const file of CodeblockFS.walk(fs, '/')) {
                    allFiles.push(file.startsWith('/') ? file.slice(1) : file)
                }
            } catch (error) {
                console.warn('Failed to load files for suggestions:', error)
            }
        }

        // Create modal
        const modal = document.createElement('div')
        modal.className = 'file-picker-modal-overlay'

        const modalContent = document.createElement('div')
        modalContent.className = 'file-picker-modal'

        modalContent.innerHTML = `
            <div class="file-picker-header">
                <h3>Select or Enter File</h3>
                <button class="file-picker-close">&times;</button>
            </div>
            <div class="file-picker-content">
                <div class="file-picker-input-group">
                    <input type="text" id="file-picker-input" placeholder="Enter filename or search..." autocomplete="off">
                    <div class="file-picker-suggestions" id="file-picker-suggestions"></div>
                </div>
                <div class="file-picker-actions">
                    <button class="file-picker-browse">Browse Files</button>
                    <span class="file-picker-or">or leave empty to open file picker</span>
                </div>
            </div>
            <div class="file-picker-footer">
                <button class="file-picker-cancel">Cancel</button>
                <button class="file-picker-confirm">Confirm</button>
            </div>
        `

        modal.appendChild(modalContent)

        const input = modal.querySelector('#file-picker-input') as HTMLInputElement
        const suggestions = modal.querySelector('#file-picker-suggestions') as HTMLElement
        const closeButton = modal.querySelector('.file-picker-close') as HTMLButtonElement
        const cancelButton = modal.querySelector('.file-picker-cancel') as HTMLButtonElement
        const confirmButton = modal.querySelector('.file-picker-confirm') as HTMLButtonElement
        const browseButton = modal.querySelector('.file-picker-browse') as HTMLButtonElement

        let selectedSuggestionIndex = -1
        let filteredFiles: string[] = []

        // Filter and display suggestions
        const updateSuggestions = (query: string) => {
            filteredFiles = allFiles.filter(file =>
                file.toLowerCase().includes(query.toLowerCase())
            ).slice(0, 10) // Limit to 10 suggestions

            suggestions.innerHTML = ''

            if (query && filteredFiles.length > 0) {
                suggestions.style.display = 'block'
                filteredFiles.forEach((file, index) => {
                    const suggestion = document.createElement('div')
                    suggestion.className = `file-suggestion ${index === selectedSuggestionIndex ? 'selected' : ''}`
                    suggestion.textContent = file
                    suggestion.addEventListener('click', () => {
                        input.value = file
                        suggestions.style.display = 'none'
                        selectedSuggestionIndex = -1
                    })
                    suggestions.appendChild(suggestion)
                })
            } else {
                suggestions.style.display = 'none'
                selectedSuggestionIndex = -1
            }
        }

        // Input event handlers
        input.addEventListener('input', (e) => {
            const query = (e.target as HTMLInputElement).value
            updateSuggestions(query)
        })

        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                if (filteredFiles.length > 0) {
                    selectedSuggestionIndex = Math.min(selectedSuggestionIndex + 1, filteredFiles.length - 1)
                    updateSuggestionSelection()
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                if (filteredFiles.length > 0) {
                    selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1)
                    updateSuggestionSelection()
                }
            } else if (e.key === 'Enter') {
                e.preventDefault()
                if (selectedSuggestionIndex >= 0 && filteredFiles[selectedSuggestionIndex]) {
                    input.value = filteredFiles[selectedSuggestionIndex]
                    suggestions.style.display = 'none'
                    selectedSuggestionIndex = -1
                } else {
                    confirmSelection()
                }
            } else if (e.key === 'Escape') {
                e.preventDefault()
                if (suggestions.style.display === 'block') {
                    suggestions.style.display = 'none'
                    selectedSuggestionIndex = -1
                } else {
                    closeModal()
                }
            }
        })

        const updateSuggestionSelection = () => {
            const suggestionElements = suggestions.querySelectorAll('.file-suggestion')
            suggestionElements.forEach((el, index) => {
                if (index === selectedSuggestionIndex) {
                    el.classList.add('selected')
                } else {
                    el.classList.remove('selected')
                }
            })
        }

        const closeModal = () => {
            console.log('closeModal called')
            if (document.body.contains(modal)) {
                document.body.removeChild(modal)
            }
            safeResolve(null)
        }

        const confirmSelection = () => {
            const filename = input.value.trim()
            console.log('confirmSelection called with filename:', filename)
            closeModal()
            safeResolve(filename || null)
        }

        // Event listeners
        closeButton.addEventListener('click', closeModal)
        cancelButton.addEventListener('click', closeModal)
        confirmButton.addEventListener('click', confirmSelection)

        browseButton.addEventListener('click', async () => {
            // Don't close modal immediately - wait for file picker result
            try {
                const fileResult = await openFilePicker(fs)
                console.log('File picker returned:', fileResult)
                if (document.body.contains(modal)) {
                    document.body.removeChild(modal)
                }
                safeResolve(fileResult || null)
            } catch (error) {
                console.error('File picker error:', error)
                if (document.body.contains(modal)) {
                    document.body.removeChild(modal)
                }
                safeResolve(null)
            }
        })

        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal()
        })

        // Handle escape key globally
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && suggestions.style.display !== 'block') {
                closeModal()
                document.removeEventListener('keydown', handleEscape)
            }
        }
        document.addEventListener('keydown', handleEscape)

        document.body.appendChild(modal)
        console.log('Modal appended to body, focusing input')
        input.focus()
    })
}

// Settings modal utility function
const openSettingsModal = (editor: any) => {
    // Create a simple modal for settings
    const modal = document.createElement('div')
    modal.className = 'settings-modal-overlay'

    const modalContent = document.createElement('div')
    modalContent.className = 'settings-modal'

    modalContent.innerHTML = `
    <div class="settings-header">
      <h3>Editor Settings</h3>
      <button class="settings-close">&times;</button>
    </div>
    <div class="settings-content">
      <div class="setting-group">
        <label>
          <input type="checkbox" id="auto-save" ${editor.storage.persistence?.options?.autoSave ? 'checked' : ''}>
          Auto-save documents
        </label>
      </div>
      <div class="setting-group">
        <label>
          <input type="checkbox" id="word-wrap" checked>
          Word wrap
        </label>
      </div>
      <div class="setting-group">
        <label>
          Theme:
          <select id="theme-select">
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="auto">Auto</option>
          </select>
        </label>
      </div>
    </div>
    <div class="settings-footer">
      <button class="settings-save">Save</button>
      <button class="settings-cancel">Cancel</button>
    </div>
  `

    modal.appendChild(modalContent)

    const closeModal = () => {
        if (document.body.contains(modal)) {
            document.body.removeChild(modal)
        }
    }

    const saveSettings = () => {
        const autoSave = (modal.querySelector('#auto-save') as HTMLInputElement).checked
        const theme = (modal.querySelector('#theme-select') as HTMLSelectElement).value

        // Apply settings
        if (editor.storage.persistence?.options) {
            editor.storage.persistence.options.autoSave = autoSave
        }

        // Apply theme (you can extend this based on your theme system)
        document.documentElement.setAttribute('data-theme', theme)

        console.log('Settings saved:', { autoSave, theme })
        closeModal()
    }

    // Event listeners
    const closeButton = modal.querySelector('.settings-close')
    const cancelButton = modal.querySelector('.settings-cancel')
    const saveButton = modal.querySelector('.settings-save')

    if (closeButton) closeButton.addEventListener('click', closeModal)
    if (cancelButton) cancelButton.addEventListener('click', closeModal)
    if (saveButton) saveButton.addEventListener('click', saveSettings)

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal()
    })

    // Handle escape key
    const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            closeModal()
            document.removeEventListener('keydown', handleEscape)
        }
    }
    document.addEventListener('keydown', handleEscape)

    document.body.appendChild(modal)
}


export const defaultSlashCommands: SlashCommand[] = [
    // {
    //     title: 'Code',
    //     description: 'Create or edit a file with syntax highlighting',
    //     icon: '📝',
    //     command: async ({ editor, range }) => {
    //         try {
    //             // Remove the slash command text
    //             editor.chain().focus().deleteRange(range).run()

    //             // Get filesystem instance from editor storage
    //             const fs = editor.storage.persistence?.options?.fs
    //             console.log('About to call openFilePickerModal with fs:', fs)
    //             // Use the new file picker modal
    //             let modalResult = await openFilePickerModal(fs)

    //             console.log('File picker modal result:', modalResult)

    //             if (modalResult === null) {
    //                 // User cancelled
    //                 return
    //             }

    //             let filename: string
    //             let fileContent = ''

    //             // Check if modalResult is a file object (from browse button) or just a filename string
    //             if (typeof modalResult === 'object' && modalResult.filename) {
    //                 // Result from browse button - already has filename and content
    //                 filename = String(modalResult.filename)
    //                 fileContent = String(modalResult.content)
    //                 console.log('Using file from browse button:', filename, 'with', fileContent.length, 'characters')
    //             } else if (typeof modalResult === 'string') {
    //                 // Result from manual input
    //                 if (!modalResult || modalResult.trim() === '') {
    //                     // Empty filename - open file picker and get both filename and content
    //                     const fileResult = await openFilePicker(fs)
    //                     console.log('File picker returned:', fileResult)

    //                     if (!fileResult) {
    //                         console.log('No file selected')
    //                         return
    //                     }

    //                     // Ensure we have proper string values
    //                     filename = String(fileResult.filename || 'unknown-file')
    //                     fileContent = String(fileResult.content || '// No content available')
    //                     console.log('Extracted filename:', typeof filename, filename)
    //                     console.log('Extracted content length:', fileContent.length)
    //                 } else {
    //                     console.log('Using filename from modal input:', modalResult)
    //                     filename = String(modalResult)

    //                     // Try to load existing file content if it exists
    //                     if (fs) {
    //                         try {
    //                             const exists = await fs.exists(filename)
    //                             if (exists) {
    //                                 fileContent = await fs.readFile(filename)
    //                                 console.log('Loaded existing file content:', fileContent.length, 'characters')
    //                             } else {
    //                                 console.log('File does not exist, creating new file:', filename)
    //                                 // For new files, start with empty content or a template
    //                                 fileContent = ''
    //                             }
    //                         } catch (error) {
    //                             console.warn('Failed to load existing file:', error)
    //                             // If there's an error, start with empty content
    //                             fileContent = ''
    //                         }
    //                     }
    //                 }
    //             } else {
    //                 console.error('Unexpected modal result type:', typeof modalResult, modalResult)
    //                 return
    //             }

    //             console.log('Final filename before insertion:', typeof filename, filename)
    //             console.log('Final content before insertion:', typeof fileContent, fileContent.substring(0, 50))

    //             // Determine language from file extension
    //             const ext = filename.split('.').pop()?.toLowerCase() || ''
    //             const language = extToLanguageMap[ext] || 'markdown'

    //             // Insert a codeblock node instead of markdown content
    //             editor
    //                 .chain()
    //                 .focus()
    //                 .insertContent({
    //                     type: 'ezcodeBlock',
    //                     attrs: {
    //                         language: language,
    //                         file: filename
    //                     },
    //                     content: fileContent ? [{ type: 'text', text: fileContent }] : [{ type: 'text', text: '' }]
    //                 })
    //                 .run()

    //             console.log('Content insertion completed')

    //             // Force focus back to editor to ensure dropdown closes
    //             setTimeout(() => {
    //                 editor.commands.focus()
    //             }, 100)
    //         } catch (error) {
    //             console.error('Error in code command:', error)
    //         }
    //     },
    // },
    {
        title: 'Settings',
        description: 'Configure editor preferences',
        icon: '⚙️',
        command: ({ editor, range }) => {
            // Remove the slash command text
            editor.chain().focus().deleteRange(range).run()

            // Open settings modal
            openSettingsModal(editor)
        },
    },
]