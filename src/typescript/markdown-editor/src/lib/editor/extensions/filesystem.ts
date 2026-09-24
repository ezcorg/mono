import { Editor, Extension } from '@tiptap/core'
import {
    extOrLanguageToLanguageId,
    ExtensionOrLanguage,
    codeblock,
    basicSetup,
    persistFile,
    onFileEvent,
    whenFileLoaded,
    type FileEvent,
} from '@joinezco/codeblock'
import { dirname, type VfsInterface } from '@joinezco/storage'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

// File extensions that open as prose (the normal Markdown editor). Everything
// else opens in a standalone code editor (a @joinezco/codeblock instance that
// swaps in for the rich-text editor), which reads the file itself, shows an
// image or a file that is not text rather than decoding it, and writes the
// file back only when it is edited, instead of it being parsed as Markdown
// (which would mangle code — `#` → headings, ``` fences, etc.).
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

/** What happened to the open file (the codeblock's lifecycle, which a code
 *  file in the code view goes through): loaded into the editor, written, or
 *  failed to open or save. */
export type { FileEvent }

export interface LoadOptions {
    /** Create the file (empty) when it does not exist. */
    create?: boolean
    /** Move focus into the loaded file (default: the `focusOnLoad` option).
     *  A caller managing focus itself (a file tree naming a new note) passes
     *  `false`. */
    focus?: boolean
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
    /**
     * Persist the current document to the current filepath *now* if (and only
     * if) a debounced save is pending, cancelling that pending save. No-ops
     * when there are no unsaved edits / autosave is off / no file is set.
     * Resolves once every write of the open file already started has landed,
     * so a caller about to move or read the file sees it current.
     */
    flushPendingSave: () => Promise<void>
    /**
     * Write the open file's unsaved edits now, whether or not autosave is on
     * (a move is about to carry the file, say): the prose document's, or the
     * code view's through its codeblock. Nothing when there are none, or for
     * an image. Resolves once the writes have landed.
     */
    save: () => Promise<void>
    /** Edits to the prose document not yet written. */
    dirty: boolean
    /**
     * Switch the active file. Persists the outgoing file's unsaved edits to
     * *its* path first, then loads `path` — without the load looking like a
     * user edit, so it can never schedule a save against the wrong file. This
     * is the safe way to change files while autosave is on; the toolbar routes
     * its "open file" through here. With `create`, a missing file is created
     * empty first (following a link to a note not written yet).
     */
    loadFile: (path: string, options?: LoadOptions) => Promise<void>
    /** Close the open file: the editor is left empty, attached to no file.
     *  Its unsaved edits are written first, or with `discard` (it is being
     *  deleted) dropped. */
    close: (options?: { discard?: boolean }) => Promise<void>
    /** Be told when a file is loaded or saved. Returns an unsubscribe. */
    subscribe: (listener: (event: FileEvent) => void) => () => void
    /** @internal Write the open file's content and announce the save. */
    write: (fs: VfsInterface, path: string, content: string) => void
    /** @internal Who is subscribed (kept from the start, since plugin views
     *  subscribe before `onCreate` runs). */
    listeners: Set<(event: FileEvent) => void>
    /** @internal Hand over the real methods once the editor is created;
     *  calls made before then are waiting for them. */
    install: (methods: Pick<FileSystemStorage, 'flushPendingSave' | 'save' | 'loadFile' | 'close'>) => void
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
        const listeners = new Set<(event: FileEvent) => void>()
        // The object returned here is not necessarily the one hooks see as
        // `this.storage`, so the early calls reach the real methods through
        // this closure rather than through the object.
        let methods!: Pick<FileSystemStorage, 'flushPendingSave' | 'save' | 'loadFile' | 'close'>
        let installed!: () => void
        const ready = new Promise<void>((resolve) => (installed = resolve))
        return {
            options: this.options,
            saveTimeout: null,
            loadingFile: false,
            codeView: null,
            codeHost: null,
            // Real implementations are installed in onCreate (they need the
            // live editor), which Tiptap runs a tick after construction; a
            // call before then waits for it rather than doing nothing.
            flushPendingSave: () => ready.then(() => methods.flushPendingSave()),
            save: () => ready.then(() => methods.save()),
            dirty: false,
            loadFile: (path, options) => ready.then(() => methods.loadFile(path, options)),
            close: (options) => ready.then(() => methods.close(options)),
            // Live from the start: plugin views (the toolbar) are built before
            // `onCreate` runs, and subscribe as they are built.
            subscribe: (listener) => {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
            write: () => {},
            listeners,
            install: (real) => {
                methods = real
                installed()
            },
        }
    },

