/**
 * Tiptap/ProseMirror adapter for the shared ToolbarCore.
 *
 * Renders the file-search / command toolbar and bridges host operations
 * (open file, get content, …) to Tiptap's API. The toolbar is a separate
 * element rendered *outside* the editor body — by default immediately
 * above the editor's root element — and where it mounts and how it looks
 * are both configurable, since that's a presentation choice consumers will
 * want to own.
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
     *    before the editor's root element (i.e. above and outside it).
     */
    mount?: ToolbarMount
    /**
     * Extra class(es) added to the toolbar root, so consumers can scope
     * their own styling without fighting the defaults.
     */
    className?: string
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
        }
    },

    addProseMirrorPlugins() {
        const extension = this

        return [
            new Plugin({
                key: new PluginKey('toolbar'),
                view: (editorView) => {
                    const { fs, index, filepath, mount, className } = extension.options

                    // If no filesystem, don't render the toolbar
                    if (!fs) return { update() {}, destroy() {} }

                    const core = new ToolbarCore({
                        fs,
                        index,
                        filepath,
                        openFile(path) {
                            fs.readFile(path).then(content => {
                                extension.editor.commands.setContent(content)
                                const persistence = (extension.editor.storage as any).persistence
                                if (persistence?.options) {
                                    persistence.options.filepath = path
                                }
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
                        // Default: above + outside the editor's root element.
                        editorRoot.parentElement.insertBefore(core.dom, editorRoot)
                    } else if (editorRoot) {
                        // Fallback (root not yet attached): above the body,
                        // still outside the editable element itself.
                        editorRoot.insertBefore(core.dom, editorView.dom)
                    } else {
                        document.body.appendChild(core.dom)
                    }

                    return {
                        update() { /* ToolbarCore is event-driven */ },
                        destroy() {
                            core.destroy()
                            core.dom.remove()
                        },
                    }
                },
            }),
        ]
    },
})
