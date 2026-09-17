// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/components@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, readLeb128, readLeb128Big, encodeString, readString, encodeBytes, readBytes, readBool, readList, invoke, resultValue } from "../wrpc";

const INSTANCE = "icanhaz:nocap/components@0.1.0";

export type Provenance = { source: string; revision: string | undefined; build: string | undefined; builder: string | undefined };
export type ComponentInfo = { hash: string; name: string | undefined; size: bigint; imports: string[]; exports: string[]; added: bigint; provenance: Provenance | undefined; reproducible: boolean };

function enc_42(v: Uint8Array): number[] {
    return encodeBytes(v);
}
function enc_40(v: Provenance | undefined): number[] {
    return v === undefined ? [0] : [1, ...encProvenance(v)];
}
function encProvenance(v: Provenance): number[] {
    return [...encodeString(v.source), ...enc_37(v.revision), ...enc_37(v.build), ...enc_37(v.builder)];
}
function enc_37(v: string | undefined): number[] {
    return v === undefined ? [0] : [1, ...encodeString(v)];
}

function dec_43(b: Uint8Array, o0: number): [{ tag: "ok"; val: ComponentInfo } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = decComponentInfo(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function decComponentInfo(b: Uint8Array, o0: number): [ComponentInfo, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = dec_37(b, o1);
    const [_2, o3] = readLeb128Big(b, o2);
    const [_3, o4] = dec_39(b, o3);
    const [_4, o5] = dec_39(b, o4);
    const [_5, o6] = readLeb128Big(b, o5);
    const [_6, o7] = dec_40(b, o6);
    const [_7, o8] = readBool(b, o7);
    return [{ hash: _0, name: _1, size: _2, imports: _3, exports: _4, added: _5, provenance: _6, reproducible: _7 }, o8];
}
function dec_37(b: Uint8Array, o0: number): [string | undefined, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) return [undefined, o1];
    return readString(b, o1);
}
function dec_39(b: Uint8Array, o0: number): [string[], number] {
    return readList(b, o0, readString);
}
function dec_40(b: Uint8Array, o0: number): [Provenance | undefined, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) return [undefined, o1];
    return decProvenance(b, o1);
}
function decProvenance(b: Uint8Array, o0: number): [Provenance, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = dec_37(b, o1);
    const [_2, o3] = dec_37(b, o2);
    const [_3, o4] = dec_37(b, o3);
    return [{ source: _0, revision: _1, build: _2, builder: _3 }, o4];
}
function dec_44(b: Uint8Array, o0: number): [ComponentInfo[], number] {
    return readList(b, o0, decComponentInfo);
}
function dec_45(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_42(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_42(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}
function dec_46(b: Uint8Array, o0: number): [{ tag: "ok"; val: boolean } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = readBool(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}

export async function add(t: WrpcTransport, bytes: Uint8Array, provenance: Provenance | undefined): Promise<{ tag: "ok"; val: ComponentInfo } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "add", [...enc_42(bytes), ...enc_40(provenance)]);
    return dec_43(resultValue(resp), 0)[0];
}

export async function all(t: WrpcTransport): Promise<ComponentInfo[]> {
    const resp = await invoke(t, INSTANCE, "all", []);
    return dec_44(resultValue(resp), 0)[0];
}

export async function get(t: WrpcTransport, hash: string): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "get", [...encodeString(hash)]);
    return dec_45(resultValue(resp), 0)[0];
}

export async function remove(t: WrpcTransport, hash: string): Promise<{ tag: "ok"; val: boolean } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "remove", [...encodeString(hash)]);
    return dec_46(resultValue(resp), 0)[0];
}
