//! A codeblock `RemoteLspProvider` backed by the icanhaz/wRPC **process**
//! capability. Each served language spawns its native language server on the host
//! (consent-gated, the binary pinned by the grant) and bridges its stdio LSP wire
//! over wRPC via [`processLspTransport`]. The host app injects this into codeblock
//! with `setRemoteLspProvider(...)` once it has a connection; without it codeblock
//! falls back to its built-in in-browser servers (the no-connection behaviour).
//!
//! Generic across languages: add one by adding a `servers` entry — e.g.
//! `python: { image: "pyright-langserver", args: ["--stdio"] }`. The only
//! per-language specifics are the binary name + argv (and whether it wants `--stdio`).

import type { RemoteLspProvider, LspConnection, ClientOptions } from "@joinezco/codeblock";
import type { Transport } from "./wrpc";
import { requestProcessGrant } from "./wrpc";
import { spawn } from "./generated/process";
import { processLspTransport } from "./lsp-transport";

/** How to launch one language server on the host. */
export interface WrpcLspServerSpec {
    /** The host program to spawn — pinned by the consent grant (caller can't swap it). */
    image: string;
    /** argv after argv[0] (e.g. `["--stdio"]`); requires the grant to permit argv. */
    args?: string[];
}

export interface WrpcLspConfig {
    /** A connected wRPC transport — typically the same one the editor's fs rides. */
    transport: Transport;
    /**
     * Host absolute path of the workspace root the servers analyze (becomes each
     * server's LSP `rootUri`). For an editor backed by `wrpcFilesystem`, this is the
     * host path of the grant's jail when that jail is the project root.
     */
    workspaceRoot: string;
    /** language id → how to launch its server. The extension point for new languages. */
    servers: Record<string, WrpcLspServerSpec>;
}

const pathToFileUri = (p: string): string => "file://" + encodeURI(p.startsWith("/") ? p : `/${p}`);
const fileUriToPath = (uri: string): string => decodeURI(uri.replace(/^file:\/\//, ""));

/**
 * Build a codeblock `RemoteLspProvider` over wRPC for the given language servers.
 * `serves` is cheap (registry lookup); `connect` requests a `process` grant for the
 * language's image, spawns it, and frames LSP over its stdio. URIs are real host
 * paths under `workspaceRoot` (a native server reads the host disk, not the browser VFS).
 */
export function createWrpcLspProvider(config: WrpcLspConfig): RemoteLspProvider {
    const root = config.workspaceRoot.replace(/\/+$/, ""); // no trailing slash

    return {
        serves(language: string): boolean {
            return language in config.servers;
        },

        async connect(opts: ClientOptions): Promise<LspConnection | null> {
            const spec = config.servers[opts.language];
            if (!spec) return null;

            const args = spec.args ?? [];
            // The grant pins the server's image AND its argv — the human sees the exact
            // command at consent. We don't need to vary argv at spawn, so `guest-chooses-
            // argv` stays false and the pinned `args` run verbatim.
            const grant = await requestProcessGrant(
                config.transport,
                spec.image,
                args,
                false,
                `language server for ${opts.language} (${spec.image})`,
            );
            const session = await spawn(config.transport, grant, args);

            return {
                transport: processLspTransport(session),
                rootUri: pathToFileUri(root),
                uriForPath: (path) => pathToFileUri(`${root}/${path.replace(/^\/+/, "")}`),
                pathForUri: (uri) => {
                    const path = fileUriToPath(uri);
                    const prefix = `${root}/`;
                    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
                },
            };
        },
    };
}
