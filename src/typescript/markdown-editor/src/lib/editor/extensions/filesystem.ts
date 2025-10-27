import { Extension } from '@tiptap/core'
import { VfsInterface } from '@joinezco/codeblock'

export interface FileSystemOptions {
    fs?: VfsInterface
    filepath?: string
    autoSave?: boolean
}

export const FileSystem = Extension.create<FileSystemOptions>({
    name: 'persistence',
    // @ts-expect-error
    _saveTimeout: null,

    addOptions() {
        return {
            fs: undefined,
            filepath: undefined,
            autoSave: false,
        }
    },

    addStorage() {
        return {
            options: this.options,
        }
    },

    onCreate() {
        const { fs, filepath } = this.options

        // Store options in editor storage for access by other components
        this.storage.options = this.options

        if (fs && filepath) {
            fs.readFile(filepath)
                .then(content => {
                    this.editor.commands.setContent(content)
                })
                .catch(error => {
                    console.warn(`[Filesystem] Failed to load content from ${filepath}:`, error)
                })
        }
    },

    onUpdate() {
        const { fs, filepath, autoSave } = this.options

        if (!fs || !filepath || !autoSave) return

        // Debounced auto-save mechanism
        // @ts-expect-error
        if (this._saveTimeout) clearTimeout(this._saveTimeout)
        // @ts-expect-error
        this._saveTimeout = setTimeout(() => {
            // @ts-expect-error
            const markdown = this.editor.storage.markdown.getMarkdown()
            fs.writeFile(filepath, markdown).catch(error => {
                console.error(`[Filesystem] Failed to save content to ${filepath}:`, error)
            })
        }, 500) // debounce by 500ms
    },

    onDestroy() {
        // @ts-expect-error
        if (this._saveTimeout) clearTimeout(this._saveTimeout)
    },
})