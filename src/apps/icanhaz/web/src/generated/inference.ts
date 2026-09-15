// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/inference@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, leb128, readLeb128, encodeString, readString, encF32, readList, invoke, resultValue, streamingCall } from "../wrpc";

const INSTANCE = "icanhaz:nocap/inference@0.1.0";

export type CompletionRequest = { model: string; messages: Message[]; maxTokens: number; temperature: number | undefined; system: string | undefined };
export type Message = { role: string; content: string };
export type ModelInfo = { provider: string; model: string };

function encCompletionRequest(v: CompletionRequest): number[] {
    return [...encodeString(v.model), ...enc_38(v.messages), ...leb128(v.maxTokens), ...enc_39(v.temperature), ...enc_40(v.system)];
}
function enc_38(v: Message[]): number[] {
    return [...leb128(v.length), ...v.flatMap((x) => encMessage(x))];
}
function encMessage(v: Message): number[] {
    return [...encodeString(v.role), ...encodeString(v.content)];
}
function enc_39(v: number | undefined): number[] {
    return v === undefined ? [0] : [1, ...encF32(v)];
}
function enc_40(v: string | undefined): number[] {
    return v === undefined ? [0] : [1, ...encodeString(v)];
}

function dec_46(b: Uint8Array, o0: number): [{ tag: "ok"; val: ModelInfo[] } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_45(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_45(b: Uint8Array, o0: number): [ModelInfo[], number] {
    return readList(b, o0, decModelInfo);
}
function decModelInfo(b: Uint8Array, o0: number): [ModelInfo, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = readString(b, o1);
    return [{ provider: _0, model: _1 }, o2];
}

export async function models(t: WrpcTransport, grant: string): Promise<{ tag: "ok"; val: ModelInfo[] } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "models", [...encodeString(grant)]);
    return dec_46(resultValue(resp), 0)[0];
}

export interface CompleteSession {
    onError(cb: (err: string) => void): void;
    onData(cb: (chunk: Uint8Array | null) => void): void;
    close(): void;
}
export async function complete(t: WrpcTransport, grant: string, request: CompletionRequest): Promise<CompleteSession> {
    const call = await streamingCall(t, INSTANCE, "complete", [...encodeString(grant), ...encCompletionRequest(request)]);
    let errCb: ((e: string) => void) | undefined;
    call.onResult((v) => { if (v[0] === 1) { const [e] = readString(v, 1); errCb?.(e); } });
    let dataCb: ((c: Uint8Array | null) => void) | undefined;
    call.onStream(0, (c) => dataCb?.(c));
    return {
        onError(cb) { errCb = cb; },
        onData(cb) { dataCb = cb; },
        close() { call.close(); },
    };
}
