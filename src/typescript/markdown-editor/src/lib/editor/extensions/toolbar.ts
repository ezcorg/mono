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
import { ToolbarCore, type ToolbarHost, SearchIndex, type VfsInterface } from '@joinezco/codeblock'

/** Where the toolbar DOM should be placed. */
export type ToolbarMount =
    | HTMLElement
    | ((editorRoot: HTMLElement) => HTMLElement | null | void)

export interface ToolbarOptions {
    /** Virtual filesystem — enables file search and open. */
    fs?: VfsInterface
    /** Search index for file search. */
    index?: SearchIndex
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
            index: undefined,
            filepath: undefined,
            mount: undefined,
            className: undefined,
            autoHide: false,
        }
    },

    addProseMirrorPlugins() {
        const extension = this

        return [
            new Plugin({
                key: new PluginKey('toolbar'),
                view: (editorView) => {
                    const { fs, index, filepath, mount, className, autoHide } = extension.options

                    // If no filesystem, don't render the toolbar
                    if (!fs) return { update() {}, destroy() {} }

                    const core = new ToolbarCore({
                        fs,
                        index,
                        filepath,
                        openFile(path) {
                            // Route through the persistence extension when present:
                            // it flushes the outgoing file's pending autosave, points
                            // autosave at the new path, and loads the content without
                            // it counting as an edit — all in the right order, so the
                            // new file's content can't be written to the old file's
                            // path (the autosave file-navigation race).
                            const persistence = (extension.editor.storage as any).persistence
                            if (typeof persistence?.loadFile === 'function') {
                                persistence.loadFile(path).catch((err: unknown) => {
                                    console.warn(`[Toolbar] Failed to open ${path}:`, err)
                                })
                                return
                            }
                            // No persistence extension → plain load (nothing autosaves).
                            fs.readFile(path).then(content => {
                                extension.editor.commands.setContent(content)
                            }).catch(err => {
                                console.warn(`[Toolbar] Failed to open ${path}:`, err)
                            })
                        },
                        getDocContent() {
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
                    } satisfies ToolbarHost)

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
