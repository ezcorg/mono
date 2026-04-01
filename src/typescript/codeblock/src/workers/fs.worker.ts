/**
 * Filesystem SharedWorker — single source of truth for all VFS operations.
 *
 * Both the main thread and the LSP worker communicate with this worker
 * via Comlink.  All reads, writes, chunk hydration, and OPFS access
 * happen here — neither the main thread nor the LSP worker touch OPFS
 * directly.
 */

import * as Comlink from "comlink";
import { watchOptionsTransferHandler, asyncGeneratorTransferHandler } from '../rpc/serde';
import { Vfs } from "../utils/fs";
import type { VfsInterface } from "../types";
import type { MountArgs } from "../types";

Comlink.transferHandlers.set('asyncGenerator', asyncGeneratorTransferHandler);
Comlink.transferHandlers.set('watchOptions', watchOptionsTransferHandler);

// The single VFS instance, shared by all consumers (main thread + LSP worker)
let sharedVfs: VfsInterface | null = null;

// The dedicated OPFS worker's message port (received from main thread
// or spawned locally if Worker constructor is available)
let opfsWorkerPort: MessagePort | Worker | null = null;

/** Check if OPFS is available in this worker context. */
function hasOpfs(): boolean {
    return typeof navigator !== 'undefined'
        && 'storage' in navigator
        && 'getDirectory' in navigator.storage;
}

/** Get or create the dedicated OPFS worker and initialize it with a bucket. */
async function getOpfsBacking(bucketName: string): Promise<VfsInterface> {
    const { OpfsVfs } = await import('../utils/opfs-vfs');

    if (!opfsWorkerPort) {
        // Try to spawn a dedicated Worker directly (works in Firefox SharedWorkers)
        // Chrome SharedWorkers don't have Worker constructor — in that case,
        // the main thread must provide the port via setOpfsWorkerPort().
        try {
            opfsWorkerPort = new Worker(new URL('./opfs.worker.js', import.meta.url), { type: 'module' });
        } catch {
            throw new Error('[fs.worker] No OPFS worker port available. Call setOpfsWorkerPort first.');
        }
    }

    const vfs = new OpfsVfs(opfsWorkerPort);
    await vfs.call('init', bucketName);
    return vfs;
}

/**
 * Provide a MessagePort connected to a dedicated OPFS worker.
 * Called by the main thread when the Worker constructor isn't
 * available in the SharedWorker context (Chrome).
 */
export const setOpfsWorkerPort = (port: MessagePort) => {
    port.start();
    opfsWorkerPort = port;
};

/**
 * Mount a persistent (OPFS) or in-memory filesystem.
 */
export const mount = async (opts: MountArgs & { name?: string } = {}) => {
    const { name = 'codeblock', buffer } = opts;

    if (hasOpfs()) {
        sharedVfs = await getOpfsBacking(name);
    } else {
        const { fs } = await import('@joinezco/memfs');
        sharedVfs = Vfs.fromMemfs(fs as any);
    }

    if (buffer) {
        try {
            const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            const aligned = uint8.byteOffset === 0 && uint8.byteLength === uint8.buffer.byteLength
                ? uint8.buffer
                : uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
            const snapshot = await decodeSnapshot(new Uint8Array(aligned));
            await hydrateFromSnapshot(sharedVfs, snapshot, '');
        } catch (e) {
            console.error('[fs.worker] Snapshot hydration failed:', e);
            throw e;
        }
    }

    return Comlink.proxy(sharedVfs);
}

/**
 * Mount from a URL (snapshot fetched directly in the worker).
 */
export const mountFromUrl = async (opts: { url: string; name?: string; mountPoint?: string }) => {
    const { url, name = 'codeblock' } = opts;

    if (hasOpfs()) {
        sharedVfs = await getOpfsBacking(name);
    } else {
        const { fs } = await import('@joinezco/memfs');
        sharedVfs = Vfs.fromMemfs(fs as any);
    }

    try {
        const startTime = performance.now();
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const snapshot = await decodeSnapshot(new Uint8Array(buf));
        await hydrateFromSnapshot(sharedVfs, snapshot, '');
        console.debug(`[fs.worker] Snapshot mounted in ${Math.round(performance.now() - startTime)}ms`);
    } catch (e) {
        console.error('[fs.worker] Error loading snapshot:', e);
        throw e;
    }

    return Comlink.proxy(sharedVfs);
}

