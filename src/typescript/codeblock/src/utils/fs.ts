import { Fs } from "../types";
import * as Comlink from "comlink";
import { watchOptionsTransferHandler, asyncGeneratorTransferHandler } from "../rpc/serde";
import { FileSystem, FileType } from '@volar/language-service';
import { URI } from 'vscode-uri'
import type { mount, mountFromUrl } from '../workers/fs.worker';
import { CborUint8Array } from "@jsonjoy.com/json-pack/lib/cbor/types";
import { SnapshotNode } from "memfs/snapshot";
import { promises } from "node:fs";
import { FsApi } from "memfs/node/types";

Comlink.transferHandlers.set("asyncGenerator", asyncGeneratorTransferHandler);
Comlink.transferHandlers.set("watchOptions", watchOptionsTransferHandler);

export namespace CodeblockFS {

    // TODO: this is incorrect, fs is a Comlink proxy
    export const fromMemfs = (fs: FsApi): Fs => {
        return {
            async readFile(path: string): Promise<string> {
                return fs.promises.readFile(path, { encoding: "utf-8" }) as Promise<string>;
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

                console.log('readDir', { files })
                // @ts-expect-error

                return files.map((ent) => {
                    console.debug('readDir', { ent })
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
            }
        }
    }

    export const fromNodelike = (fs: typeof promises): Fs => {
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
            }
        }
    }

    /**
     * Create a filesystem worker with optional snapshot data.
     *
     * @param bufferOrUrl - Either a snapshot buffer or URL to a snapshot file.
     *                     If a URL is provided, it will be loaded directly in the worker
     *                     for better performance with large files.
     */
    export const worker = async (bufferOrUrl?: CborUint8Array<SnapshotNode> | string): Promise<Fs> => {
        const url = new URL('../workers/fs.worker.js', import.meta.url)
        console.log('Loading fs worker', url.href);
        const worker = new SharedWorker(url, { type: 'module' });
        worker.port.start()
        const proxy = Comlink.wrap<{ mount: typeof mount; mountFromUrl: typeof mountFromUrl }>(worker.port);

        let fs;

        if (!bufferOrUrl) {
            // No buffer or URL provided - create empty filesystem
            ({ fs } = await proxy.mount({ mountPoint: '/' }));
        } else if (typeof bufferOrUrl === 'string') {
            // URL provided - use optimized mountFromUrl for better performance
            ({ fs } = await proxy.mountFromUrl({
                url: bufferOrUrl,
                mountPoint: '/',
                useStreaming: true
            }));
        } else {
            // Buffer provided - use traditional mount method
            ({ fs } = await proxy.mount(Comlink.transfer({ buffer: bufferOrUrl, mountPoint: "/" }, [bufferOrUrl])));
        }
        return Comlink.proxy(CodeblockFS.fromMemfs(fs))
    }

    export async function* walk(fs: Fs, path: string): AsyncIterable<string> {
        const files = await fs.readDir(path);

        console.debug('walking', { path, files })

        for (const [filename, type] of files) {
            const joined = `${path === '/' ? '' : path}/${filename}`

            console.debug('walking', { joined, type })

            if (type === FileType.Directory) {
                yield* walk(fs, joined);
            } else {
                yield joined;
            }
        }
    }
}

export class VolarFs implements FileSystem {
    #fs: Fs

    constructor(fs: Fs) {
        this.#fs = fs
    }

    async stat(uri: URI) {
        return this.#fs.stat(uri.path);
    }
    async readDirectory(uri: URI) {
        return this.#fs.readDir(uri.path);
    }
    async readFile(uri: URI) {
        return this.#fs.readFile(uri.path);
    }
}