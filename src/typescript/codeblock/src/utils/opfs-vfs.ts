/**
 * VfsInterface backed by the dedicated OPFS worker.
 *
 * All operations are forwarded to the opfs.worker via postMessage
 * using a simple request/response protocol with numeric IDs.
 */

import type { VfsInterface } from "../types";
import { FileType } from "@volar/language-service";

export class OpfsVfs implements VfsInterface {
    private port: Worker | MessagePort;
    private nextId = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

    constructor(port: Worker | MessagePort) {
        this.port = port;
        this.port.addEventListener('message', ((ev: MessageEvent) => {
            const { id, result, error } = ev.data;
            const p = this.pending.get(id);
            if (p) {
                this.pending.delete(id);
                if (error) p.reject(new Error(error));
                else p.resolve(result);
            }
        }) as EventListener);
    }

    call(method: string, ...args: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.nextId++;
            this.pending.set(id, { resolve, reject });
            this.port.postMessage({ id, method, args });
        });
    }

    async readFile(path: string): Promise<string> {
        return this.call('readFile', path);
    }

    async writeFile(path: string, data: string): Promise<void> {
        return this.call('writeFile', path, data);
    }

    async mkdir(path: string, options: { recursive: boolean }): Promise<void> {
        if (options?.recursive) {
            // Create each segment since the OPFS worker's mkdir is single-level
            const normalized = path.replace(/^\//, '');
            const parts = normalized.split('/').filter(Boolean);
            for (let i = 0; i < parts.length; i++) {
                await this.call('mkdir', parts.slice(0, i + 1).join('/'));
            }
        } else {
            return this.call('mkdir', path);
        }
    }

    async readDir(path: string): Promise<[string, FileType][]> {
        const entries: [string, number][] = await this.call('readDir', path);
        return entries.map(([name, type]) => [name, type as FileType]);
    }

    async exists(path: string): Promise<boolean> {
        return this.call('exists', path);
    }

    async stat(path: string): Promise<any> {
        const result = await this.call('stat', path);
        if (!result) return null;
        return {
            type: result.type as FileType,
            size: result.size,
            ctime: 0,
            mtime: 0,
        };
    }

    async unlink(path: string): Promise<void> {
        return this.call('unlink', path);
    }

    async *watch(): AsyncGenerator<any> {
        // Not implemented for OPFS worker
    }
}
