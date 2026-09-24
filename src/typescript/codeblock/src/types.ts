import { CborUint8Array } from "@jsonjoy.com/json-pack/lib/cbor/types";
import { SnapshotNode } from "@joinezco/memfs/snapshot";
import { FsApi } from "@joinezco/memfs/node/types";

export type FsMountOptions = {
    mount: (args: { buffer: ArrayBuffer }) => Promise<MountResult>;
    mountFromUrl?: (args: { url: string; mountPoint?: string; }) => Promise<MountResult>;
}

export type MountArgs = {
    buffer?: CborUint8Array<SnapshotNode>;
    mountPoint?: string;
}

export type MountFromUrlArgs = {
    url: string;
    mountPoint?: string;
}

export type MountResult = {
    fs: FsApi;
}