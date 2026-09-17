// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/process@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, leb128, readLeb128, encodeString, readString, encodeBytes, readBytes, invoke, resultValue, streamingCall } from "../wrpc";

const INSTANCE = "icanhaz:nocap/process@0.1.0";



function enc_171(v: Uint8Array): number[] {
    return encodeBytes(v);
}
function enc_86(v: string[]): number[] {
    return [...leb128(v.length), ...v.flatMap((x) => encodeString(x))];
}

function dec_173(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_172(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_172(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}

export async function open(t: WrpcTransport, grant: string): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "open", [...encodeString(grant)]);
    return dec_173(resultValue(resp), 0)[0];
}

export interface ProcessSpawnSession {
    stdin(bytes: Uint8Array): void;
    closeStdin(): void;
    onError(cb: (err: string) => void): void;
    onData(cb: (chunk: Uint8Array | null) => void): void;
    close(): void;
}
export async function processSpawn(t: WrpcTransport, self: Uint8Array, args: string[]): Promise<ProcessSpawnSession> {
    const call = await streamingCall(t, INSTANCE, "process.spawn", [...enc_171(self), ...enc_86(args), 0]);
    let errCb: ((e: string) => void) | undefined;
    call.onResult((v) => { if (v[0] === 1) { const [e] = readString(v, 1); errCb?.(e); } });
    let dataCb: ((c: Uint8Array | null) => void) | undefined;
    call.onStream(0, (c) => dataCb?.(c));
    return {
        stdin(bytes) { call.send(2, bytes); },
        closeStdin() { call.closeStream(2); },
        onError(cb) { errCb = cb; },
        onData(cb) { dataCb = cb; },
        close() { call.close(); },
    };
}
