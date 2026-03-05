import { VfsInterface } from "../types";
import * as Comlink from 'comlink';
import { LSPClient, languageServerExtensions } from "@codemirror/lsp-client";
import { Extension } from "@codemirror/state";
import { messagePortTransport } from "../rpc/transport";

const clients: Map<string, LSPClient> = new Map();

// FileChangeType from LSP spec
export const FileChangeType = { Created: 1, Changed: 2, Deleted: 3 } as const;

export type ClientOptions = {
    language: string,
    path: string,
    fs: VfsInterface
    libFiles?: Record<string, string>
}

// Cached factory (Comlink-wrapped) and LSP port per language
const languageServerFactory: Map<string, (fs: VfsInterface, libFiles?: Record<string, string>) => Promise<MessagePort>> = new Map();
const lspPorts: Map<string, MessagePort> = new Map();
export const lspWorkers: Map<string, SharedWorker> = new Map()

export namespace LSP {
    export async function worker(language: string, fs: VfsInterface, libFiles?: Record<string, string>): Promise<{ worker: SharedWorker, lspPort: MessagePort } | null> {
        let factory: ((fs: VfsInterface, libFiles?: Record<string, string>) => Promise<MessagePort>) | undefined;
        let worker: SharedWorker | undefined;

        switch (language) {
            case 'javascript':
            case 'typescript':
                factory = languageServerFactory.get('javascript')
                worker = lspWorkers.get('javascript')

                if (!factory) {
                    worker = new SharedWorker(new URL('../workers/javascript.worker.js', import.meta.url), { type: 'module' });
                    worker.port.start();
                    lspWorkers.set('javascript', worker)
                    const wrapped = Comlink.wrap<{ createLanguageServer: (fs: VfsInterface, libFiles?: Record<string, string>) => Promise<MessagePort> }>(worker.port);
                    factory = wrapped.createLanguageServer
                    languageServerFactory.set('javascript', factory)
                }
                break;
            default:
                return null;
        }
        // fs is proxied (has methods), libFiles is plain data (structured clone)
        // The factory returns a MessagePort for the LSP connection (separate from Comlink's port)
        const lspPort = await factory!(Comlink.proxy(fs), libFiles);
        lspPort.start();
        lspPorts.set(language, lspPort);
        return { worker: worker!, lspPort }
    }

    export async function client({ fs, language, path, libFiles }: ClientOptions): Promise<Extension | null> {
        let client = clients.get(language);
        const uri = `file:///${path}`;

        if (!client) {
            const result = await LSP.worker(language, fs, libFiles);
            if (!result) return null;
            const { lspPort } = result;

            client = new LSPClient({
                rootUri: 'file:///',
                extensions: languageServerExtensions(),
            });
            client.connect(messagePortTransport(lspPort));
            clients.set(language, client);
        }

        return client.plugin(uri, language);
    }

    /**
     * Notify all connected LSP clients that a file was created, changed, or deleted.
     * This sends workspace/didChangeWatchedFiles so the server re-evaluates the project.
     */
    export function notifyFileChanged(path: string, type: number = FileChangeType.Changed) {
        const uri = `file:///${path}`;
        for (const client of clients.values()) {
            client.notification("workspace/didChangeWatchedFiles", {
                changes: [{ uri, type }]
            });
        }
    }
}
