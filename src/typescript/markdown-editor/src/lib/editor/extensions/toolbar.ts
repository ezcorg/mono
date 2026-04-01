/**
 * Tiptap/ProseMirror adapter for the shared ToolbarCore.
 *
 * Mounts the toolbar DOM above the ProseMirror content element and
 * bridges host operations (open file, get content, etc.) to Tiptap's API.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ToolbarCore, type ToolbarHost, SearchIndex, type VfsInterface } from '@joinezco/codeblock'

export interface ToolbarOptions {
    /** Virtual filesystem — enables file search and open. */
    fs?: VfsInterface
    /** Search index for file search. */
    index?: SearchIndex
    /** Current file path displayed in the toolbar. */
    filepath?: string
}

export const Toolbar = Extension.create<ToolbarOptions>({
    name: 'toolbar',

    addOptions() {
        return {
            fs: undefined,
            index: undefined,
            filepath: undefined,
        }
    },

    addProseMirrorPlugins() {
        const extension = this

        return [
            new Plugin({
                key: new PluginKey('toolbar'),
                view: (editorView) => {
                    const { fs, index, filepath } = extension.options

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

                    // Insert toolbar before the ProseMirror content
                    editorView.dom.parentElement?.insertBefore(core.dom, editorView.dom)

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
