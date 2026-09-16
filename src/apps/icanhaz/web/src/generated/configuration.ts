// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `icanhaz:nocap/configuration@0.1.0`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, leb128, readLeb128, readLeb128Big, encodeString, readString, encodeBytes, readBytes, readBool, encF64, readF64, readList, invoke, resultValue } from "../wrpc";

const INSTANCE = "icanhaz:nocap/configuration@0.1.0";

export type Declared = { capability: string; instanceNoun: string; ownerPrefix: string; single: boolean; fields: InputSchema[]; description: string | undefined };
export type InputSchema = { name: string; inputType: InputType; optional: boolean; default: ActualInput | undefined; description: string | undefined };
export type InputType = { tag: "str" } | { tag: "boolean" } | { tag: "number" } | { tag: "select"; val: string[] } | { tag: "datetime" } | { tag: "daterange" } | { tag: "file" } | { tag: "binary" } | { tag: "secret" };
export type ActualInput = { tag: "str"; val: string } | { tag: "boolean"; val: boolean } | { tag: "number"; val: number } | { tag: "select"; val: string } | { tag: "datetime"; val: string } | { tag: "daterange"; val: [string, string] } | { tag: "file"; val: FileInput } | { tag: "binary"; val: Uint8Array } | { tag: "secret"; val: string };
export type FileInput = { name: string; contentType: string | undefined; data: Uint8Array };
export type Snapshot = { revision: bigint; instances: Instance[] };
export type Instance = { name: string; values: UserInput[] };
export type UserInput = { name: string; value: ActualInput };

function encDeclared(v: Declared): number[] {
    return [...encodeString(v.capability), ...encodeString(v.instanceNoun), ...encodeString(v.ownerPrefix), ...[v.single ? 1 : 0], ...enc_39(v.fields), ...enc_40(v.description)];
}
function enc_39(v: InputSchema[]): number[] {
    return [...leb128(v.length), ...v.flatMap((x) => encInputSchema(x))];
}
function encInputSchema(v: InputSchema): number[] {
    return [...encodeString(v.name), ...encInputType(v.inputType), ...[v.optional ? 1 : 0], ...enc_10(v.default), ...enc_3(v.description)];
}
function encInputType(v: InputType): number[] {
    if (v.tag === "str") return leb128(0);
    if (v.tag === "boolean") return leb128(1);
    if (v.tag === "number") return leb128(2);
    if (v.tag === "select") return [...leb128(3), ...enc_6(v.val)];
    if (v.tag === "datetime") return leb128(4);
    if (v.tag === "daterange") return leb128(5);
    if (v.tag === "file") return leb128(6);
    if (v.tag === "binary") return leb128(7);
    if (v.tag === "secret") return leb128(8);
    throw new Error("bad variant: " + (v as { tag: string }).tag);
}
function enc_6(v: string[]): number[] {
    return [...leb128(v.length), ...v.flatMap((x) => encodeString(x))];
}
function enc_10(v: ActualInput | undefined): number[] {
    return v === undefined ? [0] : [1, ...encActualInput(v)];
}
function encActualInput(v: ActualInput): number[] {
    if (v.tag === "str") return [...leb128(0), ...encodeString(v.val)];
    if (v.tag === "boolean") return [...leb128(1), ...[v.val ? 1 : 0]];
    if (v.tag === "number") return [...leb128(2), ...encF64(v.val)];
    if (v.tag === "select") return [...leb128(3), ...encodeString(v.val)];
    if (v.tag === "datetime") return [...leb128(4), ...encodeString(v.val)];
    if (v.tag === "daterange") return [...leb128(5), ...enc_8(v.val)];
    if (v.tag === "file") return [...leb128(6), ...encFileInput(v.val)];
    if (v.tag === "binary") return [...leb128(7), ...enc_4(v.val)];
    if (v.tag === "secret") return [...leb128(8), ...encodeString(v.val)];
    throw new Error("bad variant: " + (v as { tag: string }).tag);
}
function enc_8(v: [string, string]): number[] {
    return [...encodeString(v[0]), ...encodeString(v[1])];
}
function encFileInput(v: FileInput): number[] {
    return [...encodeString(v.name), ...enc_3(v.contentType), ...enc_4(v.data)];
}
function enc_3(v: string | undefined): number[] {
    return v === undefined ? [0] : [1, ...encodeString(v)];
}
function enc_4(v: Uint8Array): number[] {
    return encodeBytes(v);
}
function enc_40(v: string | undefined): number[] {
    return v === undefined ? [0] : [1, ...encodeString(v)];
}