    onCreate() {
        const editor = this.editor
        const storage = this.storage as FileSystemStorage
        // Keep storage.options pointing at the live options object so the
        // toolbar can read/update `filepath` through it.
        storage.options = this.options

        const editableEl = () => editor.view.dom as HTMLElement

        const emit = (event: FileEvent) => {
            for (const listener of storage.listeners) listener(event)
        }
        // Every write of the open file goes through here: in order (a later
        // save never lands before an earlier one), announced when it lands,
        // and awaitable as a whole by `flushPendingSave`.
        let writing: Promise<void> = Promise.resolve()
        const save = (fs: VfsInterface, path: string, content: string) =>
            (writing = writing.then(() =>
                fs.writeFile(path, content).then(
                    () => emit({ type: 'save', path }),
                    (error) => console.error(`[Filesystem] Failed to save content to ${path}:`, error),
                ),
            ))
        storage.write = (fs, path, content) => void save(fs, path, content)

        // Tear down the swapped-in code editor and restore the rich-text editor.
        const hideCodeEditor = () => {
            storage.codeView?.destroy()
            storage.codeView = null
            storage.codeHost?.remove()
            storage.codeHost = null
            const editable = editableEl()
            editable.style.display = ''
            editable.closest('.ezco-mde')?.classList.remove('ezco-mde--code-file')
        }

        // Swap the rich-text editor out for a standalone code editor. The
        // codeblock's own search toolbar is hidden (`toolbar: false`) — the
        // markdown-editor's toolbar stays in control of open/save — so the
        // document area simply appears to swap from rich text to code.
        const showCodeEditor = (content: string, language: string, fs: VfsInterface, filepath: string) => {
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
                        codeblock({
                            content,
                            fs,
                            // The codeblock owns the file: it reads it (an image or
                            // bytes that are not text are shown, not decoded), wires
                            // its language server (a `RemoteLspProvider` such as
                            // rust-analyzer over wRPC is requested per file), and
                            // writes it back only when edited, with `didSave` for
                            // on-save diagnostics. Autosave follows this editor's.
                            filepath,
                            language: language as ExtensionOrLanguage,
                            toolbar: false,
                            dark,
                            settings: { ...settings, autosave: !!storage.options.autoSave },
                        }),
                    ],
                }),
                parent: host,
            })
            storage.codeHost = host
            // The code view's lifecycle is the open file's.
            const codeView = storage.codeView
            onFileEvent(codeView, (event) => {
                if (storage.codeView === codeView) emit(event)
            })
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
        // Every load takes a ticket; only the latest may put its file in the
        // editor, so the last file asked for is the one shown, whichever
        // read ends last (the first file's, say, overtaken by an open).
        let latestLoad = 0
        const loadContent = (content: string, focus = storage.options.focusOnLoad !== false) => {
            storage.dirty = false
            storage.loadingFile = true
            try {
                const path = storage.options.filepath
                const fs = storage.options.fs
                if (path && fs && !isProseFile(path)) {
                    showCodeEditor(content, languageForPath(path), fs, path)
                } else {
                    hideCodeEditor()
                    editor.commands.setContent(content)
                }
            } finally {
                storage.loadingFile = false
            }
            // A code file is loaded when its codeblock says so.
            const loaded = storage.options.filepath
            if (loaded && !storage.codeView) emit({ type: 'load', path: loaded })
            if (didInitialLoad) {
                scrollEditorToTop(editor.view.dom as HTMLElement)
                // Move the caret to the start of the freshly-opened file (focus
                // follows from the toolbar into the document), unless opted out.
                if (focus) {
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
                    storage.dirty = false
                    void save(fs, filepath, getMarkdown(editor))
                }
            }
            // The code editor's, which it owns.
            const code = storage.codeView && autoSave ? persistFile(storage.codeView) : undefined
            return code ? Promise.all([writing, code]).then(() => {}) : writing
        }
        storage.flushPendingSave = flushPendingSave

        storage.save = () => {
            if (storage.codeView) return persistFile(storage.codeView)
            if (storage.saveTimeout !== null) {
                clearTimeout(storage.saveTimeout)
                storage.saveTimeout = null
            }
            const { fs, filepath } = storage.options
            if (fs && filepath && storage.dirty) {
                storage.dirty = false
                void save(fs, filepath, getMarkdown(editor))
            }
            return writing
        }

        storage.close = async (options = {}) => {
            latestLoad++
            const closed = storage.options.filepath
            if (options.discard) {
                if (storage.saveTimeout !== null) clearTimeout(storage.saveTimeout)
                storage.saveTimeout = null
            } else {
                await flushPendingSave()
            }
            storage.loadingFile = true
            try {
                // Destroying the code view drops its pending save with it.
                hideCodeEditor()
                storage.options.filepath = undefined
                editor.commands.setContent('')
                storage.dirty = false
            } finally {
                storage.loadingFile = false
            }
            if (closed) emit({ type: 'close', path: closed })
        }

        storage.loadFile = async (path: string, options: LoadOptions = {}) => {
            const { fs } = storage.options
            if (!fs) return
            const ticket = ++latestLoad
            // 1. Persist the outgoing file's unsaved edits to *its* path first,
            //    so they're neither lost nor written to the incoming file, and
            //    wait for them: reopening the same file must read them back.
            await flushPendingSave()
            if (options.create && !(await fs.exists(path))) {
                const parent = dirname(path)
                if (parent && !(await fs.exists(parent))) await fs.mkdir(parent, { recursive: true })
                await fs.writeFile(path, '')
            }
            // 2. Read the new file (may reject — let the caller handle it). A
            //    file that is not prose is read by the code view itself.
            const content = isProseFile(path) ? await fs.readFile(path) : ''
            if (ticket !== latestLoad) return
            // 3. Retarget autosave at the new file *before* swapping content,
            //    and load without scheduling a save.
            storage.options.filepath = path
            loadContent(content, options.focus ?? storage.options.focusOnLoad !== false)
            // Resolves once the file is in the editor, a code file included
            // (its codeblock reads it); rejects if it cannot be opened.
            if (storage.codeView) await whenFileLoaded(storage.codeView, path)
        }

        // Initial load (also a non-editing load → no spurious save).
        const { fs, filepath } = storage.options
        if (fs && filepath) {
            const ticket = ++latestLoad
            ;(isProseFile(filepath) ? fs.readFile(filepath) : Promise.resolve(''))
                .then(content => {
                    if (ticket === latestLoad) loadContent(content)
                })
                .catch(error => {
                    console.warn(`[Filesystem] Failed to load content from ${filepath}:`, error)
                })
        }
        storage.install({
            flushPendingSave: storage.flushPendingSave,
            save: storage.save,
            loadFile: storage.loadFile,
            close: storage.close,
        })
    },

    onUpdate() {
        const storage = this.storage as FileSystemStorage
        if (storage.loadingFile) return // programmatic load, not a user edit
        // A code file is shown in the swapped-in code editor, which owns its own
        // (raw) saving; the rich-text editor's autosave must not fire for it.
        if (storage.codeView) return

        const { fs, autoSave, filepath } = storage.options
        if (!fs || !filepath) return
        storage.dirty = true
        if (!autoSave) return

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
            storage.dirty = false
            storage.write(currentFs, currentPath, getMarkdown(this.editor))
        }, 500) // debounce by 500ms
    },

    onDestroy() {
        const storage = this.storage as FileSystemStorage
        if (storage.saveTimeout !== null) clearTimeout(storage.saveTimeout)
        storage.codeView?.destroy()
        storage.codeHost?.remove()
    },
})
