// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:fspass/mount@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, readLeb128, encodeString, readString, readBytes, invoke, resultValue } from "../wrpc";

const INSTANCE = "icanhaz:fspass/mount@0.1.0";





function dec_74(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_73(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_73(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}

export async function openRoot(t: WrpcTransport, grant: string): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "open-root", [...encodeString(grant)]);
    return dec_74(resultValue(resp), 0)[0];
}
