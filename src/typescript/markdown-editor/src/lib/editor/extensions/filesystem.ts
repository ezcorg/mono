import { Editor, Extension } from '@tiptap/core'
import {
    VfsInterface,
    extOrLanguageToLanguageId,
    ExtensionOrLanguage,
    codeblock,
    basicSetup,
} from '@joinezco/codeblock'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

// File extensions that open as prose (the normal Markdown editor). Everything
// else opens in a standalone code editor (a @joinezco/codeblock instance that
// swaps in for the rich-text editor) and round-trips its raw bytes back to
// disk, instead of being parsed as Markdown (which would mangle code — `#` →
// headings, ``` fences, etc.).
const PROSE_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'txt', 'text'])

/** True for Markdown / plain-text files (and extensionless paths). */
function isProseFile(path: string): boolean {
    const base = path.split('/').pop() ?? path
    if (!base.includes('.')) return true
    const ext = base.split('.').pop()!.toLowerCase()
    return PROSE_EXTENSIONS.has(ext)
}

/**
 * Reset the editor's scroll to the top — so a newly-opened file starts at the
 * top of the view rather than inheriting the previous file's scroll offset
 * (which can land on empty space when the new file is shorter). Scrolls the
 * editor's nearest scrollable ancestor, or the page if the editor itself isn't
 * the scroll container.
 */
function scrollEditorToTop(el: HTMLElement | null): void {
    let node = el?.parentElement ?? null
    while (node && node !== document.body) {
        const oy = getComputedStyle(node).overflowY
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
            node.scrollTo({ top: 0 })
            return
        }
        node = node.parentElement
    }
    const doc = (document.scrollingElement as HTMLElement | null) ?? document.documentElement
    doc?.scrollTo({ top: 0 })
}

/** CodeMirror language id for a (non-prose) file path. */
function languageForPath(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? ''
    return extOrLanguageToLanguageId[ext as ExtensionOrLanguage] ?? ext ?? 'plaintext'
}

/** Resolve the light/dark mode at `reference` (an explicit `data-theme` wins,
 *  otherwise the OS preference) so the swapped-in code editor matches the UI. */
function isDarkContext(reference: Element | null): boolean {
    const themed = reference?.closest?.('[data-theme]') as HTMLElement | null
    const explicit = themed?.getAttribute('data-theme')
    if (explicit === 'dark') return true
    if (explicit === 'light') return false
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : false
}

/** Current Markdown serialization of the rich-text document. */
function getMarkdown(editor: Editor): string {
    // @ts-expect-error markdown storage is provided by the Markdown extension
    return editor.storage.markdown.getMarkdown()
}

export interface FileSystemOptions {
    fs?: VfsInterface
    filepath?: string
    autoSave?: boolean
    /** When a file is opened/created (every load after the initial mount),
     *  move focus to the start of the file. Default `true`; set `false` to leave
     *  focus where it is (e.g. on the toolbar). */
    focusOnLoad?: boolean
}

export interface FileSystemStorage {
    options: FileSystemOptions
    /** Pending debounced-save handle for the rich-text editor (null when idle). */
    saveTimeout: ReturnType<typeof setTimeout> | null
    /** True while a programmatic load is replacing the document. */
    loadingFile: boolean
    /**
     * The standalone code editor swapped in for a non-prose file (null when a
     * Markdown/text file is shown in the rich-text editor). While it's non-null
     * the ProseMirror editable is hidden and this view owns the document + its
     * own (raw, fence-less) autosave.
     */
    codeView: EditorView | null
    /** Host element the code editor mounts into (a sibling of the hidden
     *  ProseMirror editable). */
    codeHost: HTMLElement | null
    /** Pending debounced-save handle for the code editor. */
    codeSaveTimeout: ReturnType<typeof setTimeout> | null
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
            codeView: null,
            codeHost: null,
            codeSaveTimeout: null,
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

