// GENERATED from wit/ by tools/wit-gen.mjs — do not edit.
// Codecs + client stubs for `wasi:filesystem/types@0.2.12`, riding the runtime in ../wrpc.
import { type Transport as WrpcTransport, leb128, readLeb128, readLeb128Big, encodeString, readString, encodeBytes, readBytes, readBool, invoke, resultValue, streamingCall } from "../wrpc";

const INSTANCE = "wasi:filesystem/types@0.2.12";

export type Filesize = bigint;
export type Advice = "normal" | "sequential" | "random" | "will-need" | "dont-need" | "no-reuse";
export type NewTimestamp = { tag: "no-change" } | { tag: "now" } | { tag: "timestamp"; val: Datetime };
export type Datetime = { seconds: bigint; nanoseconds: number };
export type PathFlags = { symlinkFollow?: boolean };
export type OpenFlags = { create?: boolean; directory?: boolean; exclusive?: boolean; truncate?: boolean };
export type DescriptorFlags = { read?: boolean; write?: boolean; fileIntegritySync?: boolean; dataIntegritySync?: boolean; requestedWriteSync?: boolean; mutateDirectory?: boolean };
export type ErrorCode = "access" | "would-block" | "already" | "bad-descriptor" | "busy" | "deadlock" | "quota" | "exist" | "file-too-large" | "illegal-byte-sequence" | "in-progress" | "interrupted" | "invalid" | "io" | "is-directory" | "loop" | "too-many-links" | "message-size" | "name-too-long" | "no-device" | "no-entry" | "no-lock" | "insufficient-memory" | "insufficient-space" | "not-directory" | "not-empty" | "not-recoverable" | "unsupported" | "no-tty" | "no-such-device" | "overflow" | "not-permitted" | "pipe" | "read-only" | "invalid-seek" | "text-file-busy" | "cross-device";
export type DescriptorType = "unknown" | "block-device" | "character-device" | "directory" | "fifo" | "symbolic-link" | "regular-file" | "socket";
export type DescriptorStat = { type: DescriptorType; linkCount: LinkCount; size: Filesize; dataAccessTimestamp: Datetime | undefined; dataModificationTimestamp: Datetime | undefined; statusChangeTimestamp: Datetime | undefined };
export type LinkCount = bigint;
export type MetadataHashValue = { lower: bigint; upper: bigint };
export type DirectoryEntry = { type: DescriptorType; name: string };

function enc_43(v: Uint8Array): number[] {
    return encodeBytes(v);
}
function encAdvice(v: Advice): number[] {
    return leb128(["normal", "sequential", "random", "will-need", "dont-need", "no-reuse"].indexOf(v));
}
function encNewTimestamp(v: NewTimestamp): number[] {
    if (v.tag === "no-change") return leb128(0);
    if (v.tag === "now") return leb128(1);
    if (v.tag === "timestamp") return [...leb128(2), ...encDatetime(v.val)];
    throw new Error("bad variant: " + (v as { tag: string }).tag);
}
function encDatetime(v: Datetime): number[] {
    return [...leb128(v.seconds), ...leb128(v.nanoseconds)];
}
function enc_51(v: Uint8Array): number[] {
    return encodeBytes(v);
}
function encPathFlags(v: PathFlags): number[] {
    const bytes = new Array(1).fill(0);
    if (v.symlinkFollow) bytes[0] |= 1;
    return bytes;
}
function encOpenFlags(v: OpenFlags): number[] {
    const bytes = new Array(1).fill(0);
    if (v.create) bytes[0] |= 1;
    if (v.directory) bytes[0] |= 2;
    if (v.exclusive) bytes[0] |= 4;
    if (v.truncate) bytes[0] |= 8;
    return bytes;
}
function encDescriptorFlags(v: DescriptorFlags): number[] {
    const bytes = new Array(1).fill(0);
    if (v.read) bytes[0] |= 1;
    if (v.write) bytes[0] |= 2;
    if (v.fileIntegritySync) bytes[0] |= 4;
    if (v.dataIntegritySync) bytes[0] |= 8;
    if (v.requestedWriteSync) bytes[0] |= 16;
    if (v.mutateDirectory) bytes[0] |= 32;
    return bytes;
}
function enc_62(v: Uint8Array): number[] {
    return encodeBytes(v);
}
function enc_65(v: Uint8Array): number[] {
    return encodeBytes(v);
}

