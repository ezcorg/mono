import * as Comlink from "comlink";
import { watchOptionsTransferHandler, asyncGeneratorTransferHandler } from '../rpc/serde';
import { MountArgs, MountResult } from "../types";
import type { SnapshotNode } from '@joinezco/memfs/snapshot';
import type { CborUint8Array } from "@jsonjoy.com/json-pack/lib/cbor/types";
import { Snapshot } from "../utils";
import { fs } from '@joinezco/memfs';

Comlink.transferHandlers.set('asyncGenerator', asyncGeneratorTransferHandler)
Comlink.transferHandlers.set('watchOptions', watchOptionsTransferHandler)

let filesystems = [];

export const mount = async ({ buffer, mountPoint = '/' }: MountArgs): Promise<MountResult> => {
    let filesystem;

    try {

        try {
            if (buffer) {
                console.debug(`Mounting filesystem snapshot at [${mountPoint}]...`, buffer);
                // Convert Node Buffer to ArrayBuffer if needed
                const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
                const aligned = uint8.byteOffset === 0 && uint8.byteLength === uint8.buffer.byteLength
                    ? uint8.buffer
                    : uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);

                await Snapshot.mount(new Uint8Array(aligned) as CborUint8Array<SnapshotNode>, {
                    // @ts-ignore
                    fs,
                });
            } else {
                console.debug('Getting storage directory...');
                // const handle = await navigator.storage.getDirectory();
                console.debug('Got storage directory');

                console.debug('Attempting to remove directory...');
                try {
                    // TODO: clear storage button
                    // @ts-ignore
                    // await handle.remove({ recursive: true });
                    console.debug('Successfully removed directory');
                } catch (removeErr) {
                    console.error('Error removing directory:', removeErr);
                    // Continue anyway, this might not be critical
                }
            }
            console.debug('Returning proxy from worker', fs);
            filesystem = Comlink.proxy({ fs });
            filesystems.push(filesystem);
        } catch (e) {
            console.error('Worker initialization failed with error:', e);
            throw e; // Make sure error propagates
        }
    } catch (e) {
        console.error('Error using memfs:', e);
    }
    console.debug('mounting fs', { buffer, mountPoint });
    return filesystem;
}

/**
 * Optimized mount function that loads snapshots directly from URLs.
 * This is much more efficient for large snapshots as it avoids transferring
 * data through the main thread.
 */
export const mountFromUrl = async ({ url, mountPoint = '/' }: {
    url: string;
    mountPoint?: string;
}): Promise<MountResult> => {
    let filesystem;

    try {
        console.debug(`Loading and mounting filesystem snapshot from URL: ${url} at [${mountPoint}]...`);
        const startTime = performance.now();
        await Snapshot.loadAndMount(url, {
            // @ts-ignore
            fs,
            path: mountPoint
        });

        const endTime = performance.now();
        console.debug(`Snapshot loaded and mounted in ${Math.round(endTime - startTime)}ms`);

        console.debug('Returning proxy from worker', fs);
        filesystem = Comlink.proxy({ fs });
        filesystems.push(filesystem);

    } catch (e) {
        console.error('Error loading snapshot from URL:', e);
        throw e;
    }

    return filesystem;
}

onconnect = async function (event) {
    const [port] = event.ports;
    console.debug('workers/fs connected on port: ', port);
    port.addEventListener('close', () => {
        console.debug('fs port closed')
    });
    Comlink.expose({ mount, mountFromUrl }, port);
}
