import { VfsInterface } from "../types";
import * as Comlink from "comlink";
import { watchOptionsTransferHandler, asyncGeneratorTransferHandler } from "../rpc/serde";
import { FileSystem, FileType } from '@volar/language-service';
import { URI } from 'vscode-uri';
import { CborUint8Array } from "@jsonjoy.com/json-pack/lib/cbor/types";
import { SnapshotNode } from "@joinezco/memfs/snapshot";
import { promises } from "node:fs";
import type { FsApi } from "@joinezco/memfs/node/types";

Comlink.transferHandlers.set("asyncGenerator", asyncGeneratorTransferHandler);
Comlink.transferHandlers.set("watchOptions", watchOptionsTransferHandler);

export namespace Vfs {
    export const fromMemfs = (fs: FsApi): VfsInterface => {
        return {
            async readFile(path: string): Promise<string> {
                const result = await fs.promises.readFile(path, { encoding: "utf-8" });
                // memfs may return a Buffer — ensure we return a string
                if (typeof result === 'string') return result;
                if (result && typeof (result as any).toString === 'function') return (result as any).toString('utf-8');
                return String(result ?? '');
            },

            async writeFile(path: string, data: string): Promise<void> {
                await fs.promises.writeFile(path, data);
            },

            async *watch(path: string, { signal }: { signal: AbortSignal }) {
                for await (const e of await fs.promises.watch(path, { signal, encoding: "utf-8", recursive: true })) {
                    yield e as { eventType: "rename" | "change"; filename: string };
                }
            },

            async mkdir(path: string, options: { recursive: boolean }): Promise<void> {
                await fs.promises.mkdir(path, options);
            },

            async readDir(path: string): Promise<[string, FileType][]> {
                const files = await fs.readdirSync(path, { withFileTypes: true, encoding: "utf-8" });
                // @ts-expect-error

                return files.map((ent) => {
                    let type = FileType.File;
                    switch ((ent.mode as number) & 0o170000) {
                        case 0o040000:
                            type = FileType.Directory;
                            break;
                        case 0o120000:
                            type = FileType.SymbolicLink;
                            break;
                    }
                    return [ent.name, type];
                });
            },

            async exists(path: string): Promise<boolean> {
                return fs.existsSync(path);
            },

            async stat(path: string) {
                try {
                    const stat = await fs.promises.stat(path);
                    let type = FileType.File;

                    switch ((stat.mode as number) & 0o170000) {
                        case 0o040000:
                            type = FileType.Directory;
                            break;
                        case 0o120000:
                            type = FileType.SymbolicLink;
                            break;
                    }
                    // console.debug(`Stat success "${path}"`);
                    return {
                        name: path,
                        atime: stat.atime,
                        mtime: stat.mtime,
                        ctime: stat.ctime,
                        size: stat.size,
                        type,
                    };
                } catch (err) {
                    return null;
                }
            },

            async unlink(path: string): Promise<void> {
                await fs.promises.unlink(path);
            },
        }
    }

    export const fromNodelike = (fs: typeof promises): VfsInterface => {
        return {
            async readFile(path: string): Promise<string> {
                return fs.readFile(path, { encoding: "utf-8" });
            },

            async writeFile(path: string, data: string): Promise<void> {
                await fs.writeFile(path, data);
            },

            async *watch(path: string, { signal }: { signal: AbortSignal }) {
                for await (const e of await fs.watch(path, { signal, encoding: "utf-8", recursive: true })) {
                    yield e as { eventType: "rename" | "change"; filename: string };
                }
            },

            async mkdir(path: string, options: { recursive: boolean }): Promise<void> {
                await fs.mkdir(path, options);
            },

            async readDir(path: string): Promise<[string, FileType][]> {
                const files = await fs.readdir(path, { withFileTypes: true, encoding: "utf-8" });
                return files.map((ent: any) => {
                    let type = FileType.File;
                    switch ((ent.stats.mode as number) & 0o170000) {
                        case 0o040000:
                            type = FileType.Directory;
                            break;
                        case 0o120000:
                            type = FileType.SymbolicLink;
                            break;
                    }
                    return [ent.path, type];
                });
            },

            async exists(path: string): Promise<boolean> {
                try {
                    await fs.access(path);
                    return true;
                } catch {
                    return false;
                }
            },

            async stat(path: string) {
                try {
                    const stat = await fs.stat(path);
                    let type = FileType.File;

                    switch ((stat.mode as number) & 0o170000) {
                        case 0o040000:
                            type = FileType.Directory;
                            break;
                        case 0o120000:
                            type = FileType.SymbolicLink;
                            break;
                    }
                    // console.debug(`Stat success "${path}"`);
                    return {
                        name: path,
                        atime: stat.atime,
                        mtime: stat.mtime,
                        ctime: stat.ctime,
                        size: stat.size,
                        type,
                    };
                } catch (err) {
                    return null;
                }
            },

            async unlink(path: string): Promise<void> {
                await fs.unlink(path);
            },
        }
    }