/**
 * Mount a lazy-loading filesystem.  The LazyVfs, ChunkFetcher, and all
 * OPFS I/O run in the dedicated OPFS worker to avoid Firefox SharedWorker
 * event loop starvation.  This SharedWorker acts as a thin relay.
 */
export const mountLazy = async (opts: {
    manifestUrl: string;
    backingName?: string;
}) => {
    const { manifestUrl, backingName = 'codeblock-lazy' } = opts;
    const { OpfsVfs } = await import('../utils/opfs-vfs');

    if (!opfsWorkerPort) {
        try {
            opfsWorkerPort = new Worker(new URL('./opfs.worker.js', import.meta.url), { type: 'module' });
        } catch {
            throw new Error('[fs.worker] No OPFS worker port. Call setOpfsWorkerPort first.');
        }
    }
    const opfsVfs = new OpfsVfs(opfsWorkerPort);

    // Delegate everything to the OPFS worker: manifest loading, version
    // check, OPFS clearing, LazyVfs creation, chunk fetching, and hydration.
    await opfsVfs.call('mountLazy', { manifestUrl, backingName });

    // Create a thin VfsInterface that proxies through the OPFS worker's
    // lazy-aware methods (which go through LazyVfs in the dedicated worker).
    const lazyProxy: VfsInterface = {
        readFile: (path: string) => opfsVfs.call('lazyReadFile', path),
        writeFile: (path: string, data: string) => opfsVfs.call('writeFile', path, data),
        mkdir: (path: string, options: { recursive: boolean }) => opfsVfs.mkdir(path, options),
        readDir: (path: string) => opfsVfs.call('lazyReadDir', path),
        exists: (path: string) => opfsVfs.call('lazyExists', path),
        stat: (path: string) => opfsVfs.call('lazyStat', path),
        unlink: (path: string) => opfsVfs.call('unlink', path),
        watch: async function* () {},
    };

    sharedVfs = lazyProxy;
    return Comlink.proxy(sharedVfs);
}

/**
 * Get a MessagePort connected to the shared VFS via a simple
 * request/response protocol (NOT Comlink).
 *
 * Comlink creates a new MessageChannel per RPC call internally.
 * Firefox has unfixed bugs (1756975, 1594984) where MessagePort
 * messages are silently lost under high concurrency.  Using a
 * single stable port with manual request IDs avoids this.
 *
 * Protocol: { id, method, args } → { id, result } | { id, error }
 */
export const getVfsPort = () => {
    if (!sharedVfs) throw new Error('[fs.worker] No VFS mounted yet');
    const { port1, port2 } = new MessageChannel();
    port1.start();

    port1.addEventListener('message', async (ev) => {
        const { id, method, args } = ev.data;
        try {
            const fn = (sharedVfs as any)[method];
            if (typeof fn !== 'function') throw new Error(`Unknown VFS method: ${method}`);
            const result = await fn.apply(sharedVfs, args);
            port1.postMessage({ id, result: result ?? null });
        } catch (e: any) {
            port1.postMessage({ id, error: e?.message ?? String(e) });
        }
    });

    return Comlink.transfer(port2, [port2]);
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

async function decodeSnapshot(data: Uint8Array): Promise<any> {
    const { decompress, decoder } = await import('../utils/snapshot');
    const isGzip = data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
    const raw = isGzip ? await decompress(data) : data;
    return decoder.decode(raw);
}

async function hydrateFromSnapshot(vfs: VfsInterface, node: any, path: string): Promise<void> {
    const [type, _meta, data] = node;
    if (type === 0) {
        if (path) await vfs.mkdir(path, { recursive: true }).catch(() => {});
        for (const [name, child] of Object.entries(data as Record<string, any>)) {
            await hydrateFromSnapshot(vfs, child, path ? `${path}/${name}` : name);
        }
    } else if (type === 1) {
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir) await vfs.mkdir(dir, { recursive: true }).catch(() => {});
        await vfs.writeFile(path, new TextDecoder().decode(data as Uint8Array));
    }
}

// SharedWorker connection handler
onconnect = async function (event) {
    const [port] = event.ports;
    Comlink.expose({ mount, mountFromUrl, mountLazy, getVfsPort, setOpfsWorkerPort }, port);
}
