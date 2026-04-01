/**
 * TypeScript/JavaScript LSP SharedWorker.
 *
 * Receives a MessagePort connected to the fs SharedWorker's VFS
 * via a simple request/response protocol (no Comlink, to avoid
 * Firefox MessagePort bugs under high concurrency).
 */

import * as Comlink from 'comlink';
import { watchOptionsTransferHandler, asyncGeneratorTransferHandler } from '../rpc/serde';
import { createLanguageServer } from '../lsps/typescript';
import { createConnection } from 'vscode-languageserver/browser';
import { BrowserMessageReader, BrowserMessageWriter } from '@volar/language-server/browser';
import type { VfsInterface } from '../types';

Comlink.transferHandlers.set('asyncGenerator', asyncGeneratorTransferHandler);
Comlink.transferHandlers.set('watchOptions', watchOptionsTransferHandler);

/**
 * Create a VfsInterface from a MessagePort using a simple
 * request/response protocol: { id, method, args } → { id, result/error }
 *
 * This avoids Comlink's per-call MessageChannel creation which triggers
 * Firefox bugs (1756975, 1594984) under high concurrency.
 */
function createVfsFromPort(port: MessagePort): VfsInterface {
    port.start();
    let nextId = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

    port.addEventListener('message', (ev) => {
        const { id, result, error } = ev.data;
        const p = pending.get(id);
        if (p) {
            pending.delete(id);
            if (error) p.reject(new Error(error));
            else p.resolve(result);
        }
    });

    function call(method: string, ...args: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            port.postMessage({ id, method, args });
        });
    }

    return {
        readFile: (path: string) => call('readFile', path),
        writeFile: (path: string, data: string) => call('writeFile', path, data),
        mkdir: (path: string, options: any) => call('mkdir', path, options),
        readDir: (path: string) => call('readDir', path),
        exists: (path: string) => call('exists', path),
        stat: (path: string) => call('stat', path),
        unlink: (path: string) => call('unlink', path),
        watch: function* () { /* not needed for LSP */ } as any,
    };
}

onconnect = async (event) => {
    const [port] = event.ports;

    const { port1: lspPort, port2: clientLspPort } = new MessageChannel();
    lspPort.start();

    const reader = new BrowserMessageReader(lspPort);
    const writer = new BrowserMessageWriter(lspPort);
    const connection = createConnection(reader, writer);
    connection.listen();

    const factory = async (config: { fsPort: MessagePort; libFiles?: Record<string, string> }) => {
        const { fsPort, libFiles } = config;
        const fs = createVfsFromPort(fsPort);
        await createLanguageServer({ fs, connection, libFiles });
        return Comlink.transfer(clientLspPort, [clientLspPort]);
    };

    Comlink.expose({ createLanguageServer: factory }, port);
}