function dec_46(b: Uint8Array, o0: number): [{ tag: "ok"; val: void } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { return [{ tag: "ok", val: undefined }, o1]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_47(b: Uint8Array, o0: number): [{ tag: "ok"; val: boolean } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = readBool(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function dec_48(b: Uint8Array, o0: number): [{ tag: "ok"; val: Snapshot } | { tag: "err"; val: string }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = decSnapshot(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = readString(b, o1); return [{ tag: "err", val }, o2];
}
function decSnapshot(b: Uint8Array, o0: number): [Snapshot, number] {
    const [_0, o1] = readLeb128Big(b, o0);
    const [_1, o2] = dec_44(b, o1);
    return [{ revision: _0, instances: _1 }, o2];
}
function dec_44(b: Uint8Array, o0: number): [Instance[], number] {
    return readList(b, o0, decInstance);
}
function decInstance(b: Uint8Array, o0: number): [Instance, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = dec_42(b, o1);
    return [{ name: _0, values: _1 }, o2];
}
function dec_42(b: Uint8Array, o0: number): [UserInput[], number] {
    return readList(b, o0, decUserInput);
}
function decUserInput(b: Uint8Array, o0: number): [UserInput, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = decActualInput(b, o1);
    return [{ name: _0, value: _1 }, o2];
}
function decActualInput(b: Uint8Array, o0: number): [ActualInput, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = readString(b, o1); return [{ tag: "str", val }, o2]; }
    if (d === 1) { const [val, o2] = readBool(b, o1); return [{ tag: "boolean", val }, o2]; }
    if (d === 2) { const [val, o2] = readF64(b, o1); return [{ tag: "number", val }, o2]; }
    if (d === 3) { const [val, o2] = readString(b, o1); return [{ tag: "select", val }, o2]; }
    if (d === 4) { const [val, o2] = readString(b, o1); return [{ tag: "datetime", val }, o2]; }
    if (d === 5) { const [val, o2] = dec_8(b, o1); return [{ tag: "daterange", val }, o2]; }
    if (d === 6) { const [val, o2] = decFileInput(b, o1); return [{ tag: "file", val }, o2]; }
    if (d === 7) { const [val, o2] = dec_4(b, o1); return [{ tag: "binary", val }, o2]; }
    if (d === 8) { const [val, o2] = readString(b, o1); return [{ tag: "secret", val }, o2]; }
    throw new Error("bad disc: " + d);
}
function dec_8(b: Uint8Array, o0: number): [[string, string], number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = readString(b, o1);
    return [[_0, _1], o2];
}
function decFileInput(b: Uint8Array, o0: number): [FileInput, number] {
    const [_0, o1] = readString(b, o0);
    const [_1, o2] = dec_3(b, o1);
    const [_2, o3] = dec_4(b, o2);
    return [{ name: _0, contentType: _1, data: _2 }, o3];
}
function dec_3(b: Uint8Array, o0: number): [string | undefined, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) return [undefined, o1];
    return readString(b, o1);
}
function dec_4(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}

export async function declare(t: WrpcTransport, declared: Declared): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "declare", [...encDeclared(declared)]);
    return dec_46(resultValue(resp), 0)[0];
}

export async function undeclare(t: WrpcTransport, capability: string): Promise<{ tag: "ok"; val: boolean } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "undeclare", [...encodeString(capability)]);
    return dec_47(resultValue(resp), 0)[0];
}

export async function configured(t: WrpcTransport, ownerPrefix: string): Promise<{ tag: "ok"; val: Snapshot } | { tag: "err"; val: string }> {
    const resp = await invoke(t, INSTANCE, "configured", [...encodeString(ownerPrefix)]);
    return dec_48(resultValue(resp), 0)[0];
}
