// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/workspace@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, readLeb128, encodeString, readString, encodeBytes, readBytes, invoke, resultValue } from "../wrpc";

const INSTANCE = "icanhaz:nocap/workspace@0.1.0";



function enc_183(v: Uint8Array): number[] {
    return encodeBytes(v);
}

function dec_107(b: Uint8Array, o0: number): [{ tag: "ok"; val: string } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = readString(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_185(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_184(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_184(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}

export async function workspaceRootPath(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: string } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "workspace.root-path", [...enc_183(self)]);
    return dec_107(resultValue(resp), 0)[0];
}

export async function open(t: WrpcTransport, grant: string): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "open", [...encodeString(grant)]);
    return dec_185(resultValue(resp), 0)[0];
}
