// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/policy@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, readLeb128, readLeb128Big, encodeString, readString, encodeBytes, readBytes, readBool, readList, invoke, resultValue } from "../wrpc";

const INSTANCE = "icanhaz:nocap/policy@0.1.0";

export type Principal = { kind: PrincipalKind; id: string; displayName: string | undefined };
export type PrincipalKind = "web-origin" | "installed-app" | "peer";
export type Caveat = { tag: "expires"; val: Datetime } | { tag: "idle-timeout-ms"; val: bigint } | { tag: "max-bytes"; val: bigint } | { tag: "only-paths"; val: string[] } | { tag: "only-endpoints"; val: Endpoint[] };
export type Datetime = { seconds: bigint; nanoseconds: number };
export type Endpoint = { host: string; loPort: number; hiPort: number; proto: Transport };
export type Transport = "tcp" | "udp";

function enc_103(v: Uint8Array): number[] {
    return encodeBytes(v);
}

function decPrincipal(b: Uint8Array, o0: number): [Principal, number] {
    const [_0, o1] = decPrincipalKind(b, o0);
    const [_1, o2] = readString(b, o1);
    const [_2, o3] = dec_78(b, o2);
    return [{ kind: _0, id: _1, displayName: _2 }, o3];
}
function decPrincipalKind(b: Uint8Array, o0: number): [PrincipalKind, number] {
    const [d, o1] = readLeb128(b, o0);
    return [(["web-origin", "installed-app", "peer"] as const)[d]!, o1];
}
function dec_78(b: Uint8Array, o0: number): [string | undefined, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) return [undefined, o1];
    return readString(b, o1);
}
function dec_104(b: Uint8Array, o0: number): [Caveat[], number] {
    return readList(b, o0, decCaveat);
}
function decCaveat(b: Uint8Array, o0: number): [Caveat, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = decDatetime(b, o1); return [{ tag: "expires", val }, o2]; }
    if (d === 1) { const [val, o2] = readLeb128Big(b, o1); return [{ tag: "idle-timeout-ms", val }, o2]; }
    if (d === 2) { const [val, o2] = readLeb128Big(b, o1); return [{ tag: "max-bytes", val }, o2]; }
    if (d === 3) { const [val, o2] = dec_74(b, o1); return [{ tag: "only-paths", val }, o2]; }
    if (d === 4) { const [val, o2] = dec_86(b, o1); return [{ tag: "only-endpoints", val }, o2]; }
    throw new Error("bad disc: " + d);
}
function decDatetime(b: Uint8Array, o0: number): [Datetime, number] {
    const [_0, o1] = readLeb128Big(b, o0);
    const [_1, o2] = readLeb128(b, o1);
    return [{ seconds: _0, nanoseconds: _1 }, o2];
}
function dec_74(b: Uint8Array, o0: number): [string[], number] {
    return readList(b, o0, readString);
}
function dec_86(b: Uint8Array, o0: number): [Endpoint[], number] {
    return readList(b, o0, decEndpoint);
}
function decEndpoint(b: Uint8Array, o0: number): [Endpoint, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = readLeb128(b, o1);
    const [_2, o3] = readLeb128(b, o2);
    const [_3, o4] = decTransport(b, o3);
    return [{ host: _0, loPort: _1, hiPort: _2, proto: _3 }, o4];
}
function decTransport(b: Uint8Array, o0: number): [Transport, number] {
    const [d, o1] = readLeb128(b, o0);
    return [(["tcp", "udp"] as const)[d]!, o1];
}
function dec_110(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}

export async function contextPrincipal(t: WrpcTransport, self: Uint8Array): Promise<Principal> {
    const resp = await invoke(t, INSTANCE, "context.principal", [...enc_103(self)]);
    return decPrincipal(resultValue(resp), 0)[0];
}

export async function contextCaveats(t: WrpcTransport, self: Uint8Array): Promise<Caveat[]> {
    const resp = await invoke(t, INSTANCE, "context.caveats", [...enc_103(self)]);
    return dec_104(resultValue(resp), 0)[0];
}

export async function contextAudit(t: WrpcTransport, self: Uint8Array, event: string): Promise<void> {
    await invoke(t, INSTANCE, "context.audit", [...enc_103(self), ...encodeString(event)]);
}

export async function contextEscalate(t: WrpcTransport, self: Uint8Array, prompt: string): Promise<boolean> {
    const resp = await invoke(t, INSTANCE, "context.escalate", [...enc_103(self), ...encodeString(prompt)]);
    return readBool(resultValue(resp), 0)[0];
}

export async function getContext(t: WrpcTransport): Promise<Uint8Array> {
    const resp = await invoke(t, INSTANCE, "get-context", []);
    return dec_110(resultValue(resp), 0)[0];
}
