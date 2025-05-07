import type { Dirent } from "@zenfs/core";
import { Fs, FsMountOptions, MountResult } from "../types";
import * as Comlink from "comlink";
import { watchOptionsTransferHandler, asyncGeneratorTransferHandler } from "../rpc/serde";
import { FileSystem, FileType } from '@volar/language-service';
import { promises as _fs } from "@zenfs/core";
import { URI } from 'vscode-uri'

Comlink.transferHandlers.set("asyncGenerator", asyncGeneratorTransferHandler);
Comlink.transferHandlers.set("watchOptions", watchOptionsTransferHandler);

export namespace CodeblockFS {

    export const fromNodelike = (fs: typeof _fs): Fs => {
        return {
            async readFile(path: string): Promise<string> {
                return await fs.readFile(path, { encoding: "utf-8" });
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
                const files = await fs.readdir(path, { withFileTypes: true, encoding: "utf-8" }) as Dirent[];
                return files.map((ent: Dirent) => {
                    let type = FileType.File;
                    // @ts-expect-error
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
                return await fs.exists(path);
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

    export const fromSnapshot = async (snapshot: ArrayBuffer): Promise<Fs> => {
        const url = new URL('../workers/fs.worker.js', import.meta.url)
        const worker = new SharedWorker(url, { type: 'module' });
        worker.port.start()
        const proxy = Comlink.wrap<FsMountOptions>(worker.port);
        let { fs }: MountResult = await proxy.mount({ fsBuffer: snapshot });
        return CodeblockFS.fromNodelike(Comlink.proxy(fs))
    }

    export async function* walk(fs: Fs, path: string): AsyncIterable<string> {
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