        const editableEl = () => editor.view.dom as HTMLElement

        // Tear down the swapped-in code editor and restore the rich-text editor.
        const hideCodeEditor = () => {
            if (storage.codeSaveTimeout !== null) {
                clearTimeout(storage.codeSaveTimeout)
                storage.codeSaveTimeout = null
            }
            storage.codeView?.destroy()
            storage.codeView = null
            storage.codeHost?.remove()
            storage.codeHost = null
            const editable = editableEl()
            editable.style.display = ''
            editable.closest('.ezco-mde')?.classList.remove('ezco-mde--code-file')
        }

        const scheduleCodeSave = () => {
            if (storage.loadingFile) return
            const { fs, autoSave } = storage.options
            if (!fs || !autoSave) return
            if (storage.codeSaveTimeout !== null) clearTimeout(storage.codeSaveTimeout)
            storage.codeSaveTimeout = setTimeout(() => {
                storage.codeSaveTimeout = null
                const { fs: currentFs, filepath: currentPath } = storage.options
                if (!currentFs || !currentPath || !storage.codeView) return
                currentFs.writeFile(currentPath, storage.codeView.state.doc.toString()).catch(error => {
                    console.error(`[Filesystem] Failed to save content to ${currentPath}:`, error)
                })
            }, 500)
        }

        // Swap the rich-text editor out for a standalone code editor. The
        // codeblock's own search toolbar is hidden (`toolbar: false`) — the
        // markdown-editor's toolbar stays in control of open/save — so the
        // document area simply appears to swap from rich text to code.
        const showCodeEditor = (content: string, language: string, fs: VfsInterface) => {
            const editable = editableEl()
            const parent = editable.parentElement
            // Empty the now-hidden rich-text document so doc-derived chrome —
            // e.g. the outline sidebar — reflects the code file (no Markdown
            // headings) instead of the previously open file. (Gated by
            // `loadingFile`, so it schedules no save.)
            editor.commands.setContent('')
            // Rebuilt fresh on each load: a CodeMirror instance is configured
            // for one language/file and can't cleanly hot-swap them.
            storage.codeView?.destroy()
            storage.codeHost?.remove()

            const host = document.createElement('div')
            host.className = 'ezco-mde-code-host'
            // Match the surrounding editor's theme. The host lives *outside* the
            // themed editable, so copy the editor's resolved `data-theme` onto it
            // — that way both the codeblock's own theme AND consumer styles keyed
            // on `[data-theme="dark"]` (e.g. a dark code surface) apply here too.
            const themed = editable.closest('[data-theme]') as HTMLElement | null
            const themeAttr = themed?.getAttribute('data-theme')
            if (themeAttr === 'dark' || themeAttr === 'light') {
                host.setAttribute('data-theme', themeAttr)
            }
            const dark = isDarkContext(editable)
            // Match the embedded codeblocks' defaults: soft-wrap on, and the code
            // font nudged 2px below the prose size (monospace reads larger at an
            // equal px). Measured before the editable is hidden, below.
            const baseFontPx = parseFloat(getComputedStyle(editable).fontSize) || 0
            const settings = baseFontPx
                ? { lineWrap: true, fontSize: Math.max(baseFontPx - 2, 1) }
                : { lineWrap: true }
            // Flag the wrapper so the (now-redundant) block-action gutter is
            // hidden — a full-file code editor brings its own line-number gutter.
            editable.closest('.ezco-mde')?.classList.add('ezco-mde--code-file')
            if (parent) parent.insertBefore(host, editable)
            else editable.before(host)
            editable.style.display = 'none'

            storage.codeView = new EditorView({
                state: EditorState.create({
                    doc: content,
                    extensions: [
                        basicSetup,
                        // The codeblock owns no persistence of its own here; we
                        // debounce-save its raw text back to the file ourselves.
                        EditorView.updateListener.of((update) => {
                            if (update.docChanged) scheduleCodeSave()
                        }),
                        codeblock({
                            content,
                            fs,
                            language: language as ExtensionOrLanguage,
                            toolbar: false,
                            dark,
                            settings,
                        }),
                    ],
                }),
                parent: host,
            })
            storage.codeHost = host
        }

