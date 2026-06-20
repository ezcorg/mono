import { Extension } from '@tiptap/core'
import { VfsInterface } from '@joinezco/codeblock'

export interface FileSystemOptions {
    fs?: VfsInterface
    filepath?: string
    autoSave?: boolean
}

export interface FileSystemStorage {
    options: FileSystemOptions
    /** Pending debounced-save handle (null when nothing is queued). */
    saveTimeout: ReturnType<typeof setTimeout> | null
    /** True while a programmatic load is replacing the document. */
    loadingFile: boolean
    /**
     * Persist the current document to the current filepath *now* if (and only
     * if) a debounced save is pending, cancelling that pending save. No-ops
     * when there are no unsaved edits / autosave is off / no file is set.
     */
    flushPendingSave: () => void
    /**
     * Switch the active file. Persists the outgoing file's unsaved edits to
     * *its* path first, then loads `path` — without the load looking like a
     * user edit, so it can never schedule a save against the wrong file. This
     * is the safe way to change files while autosave is on; the toolbar routes
     * its "open file" through here.
     */
    loadFile: (path: string) => Promise<void>
}

export const FileSystem = Extension.create<FileSystemOptions>({
    name: 'persistence',

    addOptions() {
        return {
            fs: undefined,
            filepath: undefined,
            autoSave: false,
        }
    },

    // All mutable per-editor state lives in storage: it's the one object Tiptap
    // guarantees is shared across every lifecycle hook *and* reachable as
    // `editor.storage.persistence`, which the toolbar uses to drive file loads.
    addStorage(): FileSystemStorage {
        return {
            options: this.options,
            saveTimeout: null,
            loadingFile: false,
            // Real implementations are installed in onCreate (they need the
            // live editor).
            flushPendingSave: () => {},
            loadFile: async () => {},
        }
    },

    onCreate() {
        const editor = this.editor
        const storage = this.storage as FileSystemStorage
        // Keep storage.options pointing at the live options object so the
        // toolbar can read/update `filepath` through it.
        storage.options = this.options

        const getMarkdown = (): string =>
            // @ts-expect-error markdown storage is provided by the Markdown extension
            editor.storage.markdown.getMarkdown()

        // Replace the document *without it counting as a user edit*, so a
        // programmatic load never schedules an autosave (a load isn't a change
        // to the file — it *is* the file). The update is still emitted so other
        // listeners (e.g. a live-preview pane) react; only this extension's own
        // onUpdate is gated, via `loadingFile`. That gating is what stops the
        // load from scheduling a save against the file being navigated away
        // from — the source of the cross-file overwrite.
        const loadContent = (content: string) => {
            storage.loadingFile = true
            try {
                editor.commands.setContent(content)
            } finally {
                storage.loadingFile = false
            }
        }

        const flushPendingSave = () => {
            // Only flush when a save is actually pending — i.e. there are
            // unsaved edits. With nothing queued there's nothing to persist, so
            // we must not write (a redundant re-serialize would needlessly
            // rewrite the file, e.g. normalising a trailing newline).
            if (storage.saveTimeout === null) return
            clearTimeout(storage.saveTimeout)
            storage.saveTimeout = null
            const { fs, filepath, autoSave } = storage.options
            if (!fs || !filepath || !autoSave) return
            fs.writeFile(filepath, getMarkdown()).catch(error => {
                console.error(`[Filesystem] Failed to save content to ${filepath}:`, error)
            })
        }
        storage.flushPendingSave = flushPendingSave

        storage.loadFile = async (path: string) => {
            const { fs } = storage.options
            if (!fs) return
            // 1. Persist the outgoing file's unsaved edits to *its* path first,
            //    so they're neither lost nor written to the incoming file.
            flushPendingSave()
            // 2. Read the new file (may reject — let the caller handle it).
            const content = await fs.readFile(path)
            // 3. Retarget autosave at the new file *before* swapping content,
            //    and load without scheduling a save.
            storage.options.filepath = path
            loadContent(content)
        }

        // Initial load (also a non-editing load → no spurious save).
        const { fs, filepath } = storage.options
        if (fs && filepath) {
            fs.readFile(filepath)
                .then(content => loadContent(content))
                .catch(error => {
                    console.warn(`[Filesystem] Failed to load content from ${filepath}:`, error)
                })
        }
    },

    onUpdate() {
        const storage = this.storage as FileSystemStorage
        if (storage.loadingFile) return // programmatic load, not a user edit

        const { fs, autoSave, filepath } = storage.options
        if (!fs || !autoSave || !filepath) return

        // Debounced auto-save.
        if (storage.saveTimeout !== null) clearTimeout(storage.saveTimeout)
        storage.saveTimeout = setTimeout(() => {
            storage.saveTimeout = null
            // Read the filepath *at fire time*, not when the save was scheduled:
            // during the 500ms debounce the active file can change (the user
            // opened another file), and the current document must always be
            // written to the file it currently represents — never the previous
            // one.
            const { fs: currentFs, filepath: currentPath } = storage.options
            if (!currentFs || !currentPath) return
            // @ts-expect-error markdown storage is provided by the Markdown extension
            const markdown = this.editor.storage.markdown.getMarkdown()
            currentFs.writeFile(currentPath, markdown).catch(error => {
                console.error(`[Filesystem] Failed to save content to ${currentPath}:`, error)
            })
        }, 500) // debounce by 500ms
    },

    onDestroy() {
        const storage = this.storage as FileSystemStorage
        if (storage.saveTimeout !== null) clearTimeout(storage.saveTimeout)
    },
})
