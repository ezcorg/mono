import { VfsInterface } from "../types";
import * as Comlink from 'comlink';
import { LSPClient, languageServerExtensions } from "@codemirror/lsp-client";
import { Extension } from "@codemirror/state";
import { messagePortTransport } from "../rpc/transport";
import { typeSignatureRenderer } from "../completions/type-signature";

const clients: Map<string, LSPClient> = new Map();

// FileChangeType from LSP spec
export const FileChangeType = { Created: 1, Changed: 2, Deleted: 3 } as const;

// LSP log buffer
export interface LspLogEntry {
    timestamp: number;
    level: 'error' | 'warn' | 'info' | 'log';
    message: string;
}

const MAX_LOG_ENTRIES = 200;
const lspLogBuffer: LspLogEntry[] = [];
const lspLogListeners: Set<() => void> = new Set();

export namespace LspLog {
    export function entries(): readonly LspLogEntry[] {
        return lspLogBuffer;
    }
    export function push(level: LspLogEntry['level'], message: string) {
        lspLogBuffer.push({ timestamp: Date.now(), level, message });
        if (lspLogBuffer.length > MAX_LOG_ENTRIES) {
            lspLogBuffer.splice(0, lspLogBuffer.length - MAX_LOG_ENTRIES);
        }
        for (const listener of lspLogListeners) listener();
    }
    export function clear() {
        lspLogBuffer.length = 0;
        for (const listener of lspLogListeners) listener();
    }
    export function subscribe(fn: () => void) {
        lspLogListeners.add(fn);
        return () => { lspLogListeners.delete(fn); };
    }
}

export type ClientOptions = {
    language: string,
    path: string,
    fs: VfsInterface,
    libFiles?: Record<string, string>,
}

// Cached factory and LSP port per language
type WorkerFactory = (config: { fsPort: MessagePort; libFiles?: Record<string, string> }) => Promise<MessagePort>;
const languageServerFactory: Map<string, WorkerFactory> = new Map();
const lspPorts: Map<string, MessagePort> = new Map();
export const lspWorkers: Map<string, SharedWorker> = new Map()

// Cache initialization promises to prevent concurrent calls from creating
// duplicate LSP clients for the same language (race condition).
const clientInitPromises: Map<string, Promise<LSPClient | null>> = new Map();

export namespace LSP {
    export async function worker(language: string, fs: VfsInterface, libFiles?: Record<string, string>): Promise<{ worker: SharedWorker, lspPort: MessagePort } | null> {
        let factory: WorkerFactory | undefined;
        let w: SharedWorker | undefined;

        switch (language) {
            case 'javascript':
            case 'typescript':
                factory = languageServerFactory.get('javascript');
                w = lspWorkers.get('javascript');

                if (!factory) {
                    w = new SharedWorker(new URL('../workers/javascript.worker.js', import.meta.url), { type: 'module' });
                    w.port.start();
                    lspWorkers.set('javascript', w);
                    const wrapped = Comlink.wrap<{ createLanguageServer: WorkerFactory }>(w.port);
                    factory = wrapped.createLanguageServer;
                    languageServerFactory.set('javascript', factory);
                }
                break;
            default:
                return null;
        }

        // Get a port connected to the fs SharedWorker's VFS and transfer
        // it to the LSP worker so it can read files without proxying
        // through the main thread.
        let fsPort: MessagePort;
        try {
            const { Vfs } = await import('./fs');
            fsPort = await Vfs.getVfsPort();
        } catch (e) {
            console.warn('[lsp] getVfsPort failed, falling back to main-thread proxy:', e);
            const { port1, port2 } = new MessageChannel();
            Comlink.expose(fs, port1);
            fsPort = port2;
        }

        const lspPort = await factory!(Comlink.transfer({ fsPort, libFiles }, [fsPort]));
        lspPort.start();
        lspPorts.set(language, lspPort);
        return { worker: w!, lspPort };
    }

    export async function client({ language, path, fs, libFiles }: ClientOptions): Promise<Extension | null> {
        const uri = `file:///${path}`;

        // Use a cached promise to ensure only one LSPClient is created per language,
        // even when multiple codeblocks call client() concurrently.
        let initPromise = clientInitPromises.get(language);
        if (!initPromise) {
            initPromise = (async () => {
                const result = await LSP.worker(language, fs, libFiles);
                if (!result) return null;
                const { lspPort } = result;

                const tsRenderer = typeSignatureRenderer();
                const lspClient = new LSPClient({
                    rootUri: 'file:///',
                    timeout: 30000,
                    extensions: languageServerExtensions({
                        completion: { addToOptions: tsRenderer.addToOptions },
                    }),
                    notificationHandlers: {
                        "window/logMessage": (_client, params: { type: number; message: string }) => {
                            const level = params.type === 1 ? 'error' : params.type === 2 ? 'warn' : params.type === 3 ? 'info' : 'log';
                            LspLog.push(level, params.message);
                            return false; // fall through to default handler (console)
                        }
                    },
                });
                lspClient.connect(messagePortTransport(lspPort));
                clients.set(language, lspClient);
                return lspClient;
            })();
            clientInitPromises.set(language, initPromise);
        }

        const client = await initPromise;
        if (!client) return null;
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
