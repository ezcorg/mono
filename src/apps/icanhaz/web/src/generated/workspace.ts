// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/workspace@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, readLeb128, encodeString, readString, invoke, resultValue } from "../wrpc";

const INSTANCE = "icanhaz:nocap/workspace@0.1.0";





function dec_110(b: Uint8Array, o0: number): [{ tag: "ok"; val: string } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = readString(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}

export async function rootPath(t: WrpcTransport, grant: string): Promise<{ tag: "ok"; val: string } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "root-path", [...encodeString(grant)]);
    return dec_110(resultValue(resp), 0)[0];
}