    /**
     * Create a filesystem worker with optional snapshot data.
     *
     * @param bufferOrUrl - Either a snapshot buffer or URL to a snapshot file.
     *                     If a URL is provided, it will be loaded directly in the worker
     *                     for better performance with large files.
     */
    // Reference to the fs SharedWorker proxy (shared across all consumers)
    type FsWorkerProxy = {
        mount: (args: any) => Promise<VfsInterface>;
        mountFromUrl: (args: any) => Promise<VfsInterface>;
        getVfsPort: () => Promise<MessagePort>;
        setOpfsWorkerPort: (port: MessagePort) => void;
    };
    let fsWorkerProxy: Comlink.Remote<FsWorkerProxy> | null = null;

    function getFsWorkerProxy(): Comlink.Remote<FsWorkerProxy> {
        if (!fsWorkerProxy) {
            const w = new SharedWorker(new URL('../workers/fs.worker.js', import.meta.url), { type: 'module' });
            w.port.start();
            fsWorkerProxy = Comlink.wrap<FsWorkerProxy>(w.port);

            // Create the dedicated OPFS worker on the main thread and
            // give the SharedWorker a direct MessagePort to it.  Chrome
            // doesn't allow Worker construction inside SharedWorkers.
            const opfsWorker = new Worker(new URL('../workers/opfs.worker.js', import.meta.url), { type: 'module' });
            const { port1, port2 } = new MessageChannel();
            // Send port1 to the OPFS dedicated worker
            opfsWorker.postMessage({ type: 'init-port', port: port1 }, [port1]);
            // Send port2 to the SharedWorker
            fsWorkerProxy.setOpfsWorkerPort(Comlink.transfer(port2, [port2]));
        }
        return fsWorkerProxy;
    }

    /**
     * Get a MessagePort connected to the shared VFS in the fs worker.
     * This port can be transferred to another worker (e.g., the LSP
     * worker) so it can read/write files without proxying through the
     * main thread.
     */
    export const getVfsPort = async (): Promise<MessagePort> => {
        return getFsWorkerProxy().getVfsPort();
    }

    /**
     * Create a VFS backed by a SharedWorker.  All filesystem I/O runs off
     * the main thread.  Uses OPFS for persistence when available, falls
     * back to in-memory memfs otherwise.
     *
     * @param bufferOrUrl Optional snapshot buffer or URL to hydrate
     * @param name        OPFS bucket name (default: 'codeblock')
     */
    export const worker = async (bufferOrUrl?: CborUint8Array<SnapshotNode> | string, name = 'codeblock'): Promise<VfsInterface> => {
        const proxy = getFsWorkerProxy();

        let vfs: VfsInterface;

        if (!bufferOrUrl) {
            vfs = await proxy.mount({ name });
        } else if (typeof bufferOrUrl === 'string') {
            vfs = await proxy.mountFromUrl({ url: bufferOrUrl, name });
        } else {
            vfs = await proxy.mount(Comlink.transfer({ buffer: bufferOrUrl, name }, [bufferOrUrl]));
        }
        console.debug('Filesystem worker mounted');
        return vfs;
    }

    export async function* walk(fs: VfsInterface, path: string): AsyncIterable<string> {
        const files = await fs.readDir(path);

        for (const [filename, type] of files) {
            const joined = `${path === '/' ? '' : path}/${filename}`

            if (type === FileType.Directory) {
                yield* walk(fs, joined);
            } else {
                yield joined;
            }
        }
    }
}

export class VolarFs implements FileSystem {
    #fs: VfsInterface
    #fileCache = new Map<string, string>()
    #fileCacheBytes = 0
    #statCache = new Map<string, { type: FileType; ctime: number; mtime: number; size: number }>()
    #dirCache = new Map<string, [string, FileType][]>()

    /** Approximate memory limit for #fileCache (~64 MB). */
    static readonly FILE_CACHE_LIMIT = 64 * 1024 * 1024;

    constructor(fs: VfsInterface) {
        this.#fs = fs
    }

