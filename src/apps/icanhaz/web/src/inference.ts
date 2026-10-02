//! A model for the editor: the daemon's `inference` capability as the
//! editor's `Inference` (`@joinezco/markdown-editor`'s interface). The editor asks;
//! nothing it does knows it is icanhaz behind the answer.
//!
//! The grant is asked for the first time a model is wanted (the consent card
//! appears then, not when the page opens), the session is opened once, and
//! each completion streams `[kind u8][len u32 BE][payload]` frames: text
//! deltas (0), then a usage record (1). An abort closes the call.

import type { CompletionEvent, CompletionRequest, Inference } from "@joinezco/markdown-editor";
import type { Transport } from "./wrpc";
import { requestScoped } from "./generated/broker";
import { open, sessionComplete, sessionModels } from "./generated/inference";

/** Ask for an `inference` grant over any model the providers have. */
export async function requestInferenceGrant(transport: Transport, reason: string): Promise<string> {
    const res = await requestScoped(transport, { tag: "inference", val: { models: [] } }, { when: "true", allow: "true" }, reason, undefined);
    if (res.tag !== "ok") throw new Error(`no model: ${JSON.stringify(res.val)}`);
    return res.val.token;
}

export interface EditorInferenceOptions {
    /** The model to ask; the grant's first otherwise. */
    model?: string;
}

/** The capability as the editor's `Inference`. `grant` is called once, the
 *  first time the editor asks. */
export function editorInference(transport: Transport, grant: () => Promise<string>, options: EditorInferenceOptions = {}): Inference {
    let session: Promise<{ handle: Uint8Array; model: string }> | null = null;
    const opened = () =>
        (session ??= (async () => {
            const s = await open(transport, await grant());
            if (s.tag !== "ok") throw new Error(`inference refused: ${s.val}`);
            let model = options.model;
            if (!model) {
                const listed = await sessionModels(transport, s.val);
                if (listed.tag !== "ok" || !listed.val.length) throw new Error("the grant covers no model");
                model = listed.val[0]!.model;
            }
            return { handle: s.val, model };
        })().catch((error) => {
            // A refusal is not remembered: the next ask asks again.
            session = null;
            throw error;
        }));

    return {
        async *complete(request: CompletionRequest, { signal } = {}): AsyncGenerator<CompletionEvent> {
            const { handle, model } = await opened();
            if (signal?.aborted) return;
            const call = await sessionComplete(transport, handle, {
                model: request.model ?? model,
                messages: request.messages.map((m) => ({ role: m.role, content: m.content, toolCalls: [], toolCallId: undefined })),
                tools: [],
                maxTokens: request.maxTokens ?? 0,
                temperature: undefined,
                system: request.system,
            });
            const queue: CompletionEvent[] = [];
            let pending = new Uint8Array(0);
            let done = false;
            let failure: Error | null = null;
            let wake: (() => void) | null = null;
            const push = (event: CompletionEvent) => {
                queue.push(event);
                wake?.();
            };
            call.onError((error) => {
                failure = new Error(error);
                done = true;
                wake?.();
            });
            call.onData((chunk) => {
                if (chunk === null) {
                    done = true;
                    wake?.();
                    return;
                }
                // Frames may span chunks: keep what does not yet complete one.
                const bytes = new Uint8Array(pending.length + chunk.length);
                bytes.set(pending);
                bytes.set(chunk, pending.length);
                let at = 0;
                const view = new DataView(bytes.buffer);
                while (at + 5 <= bytes.length) {
                    const length = view.getUint32(at + 1);
                    if (at + 5 + length > bytes.length) break;
                    const kind = bytes[at];
                    const payload = new TextDecoder().decode(bytes.subarray(at + 5, at + 5 + length));
                    if (kind === 0) push({ type: "text", text: payload });
                    else if (kind === 1) {
                        const usage = JSON.parse(payload) as { input_tokens?: number; output_tokens?: number };
                        push({ type: "usage", inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 });
                    }
                    at += 5 + length;
                }
                pending = bytes.slice(at);
            });
            const onAbort = () => {
                done = true;
                call.close();
                wake?.();
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            try {
                for (;;) {
                    if (queue.length) {
                        yield queue.shift()!;
                        continue;
                    }
                    if (done) break;
                    await new Promise<void>((resolve) => (wake = resolve));
                    wake = null;
                }
                if (failure && !signal?.aborted) throw failure;
            } finally {
                signal?.removeEventListener("abort", onAbort);
                if (!done) call.close();
            }
        },
    };
}
