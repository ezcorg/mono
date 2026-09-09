import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileChangeBus } from '@joinezco/codeblock'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'

describe('FileChangeBus', () => {
    let viewA: EditorView
    let viewB: EditorView
    let containerA: HTMLElement
    let containerB: HTMLElement

    beforeEach(() => {
        containerA = document.createElement('div')
        containerB = document.createElement('div')
        document.body.appendChild(containerA)
        document.body.appendChild(containerB)

        viewA = new EditorView({
            state: EditorState.create({ doc: 'initial' }),
            parent: containerA,
        })
        viewB = new EditorView({
            state: EditorState.create({ doc: 'initial' }),
            parent: containerB,
        })
    })

    afterEach(() => {
        viewA.destroy()
        viewB.destroy()
        containerA.remove()
        containerB.remove()
    })

    it('should notify other subscribers but not the source', () => {
        const received: { view: string; content: string }[] = []

        fileChangeBus.subscribe('test.txt', viewA, (content) => {
            received.push({ view: 'A', content })
        })
        fileChangeBus.subscribe('test.txt', viewB, (content) => {
            received.push({ view: 'B', content })
        })

        // Notify from view A — only B should receive
        fileChangeBus.notify('test.txt', 'hello from A', viewA)

        expect(received).toEqual([{ view: 'B', content: 'hello from A' }])
    })

    it('should not notify after unsubscribe', () => {
        const received: string[] = []

        const unsub = fileChangeBus.subscribe('test.txt', viewA, (content) => {
            received.push(content)
        })
        fileChangeBus.subscribe('test.txt', viewB, () => {})

        unsub()
        fileChangeBus.notify('test.txt', 'hello', viewB)

        expect(received).toEqual([])
    })

    it('should handle multiple files independently', () => {
        const received: string[] = []

        fileChangeBus.subscribe('a.txt', viewA, (content) => {
            received.push('a:' + content)
        })
        fileChangeBus.subscribe('b.txt', viewA, (content) => {
            received.push('b:' + content)
        })

        fileChangeBus.notify('a.txt', 'one', viewB)
        fileChangeBus.notify('b.txt', 'two', viewB)

        expect(received).toEqual(['a:one', 'b:two'])
    })

    it('should sync document content between views via the bus', () => {
        // Simulate two views on the same file using the bus to sync

        const unsubA = fileChangeBus.subscribe('shared.txt', viewA, (content) => {
            if (viewA.state.doc.toString() !== content) {
                viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: content } })
            }
        })
        const unsubB = fileChangeBus.subscribe('shared.txt', viewB, (content) => {
            if (viewB.state.doc.toString() !== content) {
                viewB.dispatch({ changes: { from: 0, to: viewB.state.doc.length, insert: content } })
            }
        })

        // Edit view A and "save" (notify the bus)
        viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: 'updated content' } })
        fileChangeBus.notify('shared.txt', 'updated content', viewA)

        // View B should have received the update
        expect(viewB.state.doc.toString()).toBe('updated content')
        // View A should NOT have been re-dispatched (it was the source)
        expect(viewA.state.doc.toString()).toBe('updated content')

        unsubA()
        unsubB()
    })

    it('should not create infinite loops when both views subscribe', () => {
        let dispatchCountA = 0
        let dispatchCountB = 0

        fileChangeBus.subscribe('shared.txt', viewA, (content) => {
            if (viewA.state.doc.toString() !== content) {
                dispatchCountA++
                viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: content } })
                // In the real codeblockView, this dispatch would NOT trigger save because
                // receivingExternalUpdate is true. So we do NOT re-notify.
            }
        })
        fileChangeBus.subscribe('shared.txt', viewB, (content) => {
            if (viewB.state.doc.toString() !== content) {
                dispatchCountB++
                viewB.dispatch({ changes: { from: 0, to: viewB.state.doc.length, insert: content } })
            }
        })

        // Simulate save from A
        viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: 'final' } })
        fileChangeBus.notify('shared.txt', 'final', viewA)

        // Only B should have dispatched once
        expect(dispatchCountA).toBe(0)
        expect(dispatchCountB).toBe(1)
        expect(viewA.state.doc.toString()).toBe('final')
        expect(viewB.state.doc.toString()).toBe('final')
    })
})