    /** Estimated bytes per character (V8 uses UTF-16 = 2 bytes per char). */
    static #charBytes(content: string): number {
        return content.length * 2;
    }

    /** Insert or refresh a file in the LRU cache, evicting if over limit. */
    #cacheFile(path: string, content: string): void {
        // If already present, remove first so re-insertion moves it to end (LRU)
        const existing = this.#fileCache.get(path);
        if (existing !== undefined) {
            this.#fileCacheBytes -= VolarFs.#charBytes(existing);
            this.#fileCache.delete(path);
        }

        const bytes = VolarFs.#charBytes(content);
        this.#fileCache.set(path, content);
        this.#fileCacheBytes += bytes;

        // Evict oldest entries until under limit
        while (this.#fileCacheBytes > VolarFs.FILE_CACHE_LIMIT && this.#fileCache.size > 1) {
            const oldest = this.#fileCache.keys().next().value!;
            const oldContent = this.#fileCache.get(oldest)!;
            this.#fileCacheBytes -= VolarFs.#charBytes(oldContent);
            this.#fileCache.delete(oldest);
        }
    }

    /**
     * Synchronously populate the cache from a pre-resolved map of path → content.
     * This bypasses async VFS reads entirely, ensuring TypeScript gets lib files
     * immediately on first program creation.
     */
    preloadFromMap(files: Record<string, string>): void {
        const now = Date.now();
        for (const [path, content] of Object.entries(files)) {
            this.#cacheFile(path, content);
            this.#statCache.set(path, {
                type: FileType.File,
                ctime: now,
                mtime: now,
                size: content.length,
            });
        }
        // Build directory tree from file paths
        const dirChildren = new Map<string, Map<string, FileType>>();
        for (const path of Object.keys(files)) {
            let dir = path;
            let child = '';
            while (true) {
                const lastSlash = dir.lastIndexOf('/');
                if (lastSlash < 0) break;
                child = dir.substring(lastSlash + 1);
                dir = dir.substring(0, lastSlash) || '/';

                if (!dirChildren.has(dir)) {
                    dirChildren.set(dir, new Map());
                }
                const children = dirChildren.get(dir)!;
                // First encounter of this child — it's the file itself
                if (!children.has(child)) {
                    // If we've already seen this as a parent dir, it's a Directory
                    children.set(child, dirChildren.has(dir === '/' ? `/${child}` : `${dir}/${child}`) ? FileType.Directory : FileType.File);
                }
                if (dir === '/') break;
            }
        }
        // Update directory type for children that are actually directories
        for (const [dirPath, children] of dirChildren) {
            for (const [name] of children) {
                const fullPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
                if (dirChildren.has(fullPath)) {
                    children.set(name, FileType.Directory);
                }
            }
        }
        // Cache directory listings and stats
        for (const [dirPath, children] of dirChildren) {
            this.#dirCache.set(dirPath, [...children.entries()]);
            this.#statCache.set(dirPath, {
                type: FileType.Directory,
                ctime: now,
                mtime: now,
                size: 0,
            });
        }
    }

    stat(uri: URI) {
        const cached = this.#statCache.get(uri.path);
        if (cached) return cached;
        return this.#fs.stat(uri.path);
    }
    readDirectory(uri: URI) {
        // Only use dirCache for node_modules subtree (stable, preloaded).
        // Root and user directories must go through live VFS to pick up new files.
        if (uri.path.startsWith('/node_modules/')) {
            const cached = this.#dirCache.get(uri.path);
            if (cached) return cached;
        }
        return this.#fs.readDir(uri.path);
    }
    readFile(uri: URI): string | Promise<string> {
        const cached = this.#fileCache.get(uri.path);
        if (cached !== undefined) {
            // Touch: move to end of LRU
            this.#fileCache.delete(uri.path);
            this.#fileCache.set(uri.path, cached);
            return cached;
        }
        // Cache miss — read from VFS and cache the result.
        // Always wrap in Promise.resolve() to normalize Comlink proxy
        // thenables into real Promises. This is critical because Volar's
        // fileSystem cache stores the raw return value — a Comlink proxy
        // thenable behaves differently from a real Promise when cached
        // (proxy property access creates new proxies on every access).
        const result = this.#fs.readFile(uri.path);
        return Promise.resolve(result).then(content => {
            this.#cacheFile(uri.path, content);
            return content;
        });
    }

    getCacheSize(): number {
        return this.#fileCache.size;
    }

    getCacheSizeBytes(): number {
        return this.#fileCacheBytes;
    }
}