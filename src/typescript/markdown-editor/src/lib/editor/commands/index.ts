import { SlashCommand } from '../extensions/slash-commands'

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