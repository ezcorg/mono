import { mount as _mount, promises as fs, resolveMountConfig, SingleBuffer, umount } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";
import * as Comlink from "comlink";
import { watchOptionsTransferHandler, asyncGeneratorTransferHandler } from '../rpc/serde';
import { MountArgs, MountResult } from "../types";

Comlink.transferHandlers.set('asyncGenerator', asyncGeneratorTransferHandler)
Comlink.transferHandlers.set('watchOptions', watchOptionsTransferHandler)

let fsProxy: any;

const mount = async ({ buffer = new ArrayBuffer(0x100000), mountPoint = '/' }: MountArgs): Promise<MountResult> => {
    console.log('mounting fs', { buffer, mountPoint });

    if (!fsProxy) {
        try {
            console.log('Getting storage directory...');
            const handle = await navigator.storage.getDirectory();
            console.log('Got storage directory');

            console.log('Attempting to remove directory...');
            try {
                // TODO: clear storage button
                // @ts-ignore
                // await handle.remove({ recursive: true });
                console.log('Successfully removed directory');
            } catch (removeErr) {
                console.error('Error removing directory:', removeErr);
                // Continue anyway, this might not be critical
            }
            console.log(`Mounting filesystem at [${mountPoint}]...`, buffer);
            const readable = await resolveMountConfig({
                backend: SingleBuffer,
                buffer,
            })
            const writable = await resolveMountConfig({
                backend: WebAccess,
                handle,
            })
            umount('/')
            _mount('/mnt/snapshot', readable);
            _mount('/', writable);
            await readable.ready()
            await writable.sync()

            await fs.cp('/mnt/snapshot', '/', { recursive: true, force: true })
            umount('/mnt/snapshot')
            console.log('Returning proxy from worker', fs);
            fsProxy = Comlink.proxy({ fs });
        } catch (e) {
            console.error('Worker initialization failed with error:', e);
            throw e; // Make sure error propagates
        }
    }
    return fsProxy
}

onconnect = async function (event) {
    const [port] = event.ports;
    console.log('workers/fs connected on port: ', port);
    port.addEventListener('close', () => {
        console.log('fs port closed')
    });
    Comlink.expose({ mount }, port);
}
