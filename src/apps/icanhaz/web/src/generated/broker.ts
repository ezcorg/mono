// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/broker@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, leb128, readLeb128, encodeString, readString, readList, invoke, resultValue } from "../wrpc";

const INSTANCE = "icanhaz:nocap/broker@0.1.0";

export type CapabilityKind = { tag: "filesystem"; val: FsRequest } | { tag: "sockets"; val: SocketRequest } | { tag: "process"; val: ProcessRequest } | { tag: "terminal"; val: TerminalRequest };
export type FsRequest = { roots: PathGrant[] };
export type PathGrant = { path: string; rights: FsRights };
export type FsRights = { read?: boolean; write?: boolean; create?: boolean; delete?: boolean; watch?: boolean };
export type SocketRequest = { allow: Endpoint[]; mayListen: boolean };
export type Endpoint = { host: string; loPort: number; hiPort: number; proto: Transport };
export type Transport = "tcp" | "udp";
export type ProcessRequest = { image: string; guestChoosesArgv: boolean };
export type TerminalRequest = { shell: string | undefined; jailed: boolean };
export type Grant = { token: string; pairing: string | undefined };
export type Denied = { tag: "user-rejected" } | { tag: "not-authorized" } | { tag: "no-provider" } | { tag: "unsupported"; val: string } | { tag: "quota" } | { tag: "revoked" };
export type GrantInfo = { id: string; holder: Principal; summary: string };
export type Principal = { kind: PrincipalKind; id: string; displayName: string | undefined };
export type PrincipalKind = "web-origin" | "installed-app" | "peer";

function encCapabilityKind(v: CapabilityKind): number[] {
    if (v.tag === "filesystem") return [...leb128(0), ...encFsRequest(v.val)];
    if (v.tag === "sockets") return [...leb128(1), ...encSocketRequest(v.val)];
    if (v.tag === "process") return [...leb128(2), ...encProcessRequest(v.val)];
    if (v.tag === "terminal") return [...leb128(3), ...encTerminalRequest(v.val)];
    throw new Error("bad variant: " + (v as { tag: string }).tag);
}
function encFsRequest(v: FsRequest): number[] {
    return [...enc_82(v.roots)];
}
function enc_82(v: PathGrant[]): number[] {
    return [...leb128(v.length), ...v.flatMap((x) => encPathGrant(x))];
}
function encPathGrant(v: PathGrant): number[] {
    return [...encodeString(v.path), ...encFsRights(v.rights)];
}
function encFsRights(v: FsRights): number[] {
    const bytes = new Array(1).fill(0);
    if (v.read) bytes[0] |= 1;
    if (v.write) bytes[0] |= 2;
    if (v.create) bytes[0] |= 4;
    if (v.delete) bytes[0] |= 8;
    if (v.watch) bytes[0] |= 16;
    return bytes;
}
function encSocketRequest(v: SocketRequest): number[] {
    return [...enc_86(v.allow), ...[v.mayListen ? 1 : 0]];
}
function enc_86(v: Endpoint[]): number[] {
    return [...leb128(v.length), ...v.flatMap((x) => encEndpoint(x))];
}
function encEndpoint(v: Endpoint): number[] {
    return [...encodeString(v.host), ...leb128(v.loPort), ...leb128(v.hiPort), ...encTransport(v.proto)];
}
function encTransport(v: Transport): number[] {
    return leb128(["tcp", "udp"].indexOf(v));
}
function encProcessRequest(v: ProcessRequest): number[] {
    return [...encodeString(v.image), ...[v.guestChoosesArgv ? 1 : 0]];
}
function encTerminalRequest(v: TerminalRequest): number[] {
    return [...enc_78(v.shell), ...[v.jailed ? 1 : 0]];
}
function enc_78(v: string | undefined): number[] {
    return v === undefined ? [0] : [1, ...encodeString(v)];
}

function dec_98(b: Uint8Array, o0: number): [{ tag: "ok"; val: Grant } | { tag: "err"; val: Denied }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = decGrant(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decDenied(b, o1); return [{ tag: "err", val }, o2];
}
function decGrant(b: Uint8Array, o0: number): [Grant, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = dec_78(b, o1);
    return [{ token: _0, pairing: _1 }, o2];
}
function dec_78(b: Uint8Array, o0: number): [string | undefined, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) return [undefined, o1];
    return readString(b, o1);
}
function decDenied(b: Uint8Array, o0: number): [Denied, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) return [{ tag: "user-rejected" }, o1];
    if (d === 1) return [{ tag: "not-authorized" }, o1];
    if (d === 2) return [{ tag: "no-provider" }, o1];
    if (d === 3) { const [val, o2] = readString(b, o1); return [{ tag: "unsupported", val }, o2]; }
    if (d === 4) return [{ tag: "quota" }, o1];
    if (d === 5) return [{ tag: "revoked" }, o1];
    throw new Error("bad disc: " + d);
}
function dec_99(b: Uint8Array, o0: number): [GrantInfo[], number] {
    return readList(b, o0, decGrantInfo);
}
function decGrantInfo(b: Uint8Array, o0: number): [GrantInfo, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = decPrincipal(b, o1);
    const [_2, o3] = readString(b, o2);
    return [{ id: _0, holder: _1, summary: _2 }, o3];
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

export async function request(t: WrpcTransport, want: CapabilityKind, reason: string, pairing: string | undefined): Promise<{ tag: "ok"; val: Grant } | { tag: "err"; val: Denied }> {
    const resp = await invoke(t, INSTANCE, "request", [...encCapabilityKind(want), ...encodeString(reason), ...enc_78(pairing)]);
    return dec_98(resultValue(resp), 0)[0];
}

export async function granted(t: WrpcTransport): Promise<GrantInfo[]> {
    const resp = await invoke(t, INSTANCE, "granted", []);
    return dec_99(resultValue(resp), 0)[0];
}

export async function revoke(t: WrpcTransport, token: string): Promise<void> {
    await invoke(t, INSTANCE, "revoke", [...encodeString(token)]);
}
