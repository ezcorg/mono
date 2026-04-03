/**
 * CodeMirror AI extension — integrates @marimo-team/codemirror-ai with the
 * codeblock editor. Uses the `agentUrl` setting to send requests to a dev
 * proxy server (proxy-server.ts) that shells out to the `claude` CLI.
 */
import { type Extension, Compartment } from '@codemirror/state';
import { aiExtension } from '@marimo-team/codemirror-ai';
import type { EditorView } from '@codemirror/view';

export const aiCompartment = new Compartment();

export interface AiConfig {
    agentUrl: string;
    model: string;
}

function buildAiExtension(agentUrl: string, model: string): Extension {
    if (!agentUrl) return [];
    return aiExtension({
        prompt: async ({ prompt, selection, codeBefore, codeAfter, signal }) => {
            const url = agentUrl.replace(/\/+$/, '') + '/api/ai/edit';
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, selection, codeBefore, codeAfter, model }),
                signal,
            });
            if (!res.ok) {
                const text = await res.text().catch(() => res.statusText);
                throw new Error(`AI proxy error (${res.status}): ${text}`);
            }
            return res.text();
        },
        onError: (error) => {
            console.error('[codeblock-ai]', error);
        },
    });
}

/** Create the initial AI compartment extension. */
export function createAiExtension(config: AiConfig): Extension {
    return aiCompartment.of(buildAiExtension(config.agentUrl, config.model));
}

/** Reconfigure the AI extension when agentUrl or model changes. */
export function reconfigureAi(view: EditorView, agentUrl: string, model: string) {
    view.dispatch({
        effects: aiCompartment.reconfigure(buildAiExtension(agentUrl, model)),
    });
}
