// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/filesystem@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, readLeb128, encodeString, readString, readBytes, invoke, resultValue } from "../wrpc";

const INSTANCE = "icanhaz:nocap/filesystem@0.1.0";





function dec_106(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_105(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_105(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}

export async function open(t: WrpcTransport, grant: string): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "open", [...encodeString(grant)]);
    return dec_106(resultValue(resp), 0)[0];
}
