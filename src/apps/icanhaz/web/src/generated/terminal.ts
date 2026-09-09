// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/terminal@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, leb128, encodeString, readString, streamingCall } from "../wrpc";

const INSTANCE = "icanhaz:nocap/terminal@0.1.0";







export interface OpenSession {
    stdin(bytes: Uint8Array): void;
    closeStdin(): void;
    control(bytes: Uint8Array): void;
    closeControl(): void;
    onError(cb: (err: string) => void): void;
    onData(cb: (chunk: Uint8Array | null) => void): void;
    close(): void;
}
export async function open(t: WrpcTransport, grant: string, cols: number, rows: number): Promise<OpenSession> {
    const call = await streamingCall(t, INSTANCE, "open", [...encodeString(grant), 0, 0, ...leb128(cols), ...leb128(rows)]);
    let errCb: ((e: string) => void) | undefined;
    call.onResult((v) => { if (v[0] === 1) { const [e] = readString(v, 1); errCb?.(e); } });
    let dataCb: ((c: Uint8Array | null) => void) | undefined;
    call.onStream(0, (c) => dataCb?.(c));
    return {
        stdin(bytes) { call.send(1, bytes); },
        closeStdin() { call.closeStream(1); },
        control(bytes) { call.send(2, bytes); },
        closeControl() { call.closeStream(2); },
        onError(cb) { errCb = cb; },
        onData(cb) { dataCb = cb; },
        close() { call.close(); },
    };
}
