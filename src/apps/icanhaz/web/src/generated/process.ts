// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/process@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, leb128, encodeString, readString, streamingCall } from "../wrpc";

const INSTANCE = "icanhaz:nocap/process@0.1.0";



function enc_74(v: string[]): number[] {
    return [...leb128(v.length), ...v.flatMap((x) => encodeString(x))];
}



export interface SpawnSession {
    stdin(bytes: Uint8Array): void;
    closeStdin(): void;
    onError(cb: (err: string) => void): void;
    onData(cb: (chunk: Uint8Array | null) => void): void;
    close(): void;
}
export async function spawn(t: WrpcTransport, grant: string, args: string[]): Promise<SpawnSession> {
    const call = await streamingCall(t, INSTANCE, "spawn", [...encodeString(grant), ...enc_74(args), 0]);
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
