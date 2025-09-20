import { VfsInterface } from "../types";
import * as Comlink from "comlink";
import { watchOptionsTransferHandler, asyncGeneratorTransferHandler } from "../rpc/serde";
import { FileSystem, FileType } from '@volar/language-service';
import { URI } from 'vscode-uri'
import type { mount, mountFromUrl } from '../workers/fs.worker';
import { CborUint8Array } from "@jsonjoy.com/json-pack/lib/cbor/types";
import { SnapshotNode } from "@ezdevlol/memfs/snapshot";
import { promises } from "node:fs";
import type { FsApi } from "@ezdevlol/memfs/node/types";
import { TopLevelFs } from "@ezdevlol/jswasi/filesystem";
import { constants } from "@ezdevlol/jswasi";

Comlink.transferHandlers.set("asyncGenerator", asyncGeneratorTransferHandler);
Comlink.transferHandlers.set("watchOptions", watchOptionsTransferHandler);

export namespace Vfs {
    export const fromJswasiFs = async (jswasiFs: TopLevelFs): Promise<VfsInterface> => {
        // Map WASI filetype to @volar/language-service FileType
        const toVolarFileType = (filetype: number): FileType => {
            // WASI preview1 common values: 3 = directory, 4 = regular file, 7 = symlink
            switch (filetype) {
                case 3: return FileType.Directory;
                case 7: return FileType.SymbolicLink;
                default: return FileType.File;
            }
        };

        // Normalize to absolute path for TopLevelFs
        const ensureAbs = (p: string) => (p && p.startsWith("/")) ? p : `/${p ?? ""}`;

        // Pull constants if available (fall back to literals when missing)
        const WASI_ESUCCESS = constants.WASI_ESUCCESS ?? 0;
        const WASI_EEXIST = constants.WASI_EEXIST ?? 20;
        const WASI_O_TRUNC = constants.WASI_O_TRUNC ?? 0x00000010;
        const WASI_O_CREAT = constants.WASI_O_CREAT ?? 0x00000001;
        const WASI_O_DIRECTORY = constants.WASI_O_DIRECTORY ?? 0x00020000;

        return {
            async readFile(path: string): Promise<string> {
                const abs = ensureAbs(path);
                const { desc, err } = await jswasiFs.open(abs);
                if (err !== WASI_ESUCCESS) throw new Error(`readFile open failed (${err}) for ${abs}`);
                const { content, err: readErr } = await desc.read_str();
                if (readErr !== WASI_ESUCCESS) throw new Error(`readFile read_str failed (${readErr}) for ${abs}`);
                desc.close(); // Close after reading
                return content;
            },

            async writeFile(path: string, data: string): Promise<void> {
                const abs = ensureAbs(path);
                const { desc, err } = await jswasiFs.open(abs, 0, WASI_O_CREAT | WASI_O_TRUNC);
                if (err !== WASI_ESUCCESS) throw new Error(`writeFile open failed (${err}) for ${abs}`);
                const encoder = new TextEncoder();
                const buf = encoder.encode(data);
                const { err: writeErr } = await desc.pwrite(buf.buffer, 0n);
                desc.close(); // Close after writing
                if (writeErr !== WASI_ESUCCESS) throw new Error(`writeFile pwrite failed (${writeErr}) for ${abs}`);
            },

            async *watch(_path: string, { signal }: { signal: AbortSignal }) {
                return jswasiFs.watch(_path, { signal })
            },

            async mkdir(path: string, options: { recursive: boolean }): Promise<void> {
                const abs = ensureAbs(path);
                if (options?.recursive) {
                    const parts = abs.split("/").filter(Boolean);
                    let cur = "/";
                    for (const part of parts) {
                        cur = cur === "/" ? `/${part}` : `${cur}/${part}`;
                        console.log('creating', { cur, abs });

                        const exists = await this.exists(cur);
                        if (exists) continue;

                        const res = await jswasiFs.createDir(cur);
                        if (res !== WASI_ESUCCESS && res !== WASI_EEXIST) {
                            throw new Error(`mkdir recursive failed (${res}) at ${cur}`);
                        }
                    }
                } else {
                    const res = await jswasiFs.createDir(abs);
                    if (res !== WASI_ESUCCESS) {
                        throw new Error(`mkdir failed (${res}) for ${abs}`);
                    }
                }
            },

            async readDir(path: string): Promise<[string, FileType][]> {
                const abs = ensureAbs(path);
                const { desc, err } = await jswasiFs.open(abs, 0, WASI_O_DIRECTORY);
                if (err !== WASI_ESUCCESS) throw new Error(`readDir open failed (${err}) for ${abs}`);
                const { err: rerr, dirents } = await desc.readdir(true);
                if (rerr !== WASI_ESUCCESS) throw new Error(`readDir readdir failed (${rerr}) for ${abs}`);

                return dirents.map((d) => [d.name, toVolarFileType(d.d_type)] as [string, FileType]);
            },

            async exists(path: string): Promise<boolean> {
                const abs = ensureAbs(path);
                const { desc, err } = await jswasiFs.open(abs);
                if (err !== WASI_ESUCCESS) return false;
                const stat = await desc.getFilestat();
                desc.close(); // Close after getting file status
                return stat.err === WASI_ESUCCESS;
            },

            async stat(path: string) {
                const abs = ensureAbs(path);
                const { desc, err } = await jswasiFs.open(abs);
                if (err !== WASI_ESUCCESS) return null;
                const res = await desc.getFilestat();
                desc.close(); // Close after getting file status
                if (res.err !== WASI_ESUCCESS) return null;
                const filestat = res.filestat;
                // filestat times are typically in ns; convert to ms for Date
                const nsToDate = (ns: bigint) => new Date(Number(ns / 1000000n));
                return {
                    name: abs,
                    atime: nsToDate(filestat.atim),
                    mtime: nsToDate(filestat.mtim),
                    ctime: nsToDate(filestat.ctim),
                    size: Number(filestat.size),
                    type: toVolarFileType(filestat.filetype),
                };
            },
        } as VfsInterface;
    }

    // TODO: this is incorrect, fs is a Comlink proxy
    export const fromMemfs = (fs: FsApi): VfsInterface => {
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
            }
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
    export const worker = async (bufferOrUrl?: CborUint8Array<SnapshotNode> | string): Promise<VfsInterface> => {
        const url = new URL('../workers/fs.worker.js', import.meta.url)
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
                mountPoint: '/'
            }));
        } else {
            // Buffer provided - use traditional mount method
            ({ fs } = await proxy.mount(Comlink.transfer({ buffer: bufferOrUrl, mountPoint: "/" }, [bufferOrUrl])));
        }
        return Comlink.proxy(Vfs.fromMemfs(fs))
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

    constructor(fs: VfsInterface) {
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