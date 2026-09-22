// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `example:links/links@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, readLeb128, encodeString, readString, encodeBytes, readBytes, readList, invoke, resultValue } from "../wrpc";

const INSTANCE = "example:links/links@0.1.0";

export type Link = { source: string; target: string; line: number };

function enc_2(v: Uint8Array): number[] {
    return encodeBytes(v);
}

function dec_4(b: Uint8Array, o0: number): [{ tag: "ok"; val: Link[] } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_3(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_3(b: Uint8Array, o0: number): [Link[], number] {
    return readList(b, o0, decLink);
}
function decLink(b: Uint8Array, o0: number): [Link, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = readString(b, o1);
    const [_2, o3] = readLeb128(b, o2);
    return [{ source: _0, target: _1, line: _2 }, o3];
}
function dec_5(b: Uint8Array, o0: number): [{ tag: "ok"; val: number } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = readLeb128(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_7(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_6(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_6(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}

export async function indexBacklinks(t: WrpcTransport, self: Uint8Array, note: string): Promise<{ tag: "ok"; val: Link[] } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "index.backlinks", [...enc_2(self), ...encodeString(note)]);
    return dec_4(resultValue(resp), 0)[0];
}

export async function indexUnresolved(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: Link[] } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "index.unresolved", [...enc_2(self)]);
    return dec_4(resultValue(resp), 0)[0];
}

export async function indexRename(t: WrpcTransport, self: Uint8Array, oldPath: string, newPath: string): Promise<{ tag: "ok"; val: number } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "index.rename", [...enc_2(self), ...encodeString(oldPath), ...encodeString(newPath)]);
    return dec_5(resultValue(resp), 0)[0];
}

export async function open(t: WrpcTransport, grant: string): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "open", [...encodeString(grant)]);
    return dec_7(resultValue(resp), 0)[0];
}
