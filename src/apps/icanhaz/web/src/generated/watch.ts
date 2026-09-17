// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/watch@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, readLeb128, encodeString, readString, encodeBytes, readBytes, invoke, resultValue, streamingCall } from "../wrpc";

const INSTANCE = "icanhaz:nocap/watch@0.1.0";



function enc_179(v: Uint8Array): number[] {
    return encodeBytes(v);
}

function dec_181(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_180(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_180(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}

export async function open(t: WrpcTransport, grant: string): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "open", [...encodeString(grant)]);
    return dec_181(resultValue(resp), 0)[0];
}

export interface WatcherWatchSession {
    onError(cb: (err: string) => void): void;
    onData(cb: (chunk: Uint8Array | null) => void): void;
    close(): void;
}
export async function watcherWatch(t: WrpcTransport, self: Uint8Array, path: string, recursive: boolean): Promise<WatcherWatchSession> {
    const call = await streamingCall(t, INSTANCE, "watcher.watch", [...enc_179(self), ...encodeString(path), ...[recursive ? 1 : 0]]);
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
