import { describe, expect, it } from 'vitest'
import { completeText, PROSE_ACTIONS, type CompletionRequest, type Inference } from './inference'

const proseAction = (id: string) => PROSE_ACTIONS.find((action) => action.id === id)

/** A model that answers with `reply` in pieces, and remembers what it was asked. */
function scripted(reply: string) {
    const asked: CompletionRequest[] = []
    const inference: Inference = {
        async *complete(request) {
            asked.push(request)
            for (const piece of reply.match(/.{1,4}/gs) ?? []) yield { type: 'text', text: piece }
            yield { type: 'usage', inputTokens: 3, outputTokens: 2 }
        },
    }
    return { inference, asked }
}

describe('Prose actions', () => {
    it('ask a model about the selection, with the note around it for context', () => {
        const rewrite = proseAction('rewrite')!
        const request = rewrite.request({ selection: 'rough draft', before: 'Intro. ', after: ' Outro.', note: 'Intro. rough draft Outro.' })
        expect(request.system).toMatch(/Markdown/)
        const asked = request.messages.at(-1)!.content
        expect(asked).toContain('rough draft')
        expect(asked).toContain('Intro.')
        expect(rewrite.placement).toBe('replace')
    })

    it('continue from the caret, and take an instruction when asked', () => {
        const next = proseAction('continue')!.request({ selection: '', before: 'Once upon', after: '', note: 'Once upon' })
        expect(next.messages.at(-1)!.content).toContain('Once upon')
        const ask = proseAction('ask')!
        expect(ask.instruction).toBe(true)
        expect(ask.request({ selection: 'x', before: '', after: '', note: 'x', instruction: 'make it rhyme' }).messages.at(-1)!.content).toContain('make it rhyme')
        expect(PROSE_ACTIONS.map((a) => a.id)).toEqual(['rewrite', 'summarize', 'continue', 'ask'])
    })

    it('collect a streamed answer, and stop when told', async () => {
        const { inference } = scripted('A better sentence.')
        expect(await completeText(inference, { messages: [{ role: 'user', content: 'x' }] })).toBe('A better sentence.')
        const controller = new AbortController()
        const pieces: string[] = []
        await expect(
            completeText(inference, { messages: [{ role: 'user', content: 'x' }] }, {
                signal: controller.signal,
                onText: (text) => {
                    pieces.push(text)
                    if (pieces.length === 2) controller.abort()
                },
            }),
        ).rejects.toMatchObject({ name: 'AbortError' })
        expect(pieces).toHaveLength(2)
    })
})
