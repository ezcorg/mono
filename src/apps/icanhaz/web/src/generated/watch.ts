// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/watch@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, encodeString, readString, streamingCall } from "../wrpc";

const INSTANCE = "icanhaz:nocap/watch@0.1.0";







export interface OpenSession {
    onError(cb: (err: string) => void): void;
    onData(cb: (chunk: Uint8Array | null) => void): void;
    close(): void;
}
export async function open(t: WrpcTransport, grant: string, path: string, recursive: boolean): Promise<OpenSession> {
    const call = await streamingCall(t, INSTANCE, "open", [...encodeString(grant), ...encodeString(path), ...[recursive ? 1 : 0]]);
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
