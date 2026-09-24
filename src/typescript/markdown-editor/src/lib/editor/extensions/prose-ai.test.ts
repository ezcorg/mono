import { describe, it, expect, afterEach } from 'vitest'
import type { CompletionRequest, Inference } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

/** A model that answers with `reply`, a few characters at a time, and
 *  remembers what it was asked and whether it was stopped. */
function scripted(reply: string, pause = 5) {
    const asked: CompletionRequest[] = []
    const stopped: boolean[] = []
    const inference: Inference = {
        async *complete(request, options) {
            asked.push(request)
            for (const piece of reply.match(/.{1,3}/gs) ?? []) {
                await new Promise((r) => setTimeout(r, pause))
                if (options?.signal?.aborted) {
                    stopped.push(true)
                    return
                }
                yield { type: 'text', text: piece }
            }
            yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
        },
    }
    return { inference, asked, stopped }
}

function make(content: string, inference?: Inference) {
    const container = createTestContainer(`ai-${created.length}`)
    const editor = createEditor({ element: container, content, inference })
    created.push({ editor, container })
    return { editor, container }
}

/** Select the first occurrence of `text`. */
function select(editor: MarkdownEditor, text: string) {
    let from = -1
    editor.state.doc.descendants((node, pos) => {
        if (from < 0 && node.isText && node.text!.includes(text)) from = pos + node.text!.indexOf(text)
    })
    editor.commands.setTextSelection({ from, to: from + text.length })
}

const panel = (c: HTMLElement) => c.querySelector('.ezco-mde-ai') as HTMLElement | null
const output = (c: HTMLElement) => panel(c)?.querySelector('.ezco-mde-ai-output')?.textContent ?? ''
const button = (c: HTMLElement, action: string) => panel(c)!.querySelector(`button[data-action="${action}"]`) as HTMLButtonElement

describe('Prose actions in the editor', () => {
    it('rewrites the selection with the answer, as one change undo takes back', async () => {
        const { inference, asked } = scripted('a much better sentence')
        const { editor, container } = make('Before. A rough sentence. After.', inference)
        select(editor, 'A rough sentence.')
        editor.commands.runProseAction('rewrite')
        await waitFor(() => output(container) === 'a much better sentence' && !button(container, 'apply').disabled, 3000)
        expect(asked[0].messages.at(-1)!.content).toContain('A rough sentence.')
        button(container, 'apply').click()
        expect(getMarkdownContent(editor)).toBe('Before. a much better sentence After.')
        expect(panel(container)?.hidden ?? true).toBe(true)
        editor.commands.undo()
        expect(getMarkdownContent(editor)).toBe('Before. A rough sentence. After.')
    })

    it('continues after the caret', async () => {
        const { inference } = scripted('And then it rained.')
        const { editor, container } = make('It was a quiet day.', inference)
        editor.commands.focus('end')
        editor.commands.runProseAction('continue')
        await waitFor(() => output(container) === 'And then it rained.' && !button(container, 'apply').disabled, 3000)
        expect(button(container, 'apply').textContent).toBe('Insert')
        button(container, 'apply').click()
        expect(getMarkdownContent(editor)).toBe('It was a quiet day.\n\nAnd then it rained.')
    })

    it('asks what to do first when the action takes an instruction', async () => {
        const { inference, asked } = scripted('Hola.')
        const { editor, container } = make('Hello.', inference)
        // A new editor takes focus a frame after it is made; act after that.
        await waitFor(() => editor.isFocused, 3000)
        select(editor, 'Hello.')
        editor.commands.runProseAction('ask')
        await waitFor(() => !!panel(container) && !panel(container)!.hidden, 3000)
        const input = panel(container)!.querySelector('input') as HTMLInputElement
        expect(document.activeElement).toBe(input)
        input.value = 'in Spanish'
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await waitFor(() => output(container) === 'Hola.' && !button(container, 'apply').disabled, 3000)
        expect(asked[0].messages.at(-1)!.content).toContain('in Spanish')
        button(container, 'apply').click()
        expect(getMarkdownContent(editor)).toBe('Hola.')
    })

    it('stops the answer when discarded, and changes nothing', async () => {
        const { inference, stopped } = scripted('x'.repeat(300), 10)
        const { editor, container } = make('Keep this.', inference)
        select(editor, 'Keep this.')
        editor.commands.runProseAction('rewrite')
        await waitFor(() => output(container).length > 0, 3000)
        button(container, 'discard').click()
        await waitFor(() => stopped.length === 1, 3000)
        expect(panel(container)?.hidden ?? true).toBe(true)
        expect(getMarkdownContent(editor)).toBe('Keep this.')
    })

    it('puts the answer where the selection went, if the note changed meanwhile', async () => {
        const { inference } = scripted('NEW', 20)
        const { editor, container } = make('One two three.', inference)
        select(editor, 'two')
        editor.commands.runProseAction('rewrite')
        editor.commands.insertContentAt(1, 'Zero ')
        await waitFor(() => output(container) === 'NEW' && !button(container, 'apply').disabled, 3000)
        button(container, 'apply').click()
        expect(getMarkdownContent(editor)).toBe('Zero One NEW three.')
    })

    it('is offered only when the host gives a model', async () => {
        const { editor: without } = make('Text.')
        expect(without.commands.runProseAction('rewrite')).toBe(false)
        const { editor, container } = make('Text.', scripted('x').inference)
        select(editor, 'Text.')
        expect(editor.commands.runProseAction('rewrite')).toBe(true)
        await waitFor(() => !!panel(container), 3000)
    })
})
