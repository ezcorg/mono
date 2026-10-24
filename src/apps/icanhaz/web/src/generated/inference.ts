// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/inference@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, leb128, readLeb128, encodeString, readString, encodeBytes, readBytes, encF32, readList, invoke, resultValue, streamingCall } from "../wrpc";

const INSTANCE = "icanhaz:nocap/inference@0.1.0";

export type CompletionRequest = { model: string; messages: Message[]; tools: Tool[]; maxTokens: number; temperature: number | undefined; system: string | undefined };
export type Message = { role: string; content: string; toolCalls: ToolCall[]; toolCallId: string | undefined };
export type ToolCall = { id: string; name: string; arguments: string };
export type Tool = { name: string; description: string; parameters: string };
export type ModelInfo = { provider: string; model: string };

function enc_122(v: Uint8Array): number[] {
    return encodeBytes(v);
}
function encCompletionRequest(v: CompletionRequest): number[] {
    return [...encodeString(v.model), ...enc_116(v.messages), ...enc_117(v.tools), ...leb128(v.maxTokens), ...enc_118(v.temperature), ...enc_84(v.system)];
}
function enc_116(v: Message[]): number[] {
    return [...leb128(v.length), ...v.flatMap((x) => encMessage(x))];
}
function encMessage(v: Message): number[] {
    return [...encodeString(v.role), ...encodeString(v.content), ...enc_114(v.toolCalls), ...enc_84(v.toolCallId)];
}
function enc_114(v: ToolCall[]): number[] {
    return [...leb128(v.length), ...v.flatMap((x) => encToolCall(x))];
}
function encToolCall(v: ToolCall): number[] {
    return [...encodeString(v.id), ...encodeString(v.name), ...encodeString(v.arguments)];
}
function enc_84(v: string | undefined): number[] {
    return v === undefined ? [0] : [1, ...encodeString(v)];
}
function enc_117(v: Tool[]): number[] {
    return [...leb128(v.length), ...v.flatMap((x) => encTool(x))];
}
function encTool(v: Tool): number[] {
    return [...encodeString(v.name), ...encodeString(v.description), ...encodeString(v.parameters)];
}
function enc_118(v: number | undefined): number[] {
    return v === undefined ? [0] : [1, ...encF32(v)];
}

function dec_124(b: Uint8Array, o0: number): [{ tag: "ok"; val: ModelInfo[] } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_123(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_123(b: Uint8Array, o0: number): [ModelInfo[], number] {
    return readList(b, o0, decModelInfo);
}
function decModelInfo(b: Uint8Array, o0: number): [ModelInfo, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = readString(b, o1);
    return [{ provider: _0, model: _1 }, o2];
}
function dec_126(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_125(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_125(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}

export async function sessionModels(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: ModelInfo[] } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "session.models", [...enc_122(self)]);
    return dec_124(resultValue(resp), 0)[0];
}

export async function open(t: WrpcTransport, grant: string): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "open", [...encodeString(grant)]);
    return dec_126(resultValue(resp), 0)[0];
}

export interface SessionCompleteSession {
    onError(cb: (err: string) => void): void;
    onData(cb: (chunk: Uint8Array | null) => void): void;
    close(): void;
}
export async function sessionComplete(t: WrpcTransport, self: Uint8Array, request: CompletionRequest): Promise<SessionCompleteSession> {
    const call = await streamingCall(t, INSTANCE, "session.complete", [...enc_122(self), ...encCompletionRequest(request)]);
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
