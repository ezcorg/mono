import * as Comlink from "comlink";
import { watchOptionsTransferHandler, asyncGeneratorTransferHandler } from '../rpc/serde';
import { MountArgs } from "../types";
import type { SnapshotNode } from '@joinezco/memfs/snapshot';
import type { CborUint8Array } from "@jsonjoy.com/json-pack/lib/cbor/types";
import { Snapshot } from "../utils";
import { fs } from '@joinezco/memfs';
import { Vfs } from "../utils/fs";

Comlink.transferHandlers.set('asyncGenerator', asyncGeneratorTransferHandler)
Comlink.transferHandlers.set('watchOptions', watchOptionsTransferHandler)

let filesystems: any[] = [];

// Create VfsInterface directly in the worker so all memfs calls are local (no nested Comlink proxies)
function createWorkerVfs() {
    return Vfs.fromMemfs(fs as any);
}

export const mount = async ({ buffer, mountPoint = '/' }: MountArgs) => {
    try {
        if (buffer) {
            console.debug(`Mounting filesystem snapshot at [${mountPoint}]...`, buffer);
            const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            const aligned = uint8.byteOffset === 0 && uint8.byteLength === uint8.buffer.byteLength
                ? uint8.buffer
                : uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);

            await Snapshot.mount(new Uint8Array(aligned) as CborUint8Array<SnapshotNode>, {
                // @ts-ignore
                fs,
            });
        }
    } catch (e) {
        console.error('Worker initialization failed:', e);
        throw e;
    }

    const vfs = createWorkerVfs();
    const proxy = Comlink.proxy(vfs);
    filesystems.push(proxy);
    return proxy;
}

export const mountFromUrl = async ({ url, mountPoint = '/' }: {
    url: string;
    mountPoint?: string;
}) => {
    try {
        console.debug(`Loading snapshot from URL: ${url} at [${mountPoint}]...`);
        const startTime = performance.now();
        await Snapshot.loadAndMount(url, {
            // @ts-ignore
            fs,
            path: mountPoint
        });
        console.debug(`Snapshot mounted in ${Math.round(performance.now() - startTime)}ms`);
    } catch (e) {
        console.error('Error loading snapshot from URL:', e);
        throw e;
    }

    const vfs = createWorkerVfs();
    const proxy = Comlink.proxy(vfs);
    filesystems.push(proxy);
    return proxy;
}

onconnect = async function (event) {
    const [port] = event.ports;
    console.debug('workers/fs connected on port: ', port);
    port.addEventListener('close', () => {
        console.debug('fs port closed')
    });
    Comlink.expose({ mount, mountFromUrl }, port);
}
