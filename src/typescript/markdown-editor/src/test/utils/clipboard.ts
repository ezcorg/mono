import type { Editor } from '@tiptap/core'

/** The clipboard and drops, as the browser delivers them: real events with real payloads. */

export interface ClipPayload {
    text?: string
    html?: string
    files?: File[]
}

/**
 * A clipboard event of `kind` with `payload` on it, dispatched on `target`,
 * and what is on the clipboard after: for a copy or cut, what the editor put
 * there; `handled` when something claimed the event.
 */
export function clip(target: Element, kind: 'copy' | 'cut' | 'paste', payload: ClipPayload = {}) {
    const data = new DataTransfer()
    if (payload.text !== undefined) data.setData('text/plain', payload.text)
    if (payload.html !== undefined) data.setData('text/html', payload.html)
    for (const file of payload.files ?? []) data.items.add(file)
    const event = new ClipboardEvent(kind, { clipboardData: data, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return { handled: event.defaultPrevented, text: data.getData('text/plain'), html: data.getData('text/html') }
}

/**
 * A drop on the note at the position `at`, as the browser delivers one:
 * a `DragEvent` with the files (or text) on its `dataTransfer` and the
 * pointer's coordinates, those of the position.
 */
export function drop(editor: Editor, payload: { files?: File[]; text?: string }, at: number): DragEvent {
    const data = new DataTransfer()
    for (const file of payload.files ?? []) data.items.add(file)
    if (payload.text !== undefined) data.setData('text/plain', payload.text)
    const { left, top, bottom } = editor.view.coordsAtPos(at)
    const event = new DragEvent('drop', { dataTransfer: data, clientX: left, clientY: (top + bottom) / 2, bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(event)
    return event
}