function decErrorCode(b: Uint8Array, o0: number): [ErrorCode, number] {
    const [d, o1] = readLeb128(b, o0);
    return [(["access", "would-block", "already", "bad-descriptor", "busy", "deadlock", "quota", "exist", "file-too-large", "illegal-byte-sequence", "in-progress", "interrupted", "invalid", "io", "is-directory", "loop", "too-many-links", "message-size", "name-too-long", "no-device", "no-entry", "no-lock", "insufficient-memory", "insufficient-space", "not-directory", "not-empty", "not-recoverable", "unsupported", "no-tty", "no-such-device", "overflow", "not-permitted", "pipe", "read-only", "invalid-seek", "text-file-busy", "cross-device"] as const)[d]!, o1];
}
function dec_47(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_46(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function dec_46(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}
function dec_48(b: Uint8Array, o0: number): [{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { return [{ tag: "ok", val: undefined }, o1]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function dec_49(b: Uint8Array, o0: number): [{ tag: "ok"; val: DescriptorFlags } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = decDescriptorFlags(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function decDescriptorFlags(b: Uint8Array, o0: number): [DescriptorFlags, number] {
    return [{ read: !!(b[o0 + 0]! & 1), write: !!(b[o0 + 0]! & 2), fileIntegritySync: !!(b[o0 + 0]! & 4), dataIntegritySync: !!(b[o0 + 0]! & 8), requestedWriteSync: !!(b[o0 + 0]! & 16), mutateDirectory: !!(b[o0 + 0]! & 32) }, o0 + 1];
}
function dec_50(b: Uint8Array, o0: number): [{ tag: "ok"; val: DescriptorType } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = decDescriptorType(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function decDescriptorType(b: Uint8Array, o0: number): [DescriptorType, number] {
    const [d, o1] = readLeb128(b, o0);
    return [(["unknown", "block-device", "character-device", "directory", "fifo", "symbolic-link", "regular-file", "socket"] as const)[d]!, o1];
}
function dec_53(b: Uint8Array, o0: number): [{ tag: "ok"; val: [Uint8Array, boolean] } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_52(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function dec_52(b: Uint8Array, o0: number): [[Uint8Array, boolean], number] {
    const [_0, o1] = dec_51(b, o0);
    const [_1, o2] = readBool(b, o1);
    return [[_0, _1], o2];
}
function dec_51(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}
function dec_54(b: Uint8Array, o0: number): [{ tag: "ok"; val: Filesize } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = readLeb128Big(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function dec_56(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_55(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function dec_55(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}
function dec_57(b: Uint8Array, o0: number): [{ tag: "ok"; val: DescriptorStat } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = decDescriptorStat(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function decDescriptorStat(b: Uint8Array, o0: number): [DescriptorStat, number] {
    const [_0, o1] = decDescriptorType(b, o0);
    const [_1, o2] = readLeb128Big(b, o1);
    const [_2, o3] = readLeb128Big(b, o2);
    const [_3, o4] = dec_34(b, o3);
    const [_4, o5] = dec_34(b, o4);
    const [_5, o6] = dec_34(b, o5);
    return [{ type: _0, linkCount: _1, size: _2, dataAccessTimestamp: _3, dataModificationTimestamp: _4, statusChangeTimestamp: _5 }, o6];
}
function dec_34(b: Uint8Array, o0: number): [Datetime | undefined, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) return [undefined, o1];
    return decDatetime(b, o1);
}
function decDatetime(b: Uint8Array, o0: number): [Datetime, number] {
    const [_0, o1] = readLeb128Big(b, o0);
    const [_1, o2] = readLeb128(b, o1);
    return [{ seconds: _0, nanoseconds: _1 }, o2];
}
function dec_59(b: Uint8Array, o0: number): [{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_58(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function dec_58(b: Uint8Array, o0: number): [Uint8Array, number] {
    return readBytes(b, o0);
}
function dec_60(b: Uint8Array, o0: number): [{ tag: "ok"; val: string } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = readString(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function dec_61(b: Uint8Array, o0: number): [{ tag: "ok"; val: MetadataHashValue } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = decMetadataHashValue(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function decMetadataHashValue(b: Uint8Array, o0: number): [MetadataHashValue, number] {
    const [_0, o1] = readLeb128Big(b, o0);
    const [_1, o2] = readLeb128Big(b, o1);
    return [{ lower: _0, upper: _1 }, o2];
}
function dec_64(b: Uint8Array, o0: number): [{ tag: "ok"; val: DirectoryEntry | undefined } | { tag: "err"; val: ErrorCode }, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) { const [val, o2] = dec_63(b, o1); return [{ tag: "ok", val }, o2]; }
    const [val, o2] = decErrorCode(b, o1); return [{ tag: "err", val }, o2];
}
function dec_63(b: Uint8Array, o0: number): [DirectoryEntry | undefined, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) return [undefined, o1];
    return decDirectoryEntry(b, o1);
}
function decDirectoryEntry(b: Uint8Array, o0: number): [DirectoryEntry, number] {
    const [_0, o1] = decDescriptorType(b, o0);
    const [_1, o2] = readString(b, o1);
    return [{ type: _0, name: _1 }, o2];
}
function dec_66(b: Uint8Array, o0: number): [ErrorCode | undefined, number] {
    const [d, o1] = readLeb128(b, o0);
    if (d === 0) return [undefined, o1];
    return decErrorCode(b, o1);
}

export async function descriptorWriteViaStream(t: WrpcTransport, self: Uint8Array, offset: Filesize): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.write-via-stream", [...enc_43(self), ...leb128(offset)]);
    return dec_47(resultValue(resp), 0)[0];
}

export async function descriptorAppendViaStream(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.append-via-stream", [...enc_43(self)]);
    return dec_47(resultValue(resp), 0)[0];
}

export async function descriptorAdvise(t: WrpcTransport, self: Uint8Array, offset: Filesize, length: Filesize, advice: Advice): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.advise", [...enc_43(self), ...leb128(offset), ...leb128(length), ...encAdvice(advice)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorSyncData(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.sync-data", [...enc_43(self)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorGetFlags(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: DescriptorFlags } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.get-flags", [...enc_43(self)]);
    return dec_49(resultValue(resp), 0)[0];
}

export async function descriptorGetType(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: DescriptorType } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.get-type", [...enc_43(self)]);
    return dec_50(resultValue(resp), 0)[0];
}

export async function descriptorSetSize(t: WrpcTransport, self: Uint8Array, size: Filesize): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.set-size", [...enc_43(self), ...leb128(size)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorSetTimes(t: WrpcTransport, self: Uint8Array, dataAccessTimestamp: NewTimestamp, dataModificationTimestamp: NewTimestamp): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.set-times", [...enc_43(self), ...encNewTimestamp(dataAccessTimestamp), ...encNewTimestamp(dataModificationTimestamp)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorRead(t: WrpcTransport, self: Uint8Array, length: Filesize, offset: Filesize): Promise<{ tag: "ok"; val: [Uint8Array, boolean] } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.read", [...enc_43(self), ...leb128(length), ...leb128(offset)]);
    return dec_53(resultValue(resp), 0)[0];
}

export async function descriptorWrite(t: WrpcTransport, self: Uint8Array, buffer: Uint8Array, offset: Filesize): Promise<{ tag: "ok"; val: Filesize } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.write", [...enc_43(self), ...enc_51(buffer), ...leb128(offset)]);
    return dec_54(resultValue(resp), 0)[0];
}

export async function descriptorReadDirectory(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.read-directory", [...enc_43(self)]);
    return dec_56(resultValue(resp), 0)[0];
}

export async function descriptorSync(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.sync", [...enc_43(self)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorCreateDirectoryAt(t: WrpcTransport, self: Uint8Array, path: string): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.create-directory-at", [...enc_43(self), ...encodeString(path)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorStat(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: DescriptorStat } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.stat", [...enc_43(self)]);
    return dec_57(resultValue(resp), 0)[0];
}

export async function descriptorStatAt(t: WrpcTransport, self: Uint8Array, pathFlags: PathFlags, path: string): Promise<{ tag: "ok"; val: DescriptorStat } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.stat-at", [...enc_43(self), ...encPathFlags(pathFlags), ...encodeString(path)]);
    return dec_57(resultValue(resp), 0)[0];
}

export async function descriptorSetTimesAt(t: WrpcTransport, self: Uint8Array, pathFlags: PathFlags, path: string, dataAccessTimestamp: NewTimestamp, dataModificationTimestamp: NewTimestamp): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.set-times-at", [...enc_43(self), ...encPathFlags(pathFlags), ...encodeString(path), ...encNewTimestamp(dataAccessTimestamp), ...encNewTimestamp(dataModificationTimestamp)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorLinkAt(t: WrpcTransport, self: Uint8Array, oldPathFlags: PathFlags, oldPath: string, newDescriptor: Uint8Array, newPath: string): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.link-at", [...enc_43(self), ...encPathFlags(oldPathFlags), ...encodeString(oldPath), ...enc_43(newDescriptor), ...encodeString(newPath)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorOpenAt(t: WrpcTransport, self: Uint8Array, pathFlags: PathFlags, path: string, openFlags: OpenFlags, flags: DescriptorFlags): Promise<{ tag: "ok"; val: Uint8Array } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.open-at", [...enc_43(self), ...encPathFlags(pathFlags), ...encodeString(path), ...encOpenFlags(openFlags), ...encDescriptorFlags(flags)]);
    return dec_59(resultValue(resp), 0)[0];
}

export async function descriptorReadlinkAt(t: WrpcTransport, self: Uint8Array, path: string): Promise<{ tag: "ok"; val: string } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.readlink-at", [...enc_43(self), ...encodeString(path)]);
    return dec_60(resultValue(resp), 0)[0];
}

export async function descriptorRemoveDirectoryAt(t: WrpcTransport, self: Uint8Array, path: string): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.remove-directory-at", [...enc_43(self), ...encodeString(path)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorRenameAt(t: WrpcTransport, self: Uint8Array, oldPath: string, newDescriptor: Uint8Array, newPath: string): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.rename-at", [...enc_43(self), ...encodeString(oldPath), ...enc_43(newDescriptor), ...encodeString(newPath)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorSymlinkAt(t: WrpcTransport, self: Uint8Array, oldPath: string, newPath: string): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.symlink-at", [...enc_43(self), ...encodeString(oldPath), ...encodeString(newPath)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorUnlinkFileAt(t: WrpcTransport, self: Uint8Array, path: string): Promise<{ tag: "ok"; val: void } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.unlink-file-at", [...enc_43(self), ...encodeString(path)]);
    return dec_48(resultValue(resp), 0)[0];
}

export async function descriptorIsSameObject(t: WrpcTransport, self: Uint8Array, other: Uint8Array): Promise<boolean> {
    const resp = await invoke(t, INSTANCE, "descriptor.is-same-object", [...enc_43(self), ...enc_43(other)]);
    return readBool(resultValue(resp), 0)[0];
}

export async function descriptorMetadataHash(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: MetadataHashValue } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.metadata-hash", [...enc_43(self)]);
    return dec_61(resultValue(resp), 0)[0];
}

export async function descriptorMetadataHashAt(t: WrpcTransport, self: Uint8Array, pathFlags: PathFlags, path: string): Promise<{ tag: "ok"; val: MetadataHashValue } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "descriptor.metadata-hash-at", [...enc_43(self), ...encPathFlags(pathFlags), ...encodeString(path)]);
    return dec_61(resultValue(resp), 0)[0];
}

export async function directoryEntryStreamReadDirectoryEntry(t: WrpcTransport, self: Uint8Array): Promise<{ tag: "ok"; val: DirectoryEntry | undefined } | { tag: "err"; val: ErrorCode }> {
    const resp = await invoke(t, INSTANCE, "directory-entry-stream.read-directory-entry", [...enc_62(self)]);
    return dec_64(resultValue(resp), 0)[0];
}

export async function filesystemErrorCode(t: WrpcTransport, err: Uint8Array): Promise<ErrorCode | undefined> {
    const resp = await invoke(t, INSTANCE, "filesystem-error-code", [...enc_65(err)]);
    return dec_66(resultValue(resp), 0)[0];
}

export interface DescriptorReadViaStreamSession {
    onError(cb: (err: ErrorCode) => void): void;
    onData(cb: (chunk: Uint8Array | null) => void): void;
    close(): void;
}
export async function descriptorReadViaStream(t: WrpcTransport, self: Uint8Array, offset: Filesize): Promise<DescriptorReadViaStreamSession> {
    const call = await streamingCall(t, INSTANCE, "descriptor.read-via-stream", [...enc_43(self), ...leb128(offset)]);
    let errCb: ((e: ErrorCode) => void) | undefined;
    call.onResult((v) => { if (v[0] === 1) { const [e] = decErrorCode(v, 1); errCb?.(e); } });
    let dataCb: ((c: Uint8Array | null) => void) | undefined;
    call.onStream(0, (c) => dataCb?.(c));
    return {
        onError(cb) { errCb = cb; },
        onData(cb) { dataCb = cb; },
        close() { call.close(); },
    };
}
