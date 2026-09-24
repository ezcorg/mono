/**
 * Tiptap/ProseMirror adapter for the shared ToolbarCore.
 *
 * Renders the file-search / command toolbar and bridges host operations
 * (open file, get content, …) to Tiptap's API. The toolbar is a separate
 * element rendered *outside* the editor body. By default it's a floating pill
 * that sits at the top of the editor's scroll area and auto-hides on scroll
 * down (revealing on scroll up, on hover near the top, and initially) —
 * mirroring the codeblock's auto-hide toolbar. Where it mounts, how it looks,
 * and whether it auto-hides are all configurable.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ToolbarCore, type ToolbarHost, type HostCommand } from '@joinezco/codeblock'
import type { FileOperations, FileSearch, VfsInterface } from '@joinezco/storage'
import type { SlashCommand } from './slash-commands'
import { revealFragment } from './fragment'

/** Where the toolbar DOM should be placed. */
export type ToolbarMount =
    | HTMLElement
    | ((editorRoot: HTMLElement) => HTMLElement | null | void)

export interface ToolbarOptions {
    /** Virtual filesystem — enables browsing, opening and creating files. */
    fs?: VfsInterface
    /** Finds files by name and notes by their text (a vault's search). The
     *  editor's setup supplies one; without it the toolbar only browses. */
    search?: FileSearch
    /** Creates, moves and deletes files; a vault's keep links working. */
    files?: FileOperations
    /** Editor commands offered in the toolbar, which is also the command
     *  palette (⌘P; ⇧⌘P for commands alone, like `>` typed first). */
    commands?: SlashCommand[]
    /** Current file path displayed in the toolbar. */
    filepath?: string
    /**
     * Where to render the toolbar. It always lives *outside* the editor
     * body; this only controls which element it lands in:
     *  - `HTMLElement` → the toolbar is appended into it.
     *  - function → called with the editor's root element; return a
     *    container to append into, or mount the node yourself and return
     *    nothing.
     *  - `undefined` (default) → inserted as the sibling immediately
     *    before the editor's root element (i.e. above and outside it). For
     *    the auto-hide behaviour to work it should land inside the editor's
     *    scroll container, which the default placement does.
     */
    mount?: ToolbarMount
    /**
     * Extra class(es) added to the toolbar root, so consumers can scope
     * their own styling without fighting the defaults.
     */
    className?: string
    /**
     * Auto-hide the toolbar when the editor scrolls down, revealing it on
     * scroll up / hover near the top / initially. Defaults to `false` (the
     * toolbar stays put as a static search field); set `true` to opt into the
     * auto-hiding pill behavior.
     */
    autoHide?: boolean
}

/** The editor commands matching `query`: all of them after a `>`, else
 *  those whose title or description contains the query. */
