/**
 * Images: `![alt](path "title")`, an inline node as in Markdown. A URL shows
 * as itself; a path is a file in the vault, read as bytes through the
 * `VfsInterface` (relative to the note, as the Markdown means it) and shown
 * through an object URL, so the same note renders from OPFS, the host disk
 * or a daemon. Obsidian's size suffix in the alt text (`![a|200](p.png)`)
 * sizes the image and is kept as written.
 *
 * Pasting or dropping an image stores it in the vault, as bytes, under the
 * attachments folder (named for the file and its content, so the same image
 * pasted twice is one file) and links it from the note by a relative path.
 */
import { Editor, Node, mergeAttributes } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { basename, dirname, encodeDestination, extname, joinPath, relativePath } from '@joinezco/storage'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import { IMAGE_EXTENSIONS, altOf, isUrl, objectUrlFor, resolveAsset, sizeOf, vaultOf } from './assets'

export interface ImageOptions {
    /** The vault folder pasted and dropped images are stored in; `false`
     *  leaves pasting images to the browser. */
    attachments: string | false
}

const EXTENSION_OF_TYPE: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
}

/** A name for a stored attachment: the file's own name (or "pasted"), made
 *  safe, and the start of its content hash, so equal bytes share a name. */
async function attachmentName(file: File, bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
    const hash = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const ext = extname(file.name) || EXTENSION_OF_TYPE[file.type] || 'bin'
    const stem = (file.name ? basename(file.name).replace(/\.[^.]*$/, '') : '')
        .normalize('NFKD')
        .replace(/[^\w.-]+/g, '-')
        .replace(/^-+|-+$/g, '')
    return `${stem || 'pasted'}-${hash}.${ext}`
}

/** Store image files in the vault and insert them at `pos`. */
async function attach(editor: Editor, files: File[], pos: number, folder: string): Promise<void> {
    const { fs, path: note } = vaultOf(editor)
    if (!fs) return
    const nodes: PMNode[] = []
    for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const target = joinPath(folder, await attachmentName(file, bytes))
        if (!(await fs.exists(target))) {
            const parent = dirname(target)
            if (parent && !(await fs.exists(parent))) await fs.mkdir(parent, { recursive: true })
            await fs.writeBytes(target, bytes)
        }
        const src = encodeDestination(relativePath(note ? dirname(note) : '', target))
        nodes.push(editor.schema.nodes.image.create({ src, alt: basename(file.name || target).replace(/\.[^.]*$/, '') }))
    }
    if (!nodes.length) return
    const tr = editor.state.tr
    let at = Math.min(pos, tr.doc.content.size)
    for (const node of nodes) {
        tr.insert(at, node)
        at += node.nodeSize
    }
    editor.view.dispatch(tr.scrollIntoView())
}

const imageFiles = (list: FileList | null | undefined): File[] =>
    [...(list ?? [])].filter((f) => f.type.startsWith('image/') || IMAGE_EXTENSIONS.has(extname(f.name)))

export const Image = Node.create<ImageOptions>({
    name: 'image',
    group: 'inline',
    inline: true,
    atom: true,
    draggable: true,

    addOptions() {
        return { attachments: 'attachments' }
    },

    addAttributes() {
        return {
            src: { default: '' },
            alt: { default: null },
            title: { default: null },
        }
    },

    parseHTML() {
        return [
            {
                tag: 'img[src]',
                getAttrs: (el) => ({
                    src: (el as HTMLElement).getAttribute('src') ?? '',
                    alt: (el as HTMLElement).getAttribute('alt'),
                    title: (el as HTMLElement).getAttribute('title'),
                }),
            },
        ]
    },

    renderHTML({ HTMLAttributes }) {
        return ['img', mergeAttributes(HTMLAttributes)]
    },

    // Its alt text is what a reader of the text would read.
    extendNodeSchema(extension) {
        return extension.name === 'image' ? { leafText: (node: PMNode) => altOf(node.attrs.alt) } : {}
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: PMNode) {
                    const src = String(node.attrs.src ?? '').replace(/[()]/g, '\\$&')
                    const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : ''
                    state.write(`![${state.esc(node.attrs.alt ?? '')}](${src}${title})`)
                },
                parse: {},
            } as MarkdownNodeSpec,
        }
    },

    addNodeView() {
        const editor = this.editor
        return ({ node }) => {
            let current = node
            const dom = document.createElement('span')
            dom.className = 'ezco-mde-image'
            dom.contentEditable = 'false'
            const img = document.createElement('img')
            img.draggable = false
            dom.append(img)
            let url: string | null = null
            let token = 0
            const release = () => {
                if (url) URL.revokeObjectURL(url)
                url = null
            }
            const render = async () => {
                const mine = ++token
                const src = String(current.attrs.src ?? '')
                const { width, height } = sizeOf(current.attrs.alt)
                img.alt = altOf(current.attrs.alt)
                img.title = current.attrs.title ?? ''
                img.style.width = width ? `${width}px` : ''
                img.style.height = height ? `${height}px` : ''
                dom.classList.remove('is-missing')
                dom.removeAttribute('data-missing')
                if (!src || isUrl(src)) {
                    release()
                    img.src = src
                    return
                }
                const { fs } = vaultOf(editor)
                const resolution = await resolveAsset(editor, src, 'markdown')
                if (mine !== token) return
                if (!fs || !resolution?.exists) {
                    release()
                    img.removeAttribute('src')
                    dom.classList.add('is-missing')
                    dom.setAttribute('data-missing', resolution?.path ?? src)
                    return
                }
                try {
                    const next = await objectUrlFor(fs, resolution.path)
                    if (mine !== token) {
                        URL.revokeObjectURL(next)
                        return
                    }
                    release()
                    url = next
                    img.src = next
                } catch {
                    dom.classList.add('is-missing')
                    dom.setAttribute('data-missing', resolution.path)
                }
            }
            void render()
            return {
                dom,
                update(next) {
                    if (next.type !== current.type) return false
                    const changed = next.attrs.src !== current.attrs.src || next.attrs.alt !== current.attrs.alt || next.attrs.title !== current.attrs.title
                    current = next
                    if (changed) void render()
                    return true
                },
                destroy() {
                    token++
                    release()
                },
            }
        }
    },

    addProseMirrorPlugins() {
        const folder = this.options.attachments
        if (folder === false) return []
        const editor = this.editor
        return [
            new Plugin({
                key: new PluginKey('imageAttachments'),
                props: {
                    handlePaste(view, event) {
                        const files = imageFiles(event.clipboardData?.files)
                        if (!files.length || !vaultOf(editor).fs) return false
                        event.preventDefault()
                        void attach(editor, files, view.state.selection.from, folder)
                        return true
                    },
                    handleDrop(view, event) {
                        const files = imageFiles((event as DragEvent).dataTransfer?.files)
                        if (!files.length || !vaultOf(editor).fs) return false
                        event.preventDefault()
                        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from
                        void attach(editor, files, at, folder)
                        return true
                    },
                },
            }),
        ]
    },
})

export { attach as attachImages }
