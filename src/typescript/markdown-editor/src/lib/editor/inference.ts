/**
 * Asking a model about prose (RFC §2.4).
 *
 * `Inference` is what a host hands the editor for a model: icanhaz's
 * `inference` capability, a provider's HTTP API, a model on the device. It
 * streams text and ends with what the answer cost. The prose actions
 * (rewrite, summarize, continue, an instruction of the user's) are requests
 * built from the selection and the note around it; the editor shows the
 * answer and applies it.
 */

export interface ChatMessage {
    role: 'user' | 'assistant'
    content: string
}

export interface CompletionRequest {
    messages: ChatMessage[]
    system?: string
    /** Which model; the provider's default when absent. */
    model?: string
    maxTokens?: number
}

export type CompletionEvent =
    | { type: 'text'; text: string }
    | { type: 'usage'; inputTokens: number; outputTokens: number }

/** A model, as a host provides it. The stream ends when the answer does,
 *  and stops early when `signal` aborts. */
export interface Inference {
    complete(request: CompletionRequest, options?: { signal?: AbortSignal }): AsyncIterable<CompletionEvent>
}

/** What a prose action is asked about. */
export interface ProseContext {
    /** The selected Markdown (empty at a caret). */
    selection: string
    /** The note's Markdown before and after the selection. */
    before: string
    after: string
    /** The whole note. */
    note: string
    path?: string | null
    /** What the user asked for, when the action takes an instruction. */
    instruction?: string
}

export interface ProseAction {
    id: string
    label: string
    /** The answer replaces the selection, or goes after it. */
    placement: 'replace' | 'after'
    /** Whether it wants a selection (a caret alone is enough otherwise). */
    selection: 'required' | 'optional'
    /** It asks the user what to do first. */
    instruction?: boolean
    request(context: ProseContext): CompletionRequest
}

const SYSTEM =
    'You help write Markdown notes. Answer with Markdown only: no preamble, no code fence around the answer, ' +
    'nothing but the text asked for. Keep the note’s own voice, language and formatting conventions.'

/** The note around a selection, trimmed to a sensible window. */
function around(context: ProseContext): string {
    const before = context.before.slice(-4000)
    const after = context.after.slice(0, 2000)
    return `${before}⟦SELECTION⟧${after}`
}

export const PROSE_ACTIONS: ProseAction[] = [
    {
        id: 'rewrite',
        label: 'Rewrite',
        placement: 'replace',
        selection: 'required',
        request: (c) => ({
            system: SYSTEM,
            messages: [
                {
                    role: 'user',
                    content: `Rewrite the selected text to read better, keeping its meaning.\n\nThe note, with the selection marked ⟦SELECTION⟧:\n${around(c)}\n\nThe selected text:\n${c.selection}`,
                },
            ],
        }),
    },
    {
        id: 'summarize',
        label: 'Summarize',
        placement: 'after',
        selection: 'optional',
        request: (c) => ({
            system: SYSTEM,
            messages: [{ role: 'user', content: `Summarize this in a few sentences:\n\n${c.selection || c.note}` }],
        }),
    },
    {
        id: 'continue',
        label: 'Continue writing',
        placement: 'after',
        selection: 'optional',
        request: (c) => ({
            system: SYSTEM,
            messages: [
                {
                    role: 'user',
                    content: `Continue the note from where ⟦SELECTION⟧ marks it, with a paragraph or two in the same voice.\n\n${around(c)}`,
                },
            ],
        }),
    },
    {
        id: 'ask',
        label: 'Ask…',
        placement: 'replace',
        selection: 'optional',
        instruction: true,
        request: (c) => ({
            system: SYSTEM,
            messages: [
                {
                    role: 'user',
                    content:
                        `${c.instruction ?? ''}\n\nThe note, with the ${c.selection ? 'selection' : 'caret'} marked ⟦SELECTION⟧:\n${around(c)}` +
                        (c.selection ? `\n\nThe selected text:\n${c.selection}` : '') +
                        `\n\nAnswer with the text that should ${c.selection ? 'replace the selection' : 'go at the caret'}.`,
                },
            ],
        }),
    },
]

/** The whole text of an answer; `onText` hears each piece as it comes. An
 *  abort stops the stream and rejects with an `AbortError`. */
export async function completeText(
    inference: Inference,
    request: CompletionRequest,
    options: { signal?: AbortSignal; onText?: (text: string) => void } = {},
): Promise<string> {
    const { signal, onText } = options
    let text = ''
    for await (const event of inference.complete(request, { signal })) {
        if (signal?.aborted) break
        if (event.type !== 'text') continue
        text += event.text
        onText?.(event.text)
        if (signal?.aborted) break
    }
    if (signal?.aborted) throw Object.assign(new Error('The answer was stopped'), { name: 'AbortError' })
    return text
}