function matchCommands(commands: SlashCommand[], query: string, run: (command: SlashCommand) => void): HostCommand[] {
    const explicit = query.startsWith('>')
    const q = (explicit ? query.slice(1) : query).trim().toLowerCase()
    if (!explicit && q.length < 2) return []
    return commands
        .filter((c) => !q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
        .map((c) => ({ id: explicit ? `> ${c.title}` : c.title, keywords: [c.description], run: () => run(c) }))
}

const RETRACTED_CLASS = 'ezco-mde-toolbar-retracted'

/** Nearest scrollable ancestor of `el` (falls back to the document scroller). */
function findScrollContainer(el: HTMLElement | null): HTMLElement {
    let node = el?.parentElement ?? null
    while (node && node !== document.body) {
        // Match on overflow alone (not current scrollability) — this runs at
        // editor-setup time, before content has made the container scrollable.
        const oy = getComputedStyle(node).overflowY
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
            return node
        }
        node = node.parentElement
    }
    return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

/**
 * Wire up the scroll/hover auto-hide for `panel` against the editor's scroll
 * container. Returns a cleanup function.
 */
function setupAutoHide(panel: HTMLElement, editorRoot: HTMLElement | null, editableDom: HTMLElement): () => void {
    const scroller = findScrollContainer(editorRoot ?? editableDom)
    const REVEAL_ZONE = 56 // px from the top of the scroller that reveals it

    let lastTop = scroller === document.documentElement || scroller === document.scrollingElement
        ? window.scrollY
        : scroller.scrollTop
    const scrollTopOf = () =>
        scroller === document.documentElement || scroller === document.scrollingElement
            ? window.scrollY
            : scroller.scrollTop

    // Keep visible while the toolbar is being used (focused / showing results).
    const isActive = () => {
        if (panel.contains(document.activeElement)) return true
        const results = panel.querySelector('.cm-search-results')
        return !!results && results.childElementCount > 0
    }
    const retract = () => { if (!isActive()) panel.classList.add(RETRACTED_CLASS) }
    const expand = () => panel.classList.remove(RETRACTED_CLASS)

    // Stay expanded until the initial content load settles, so async layout
    // churn (codeblocks mounting, file load) doesn't spuriously hide it.
    let armed = false
    const armTimer = window.setTimeout(() => { armed = true; lastTop = scrollTopOf() }, 700)

    const onScroll = () => {
        const top = scrollTopOf()
        if (top <= 8) { expand(); lastTop = top; return } // at the top → always show
        if (!armed) { lastTop = top; return }
        const delta = top - lastTop
        lastTop = top
        if (delta > 3) retract()
        else if (delta < -3) expand()
    }
    const onMove = (e: MouseEvent) => {
        const rect = scroller.getBoundingClientRect()
        if (e.clientY >= rect.top && e.clientY < rect.top + REVEAL_ZONE) expand()
    }
    const onBlur = () => window.setTimeout(() => { if (scrollTopOf() > 6) retract() }, 120)

    const scrollTarget: EventTarget =
        scroller === document.documentElement || scroller === document.scrollingElement ? window : scroller
    scrollTarget.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('mousemove', onMove)
    const input = panel.querySelector('.cm-toolbar-input')
    input?.addEventListener('blur', onBlur)

    return () => {
        window.clearTimeout(armTimer)
        scrollTarget.removeEventListener('scroll', onScroll)
        scroller.removeEventListener('mousemove', onMove)
        input?.removeEventListener('blur', onBlur)
        panel.classList.remove(RETRACTED_CLASS)
    }
}

/** Make the query input grow/shrink with its content (a floating field). */
function setupInputGrow(panel: HTMLElement): () => void {
    const input = panel.querySelector<HTMLInputElement>('.cm-toolbar-input')
    if (!input) return () => {}
    const MIN = 12
    const MAX = 48
    const grow = () => {
        const len = input.value.length || (input.placeholder?.length ?? 0)
        input.size = Math.max(MIN, Math.min(MAX, len + 1))
    }
    grow()
    input.addEventListener('input', grow)
    return () => input.removeEventListener('input', grow)
}

export const Toolbar = Extension.create<ToolbarOptions>({
    name: 'toolbar',

    addOptions() {
        return {
            fs: undefined,
            search: undefined,
            files: undefined,
            commands: undefined,
            filepath: undefined,
            mount: undefined,
            className: undefined,
            autoHide: false,
        }
    },

    addKeyboardShortcuts() {
        // The toolbar is the command palette: ⌘P finds files, notes and
        // commands; ⇧⌘P starts at the commands.
        const open = (prefix: string) => {
            const input = toolbarInputs.get(this.editor)
            if (!input) return false
            input.focus()
            input.value = prefix
            input.dispatchEvent(new Event('input', { bubbles: true }))
            if (!prefix) input.dispatchEvent(new MouseEvent('click', { bubbles: false }))
            return true
        }
        return {
            'Mod-p': () => open(''),
            'Mod-Shift-p': () => open('>'),
        }
    },

    addProseMirrorPlugins() {
        const extension = this

        return [
            new Plugin({
                key: new PluginKey('toolbar'),
                view: (editorView) => {
                    const { fs, search, files, commands, filepath, mount, className, autoHide } = extension.options

                    // If no filesystem, don't render the toolbar
                    if (!fs) return { update() {}, destroy() {} }

                    const editor = extension.editor
                    const host = {
                        fs,
                        search,
                        files,
                        filepath,
                        openFile(path, options) {
                            // A content hit: reveal the text the search matched.
                            const reveal = () => {
                                if (options?.find) revealFragment(editor, `:~:text=${encodeURIComponent(options.find)}`)
                            }
                            // Route through the persistence extension when present:
                            // it flushes the outgoing file's pending autosave, points
                            // autosave at the new path, and loads the content without
                            // it counting as an edit — all in the right order, so the
                            // new file's content can't be written to the old file's
                            // path (the autosave file-navigation race).
                            const persistence = (extension.editor.storage as any).persistence
                            if (typeof persistence?.loadFile === 'function') {
                                persistence.loadFile(path).then(reveal, (err: unknown) => {
                                    console.warn(`[Toolbar] Failed to open ${path}:`, err)
                                })
                                return
                            }
                            // No persistence extension → plain load (nothing autosaves).
                            fs.readFile(path).then(content => {
                                extension.editor.commands.setContent(content)
                                reveal()
                            }).catch(err => {
                                console.warn(`[Toolbar] Failed to open ${path}:`, err)
                            })
                        },
                        commands: commands?.length
                            ? (query: string) =>
                                matchCommands(commands, query, (command) => {
                                    const at = editor.state.selection.from
                                    command.command({ editor, range: { from: at, to: at } })
                                })
                            : undefined,
                        async persist() {
                            // The open file's unsaved edits land on its path before
                            // it moves (with autosave off, the move is what saves
                            // them), so the move carries them and a rewrite of its
                            // links reads them. The persistence layer knows which
                            // view holds the file (a code file's is not the prose
                            // document) and writes nothing for an image.
                            await (extension.editor.storage as any).persistence?.save?.()
                        },
                        async closeFile() {
                            await (extension.editor.storage as any).persistence?.close?.({ discard: true })
                        },
                        getDocContent() {
                            // A code file's text is in the code view, not the
                            // (emptied) prose document.
                            const codeView = (extension.editor.storage as any).persistence?.codeView
                            if (codeView) return codeView.state.doc.toString()
                            try {
                                return (extension.editor.storage as any).markdown.getMarkdown()
                            } catch {
                                return extension.editor.getText()
                            }
                        },
                        focusEditor() {
                            editorView.focus()
                        },
                        getCurrentFilePath() {
                            // The live current file is the persistence layer's
                            // filepath (updated on every open/create/rename).
                            // Without this the toolbar falls back to its *initial*
                            // filepath, so after creating/opening a file the
                            // displayed path reverts to the original on the next
                            // input reset (e.g. clicking into the editor to type).
                            const persistence = (extension.editor.storage as any).persistence
                            return persistence?.options?.filepath ?? extension.options.filepath ?? null
                        },
                    } satisfies ToolbarHost
                    const core = new ToolbarCore(host)
                    toolbarInputs.set(editor, core.input)
                    // Show the open file however it was opened (a link, the file
                    // tree, the backlinks), not only from the toolbar itself.
                    const persistence = (editor.storage as any).persistence
                    const unsubscribe: () => void = persistence?.subscribe?.((event: { type: string; path: string }) => {
                        if (event.type === 'load' && document.activeElement !== core.input) core.setFilePath(event.path)
                    }) ?? (() => {})

                    // Tag the toolbar so the rich-text editor's default styles
                    // apply, plus any consumer-provided class for theming.
                    // The codeblock package's own toolbar lacks this class, so
                    // it's untouched.
                    core.dom.classList.add('ezco-mde-toolbar')
                    if (className) {
                        for (const cls of className.split(/\s+/).filter(Boolean)) {
                            core.dom.classList.add(cls)
                        }
                    }

                    // Tab/keyboard focus into the search field opens the results
                    // dropdown. A pointer click already opens it (the toolbar's own
                    // click handler), so we only act on non-pointer focus — a
                    // `mousedown` flag distinguishes the two — and dispatch a click
                    // to reuse that same open path.
                    const toolbarInput = core.dom.querySelector('.cm-toolbar-input') as HTMLInputElement | null
                    if (toolbarInput) {
                        // A pointer press immediately before focus means a click is
                        // already opening the dropdown (the toolbar's own handler),
                        // so skip those. The flag clears on the next tick so a stray
                        // mousedown (no following focus) can't wedge it on and
                        // suppress a later genuine keyboard focus.
                        let pointerFocus = false
                        toolbarInput.addEventListener('mousedown', () => {
                            pointerFocus = true
                            setTimeout(() => { pointerFocus = false }, 0)
                        })
                        toolbarInput.addEventListener('focus', () => {
                            if (pointerFocus) return
                            const results = core.dom.querySelector('.cm-search-results')
                            if (!results || results.children.length === 0) {
                                // Non-bubbling: the input's own click handler opens
                                // the dropdown, but if this synthetic click reached
                                // `document` the toolbar's freshly-added click-
                                // outside listener would catch it and close again.
                                toolbarInput.dispatchEvent(new MouseEvent('click', { bubbles: false }))
                            }
                        })
                    }

                    // The editor's root element (the node passed as
                    // `options.element`, into which ProseMirror is mounted).
                    const editorRoot = editorView.dom.parentElement as HTMLElement | null

                    if (mount instanceof HTMLElement) {
                        mount.appendChild(core.dom)
                    } else if (typeof mount === 'function' && editorRoot) {
                        const container = mount(editorRoot)
                        // A returned element is a container to append into; a
                        // void return means the callback mounted it itself.
                        if (container instanceof HTMLElement) container.appendChild(core.dom)
                    } else if (editorRoot?.parentElement) {
                        // Default: above + outside the editor's root element
                        // (and inside the scroll container, so it can stick +
                        // auto-hide).
                        editorRoot.parentElement.insertBefore(core.dom, editorRoot)
                    } else if (editorRoot) {
                        // Fallback (root not yet attached): above the body,
                        // still outside the editable element itself.
                        editorRoot.insertBefore(core.dom, editorView.dom)
                    } else {
                        document.body.appendChild(core.dom)
                    }

                    const cleanups: Array<() => void> = []
                    cleanups.push(setupInputGrow(core.dom))
                    if (autoHide !== false) {
                        cleanups.push(setupAutoHide(core.dom, editorRoot, editorView.dom as HTMLElement))
                    }

                    return {
                        update() { /* ToolbarCore is event-driven */ },
                        destroy() {
                            unsubscribe()
                            toolbarInputs.delete(editor)
                            cleanups.forEach((c) => c())
                            core.destroy()
                            core.dom.remove()
                        },
                    }
                },
            }),
        ]
    },
})

/** Each editor's toolbar input, for the palette shortcuts. */
const toolbarInputs = new WeakMap<object, HTMLInputElement>()
