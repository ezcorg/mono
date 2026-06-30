import { VfsInterface } from "../types";
import * as Comlink from 'comlink';
import { LSPClient, languageServerExtensions, type Transport } from "@codemirror/lsp-client";
import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { messagePortTransport } from "../rpc/transport";
import { openFileEffect, currentFileField } from "../editor";

const clients: Map<string, LspHandle> = new Map();

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

// ── Pluggable language servers ──────────────────────────────────────────────
//
// A code block's LSP can be served two ways:
//   1. An IN-BROWSER server (the built-in Volar TypeScript worker) — `LSP.worker`.
//   2. A REMOTE server reached over some transport (e.g. rust-analyzer spawned on a
//      host and bridged over icanhaz/wRPC) — supplied by a `RemoteLspProvider`.
//
// Both drive the same `@codemirror/lsp-client` `LSPClient`; they differ only in how
// the transport is obtained and in the workspace/URI model (a remote native server
// reads real host paths, not the in-browser virtual FS). A provider is *injected*
// by the host app, so codeblock stays decoupled from any particular connection.
// **With no provider set, behaviour is exactly as before** — the in-browser servers
// run and every other language has no LSP.

/**
 * A language server reachable over `transport`, with the workspace + path↔URI
 * mapping it expects. The built-in worker uses a virtual `file:///<path>` model;
 * a remote native server uses real host URIs under a real workspace `rootUri`.
 */
export interface LspConnection {
    transport: Transport;
    /** The LSP `initialize` rootUri (a real workspace for a native server). */
    rootUri: string;
    /** Map a code block's VFS path → the document URI the server expects. */
    uriForPath: (path: string) => string;
    /** Inverse of `uriForPath`, for cross-file navigation (Go to Definition). */
    pathForUri: (uri: string) => string;
}

/**
 * Supplies an `LspConnection` for the languages it serves. Injected via
 * {@link setRemoteLspProvider} by the host app when an out-of-browser connection
 * exists (e.g. icanhaz/wRPC wiring rust-analyzer); generic across languages — adding
 * one is registering its server, not touching codeblock.
 */
export interface RemoteLspProvider {
    /** Does this provider serve `language`? (Cheap — checked before connecting.) */
    serves(language: string): boolean;
    /** Establish a connection for `opts`, or null to defer to the built-in servers. */
    connect(opts: ClientOptions): Promise<LspConnection | null>;
}

/** A live language server plus the path↔URI mapping its connection uses. */
interface LspHandle {
    client: LSPClient;
    uriForPath: (path: string) => string;
    pathForUri: (uri: string) => string;
}

let remoteLspProvider: RemoteLspProvider | null = null;

/**
 * Register the connection-backed LSP provider (e.g. rust-analyzer over wRPC), or
 * pass `null` to clear it (→ only the built-in in-browser servers run). The host app
 * calls this once it has a connection; without it, codeblock's LSP behaviour is
 * unchanged.
 */
export function setRemoteLspProvider(provider: RemoteLspProvider | null): void {
    remoteLspProvider = provider;
}

// Cached factory and LSP port per language
type WorkerFactory = (config: { fsPort: MessagePort; libFiles?: Record<string, string> }) => Promise<MessagePort>;
const languageServerFactory: Map<string, WorkerFactory> = new Map();
const lspPorts: Map<string, MessagePort> = new Map();
export const lspWorkers: Map<string, SharedWorker> = new Map()

