/**
 * The review entry for a conflict (RFC §3): when a save is refused because
 * the file changed elsewhere, the edits are kept in a conflict copy beside
 * it and the editor shows the file as it now is. This says so above the
 * document, with the way to the copy, until it is dismissed or another file
 * is opened.
 */
import { Extension } from '@tiptap/core'
import type { FileEvent, FileSystemStorage } from './filesystem'

const cleanups = new WeakMap<object, () => void>()

export const ConflictNotice = Extension.create({
    name: 'conflictNotice',

    onCreate() {
        const editor = this.editor
        const persistence = (editor.storage as any).persistence as FileSystemStorage | undefined
        if (!persistence || typeof document === 'undefined') return

        const dom = document.createElement('div')
        dom.className = 'ezco-mde-conflict'
        dom.setAttribute('role', 'status')
        dom.hidden = true
        const message = document.createElement('span')
        message.className = 'ezco-mde-conflict-message'
        const open = document.createElement('button')
        open.type = 'button'
        open.dataset.action = 'open'
        open.className = 'ezco-mde-conflict-button is-link'
        open.textContent = 'Open your version'
        const dismiss = document.createElement('button')
        dismiss.type = 'button'
        dismiss.dataset.action = 'dismiss'
        dismiss.className = 'ezco-mde-conflict-button is-quiet'
        dismiss.textContent = 'Dismiss'
        dom.append(message, open, dismiss)
        ;(editor.view.dom as HTMLElement).before(dom)

        let about: { path: string; copy: string } | null = null
        const hide = () => {
            about = null
            dom.hidden = true
        }
        open.addEventListener('click', () => {
            const copy = about?.copy
            hide()
            if (copy) void persistence.loadFile(copy)
        })
        dismiss.addEventListener('click', hide)

        const off = persistence.subscribe((event: FileEvent) => {
            if (event.type === 'conflict') {
                about = { path: event.path, copy: event.copy }
                message.textContent = `${event.path} changed elsewhere while you were editing it. Your version is kept as ${event.copy}.`
                dom.hidden = false
            } else if ((event.type === 'load' || event.type === 'close') && about && event.path !== about.path) {
                hide()
            }
        })
        cleanups.set(editor, () => {
            off()
            dom.remove()
        })
    },

    onDestroy() {
        cleanups.get(this.editor)?.()
        cleanups.delete(this.editor)
    },
})