        // Replace the document *without it counting as a user edit*, so a
        // programmatic load never schedules an autosave (a load isn't a change
        // to the file — it *is* the file). The update is still emitted so other
        // listeners (e.g. a live-preview pane) react; only this extension's own
        // onUpdate is gated, via `loadingFile`. That gating is what stops the
        // load from scheduling a save against the file being navigated away
        // from — the source of the cross-file overwrite.
        //
        // Non-prose files (.ts, .json, …) swap the rich-text editor out for a
        // standalone code editor (`showCodeEditor`); prose files tear it down
        // and parse as Markdown as before.
        // The very first load is the initial mount (already at the top); every
        // load after it is a file *switch*, so reset the scroll to the top of the
        // new file rather than inheriting the previous file's scroll offset.
        let didInitialLoad = false
        const loadContent = (content: string) => {
            storage.loadingFile = true
            try {
                const path = storage.options.filepath
                const fs = storage.options.fs
                if (path && fs && !isProseFile(path)) {
                    showCodeEditor(content, languageForPath(path), fs)
                } else {
                    hideCodeEditor()
                    editor.commands.setContent(content)
                }
            } finally {
                storage.loadingFile = false
            }
            if (didInitialLoad) {
                scrollEditorToTop(editor.view.dom as HTMLElement)
                // Move the caret to the start of the freshly-opened file (focus
                // follows from the toolbar into the document), unless opted out.
                if (storage.options.focusOnLoad !== false) {
                    if (storage.codeView) storage.codeView.focus()
                    else editor.commands.focus('start', { scrollIntoView: false })
                }
            }
            didInitialLoad = true
        }

        const flushPendingSave = () => {
            // Only flush when a save is actually pending — i.e. there are
            // unsaved edits. With nothing queued there's nothing to persist, so
            // we must not write (a redundant re-serialize would needlessly
            // rewrite the file, e.g. normalising a trailing newline).
            const { fs, filepath, autoSave } = storage.options
            // Rich-text editor's pending save.
            if (storage.saveTimeout !== null) {
                clearTimeout(storage.saveTimeout)
                storage.saveTimeout = null
                if (fs && filepath && autoSave && !storage.codeView) {
                    fs.writeFile(filepath, getMarkdown(editor)).catch(error => {
                        console.error(`[Filesystem] Failed to save content to ${filepath}:`, error)
                    })
                }
            }
            // Code editor's pending save.
            if (storage.codeSaveTimeout !== null) {
                clearTimeout(storage.codeSaveTimeout)
                storage.codeSaveTimeout = null
                if (fs && filepath && autoSave && storage.codeView) {
                    fs.writeFile(filepath, storage.codeView.state.doc.toString()).catch(error => {
                        console.error(`[Filesystem] Failed to save content to ${filepath}:`, error)
                    })
                }
            }
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
        // A code file is shown in the swapped-in code editor, which owns its own
        // (raw) saving; the rich-text editor's autosave must not fire for it.
        if (storage.codeView) return

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
            if (!currentFs || !currentPath || storage.codeView) return
            currentFs.writeFile(currentPath, getMarkdown(this.editor)).catch(error => {
                console.error(`[Filesystem] Failed to save content to ${currentPath}:`, error)
            })
        }, 500) // debounce by 500ms
    },

    onDestroy() {
        const storage = this.storage as FileSystemStorage
        if (storage.saveTimeout !== null) clearTimeout(storage.saveTimeout)
        if (storage.codeSaveTimeout !== null) clearTimeout(storage.codeSaveTimeout)
        storage.codeView?.destroy()
        storage.codeHost?.remove()
    },
})