// Cache initialization promises to prevent concurrent calls from creating
// duplicate LSP clients for the same language (race condition).
const clientInitPromises: Map<string, Promise<LspHandle | null>> = new Map();

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
            console.debug('[lsp] getVfsPort unavailable, using main-thread proxy');
            const { port1, port2 } = new MessageChannel();
            Comlink.expose(fs, port1);
            fsPort = port2;
        }

        const lspPort = await factory!(Comlink.transfer({ fsPort, libFiles }, [fsPort]));
        lspPort.start();
        lspPorts.set(language, lspPort);
        return { worker: w!, lspPort };
    }

    /**
     * Resolve how to reach a language server for `opts`: a configured remote provider
     * (connection-gated) wins for the languages it serves; otherwise the built-in
     * in-browser worker (TS/JS); otherwise no LSP — exactly the prior behaviour.
     */
    async function resolveConnection(opts: ClientOptions): Promise<LspConnection | null> {
        if (remoteLspProvider?.serves(opts.language)) {
            const conn = await remoteLspProvider.connect(opts);
            if (conn) return conn;
            // The provider declined (transient / not ready) — fall through to a
            // built-in server rather than leaving the block with no LSP.
        }
        const result = await worker(opts.language, opts.fs, opts.libFiles);
        if (!result) return null;
        return {
            transport: messagePortTransport(result.lspPort),
            rootUri: 'file:///',
            uriForPath: (p) => `file:///${p}`,
            pathForUri: (uri) => decodeURIComponent(uri.replace(/^file:\/\/\//, '')),
        };
    }

    export async function client({ language, path, fs, libFiles }: ClientOptions): Promise<Extension | null> {
        // Use a cached promise to ensure only one LSPClient is created per language,
        // even when multiple codeblocks call client() concurrently.
        let initPromise = clientInitPromises.get(language);
        if (!initPromise) {
            initPromise = (async () => {
                const conn = await resolveConnection({ language, path, fs, libFiles });
                if (!conn) return null;

                const lspClient = new LSPClient({
                    rootUri: conn.rootUri,
                    timeout: 30000,
                    extensions: languageServerExtensions(),
                    notificationHandlers: {
                        "window/logMessage": (_client, params: { type: number; message: string }) => {
                            const level = params.type === 1 ? 'error' : params.type === 2 ? 'warn' : params.type === 3 ? 'info' : 'log';
                            LspLog.push(level, params.message);
                            return false; // fall through to default handler (console)
                        }
                    },
                });
                lspClient.connect(conn.transport);

                // Override displayFile to support cross-file navigation
                // (e.g. Go to Definition jumping to a different file).
                const origDisplayFile = lspClient.workspace.displayFile.bind(lspClient.workspace);
                lspClient.workspace.displayFile = async (uri: string): Promise<EditorView | null> => {
                    // Check if already open in a view
                    const existing = await origDisplayFile(uri);
                    if (existing) return existing;

                    // Map the server's URI back to a VFS path (per the connection's
                    // model — virtual file:/// for the worker, real host paths remote).
                    const filePath = conn.pathForUri(uri);
                    if (!filePath) return null;

                    // Find any active view for this client
                    const file = lspClient.workspace.files[0];
                    const view = file?.getView() ?? null;
                    if (!view) return null;

                    // Dispatch openFileEffect and wait for the file to load
                    view.dispatch({ effects: openFileEffect.of({ path: filePath }) });
                    // Poll until the file is loaded (currentFileField.loading becomes false)
                    return new Promise<EditorView | null>((resolve) => {
                        let attempts = 0;
                        const check = () => {
                            const state = view.state.field(currentFileField);
                            if (!state.loading && state.path === filePath) {
                                resolve(view);
                            } else if (++attempts > 100) {
                                resolve(null); // timeout after ~5s
                            } else {
                                setTimeout(check, 50);
                            }
                        };
                        setTimeout(check, 50);
                    });
                };

                const handle: LspHandle = { client: lspClient, uriForPath: conn.uriForPath, pathForUri: conn.pathForUri };
                clients.set(language, handle);
                return handle;
            })();
            clientInitPromises.set(language, initPromise);
        }

        const handle = await initPromise;
        if (!handle) return null;
        return handle.client.plugin(handle.uriForPath(path), language);
    }

    /**
     * Notify all connected LSP clients that a file was created, changed, or deleted.
     * This sends workspace/didChangeWatchedFiles so the server re-evaluates the project.
     */
    export function notifyFileChanged(path: string, type: number = FileChangeType.Changed) {
        for (const handle of clients.values()) {
            handle.client.notification("workspace/didChangeWatchedFiles", {
                changes: [{ uri: handle.uriForPath(path), type }]
            });
        }
    }
}
