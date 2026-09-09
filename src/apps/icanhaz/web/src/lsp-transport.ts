//! An LSP transport over the wRPC **process** capability: spawn a host language
//! server (e.g. rust-analyzer) and bridge its stdio LSP wire to the `Transport`
//! shape `@codemirror/lsp-client` consumes (send / subscribe / unsubscribe of raw
//! JSON-RPC message *strings*). This is the remote sibling of codeblock's
//! `messagePortTransport` — a worker speaks via `postMessage` (implicit message
//! boundaries), whereas a stdio server frames with `Content-Length`, so this
//! transport adds/strips that framing over the process byte streams.
//!
//! Our `process` provider keeps the child's **stderr** off the stream (logged
//! host-side), so the stdout stream is clean LSP — no log lines to skip.

import type { SpawnSession } from "./generated/process";

/**
 * Structurally `@codemirror/lsp-client`'s `Transport` — kept dependency-free here
 * so icanhaz-web doesn't pull the editor stack; codeblock's `LSP.client` consumes
 * it structurally (same three methods).
 */
export interface LspTransport {
    send(message: string): void;
    subscribe(handler: (value: string) => void): void;
    unsubscribe(handler: (value: string) => void): void;
}

/** One traced LSP message (see {@link setLspTrace}). `t` = ms since the transport
 *  was created, so you can see how long a server takes before it answers. */
export interface LspTraceEvent {
    dir: "send" | "recv";
    t: number;
    kind: "request" | "response" | "notification" | "error";
    method?: string;
    id?: number | string;
    /** window/showMessage · logMessage text, $/progress phase, an error message, or
     *  the document URI (+ diagnostic count for publishDiagnostics). */
    detail?: string;
}

let lspTrace: ((ev: LspTraceEvent) => void) | null = null;

/**
 * Install a global LSP wire tracer (or `null` to clear). EVERY message crossing ANY
 * `processLspTransport` — including the editor's — is reported, so you can see what a
 * language server actually does: did `initialize` get a response? is it emitting
 * `$/progress` (indexing) and does it finish? did a `window/showMessage` report
 * "Failed to load workspaces"? did a hover get answered, or just time out?
 */
export function setLspTrace(fn: ((ev: LspTraceEvent) => void) | null): void {
    lspTrace = fn;
}

function emitTrace(dir: "send" | "recv", raw: string, t0: number): void {
    if (!lspTrace) return;
    let m: any;
    try {
        m = JSON.parse(raw);
    } catch {
        return;
    }
    const kind: LspTraceEvent["kind"] =
        m.method !== undefined
            ? m.id !== undefined
                ? "request"
                : "notification"
            : m.error !== undefined
              ? "error"
              : "response";
    let detail: string | undefined;
    if (m.method === "window/showMessage" || m.method === "window/logMessage") {
        detail = String(m.params?.message).slice(0, 200);
    } else if (m.method === "$/progress") {
        detail = `${m.params?.value?.kind ?? ""} ${m.params?.value?.title ?? m.params?.value?.message ?? ""}`.trim();
    } else if (m.method === "textDocument/publishDiagnostics") {
        // The URI rust-analyzer diagnoses + how many + the doc VERSION it analyzed.
        // Compare the URI against the didOpen URI (a mismatch hides them) and the version
        // against the client's latest didChange (a lag makes the client skip rendering).
        detail = `${m.params?.uri} · ${m.params?.diagnostics?.length ?? 0} diag · v${m.params?.version ?? "-"}`;
    } else if (m.method === "textDocument/didOpen") {
        const td = m.params?.textDocument;
        detail = `v${td?.version} len=${String(td?.text ?? "").length}`;
    } else if (m.method === "textDocument/didChange") {
        const ver = m.params?.textDocument?.version;
        const cc = (m.params?.contentChanges ?? [])
            .map((c: any) =>
                c.range
                    ? `@${c.range.start.line}:${c.range.start.character}-${c.range.end.line}:${c.range.end.character}="${String(c.text ?? "").replace(/\n/g, "\\n").slice(0, 15)}"`
                    : `FULL(${String(c.text ?? "").length})`,
            )
            .join(" ");
        detail = `v${ver} ${cc}`;
    } else if (typeof m.method === "string" && m.method.startsWith("textDocument/")) {
        const uri = m.params?.textDocument?.uri; // didOpen/didChange/hover/… carry the URI here
        const ver = m.params?.textDocument?.version;
        if (uri) detail = String(uri) + (ver != null ? ` v${ver}` : "");
    } else if (m.error !== undefined) {
        detail = JSON.stringify(m.error).slice(0, 200);
    }
    lspTrace({ dir, t: Date.now() - t0, kind, method: m.method, id: m.id, detail });
}

const te = new TextEncoder();
const td = new TextDecoder();

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** Index of the LSP header terminator (`\r\n\r\n`) in `buf`, or -1 if not present. */
function headerEnd(buf: Uint8Array): number {
    for (let i = 3; i < buf.length; i++) {
        if (buf[i - 3] === 13 && buf[i - 2] === 10 && buf[i - 1] === 13 && buf[i] === 10) {
            return i - 3;
        }
    }
    return -1;
}

/**
 * Bridge a `process.spawn` session that is running a stdio language server to an
 * `LspTransport`. Outgoing messages get a `Content-Length` header; the stdout
 * stream is de-framed back into whole JSON-RPC message strings (chunks may split a
 * message anywhere — the buffer reassembles).
 */
export function processLspTransport(session: SpawnSession): LspTransport {
    const t0 = Date.now();
    let handlers: ((value: string) => void)[] = [];
    let buf = new Uint8Array(0);

    session.onData((chunk) => {
        if (chunk === null) return; // the server's stdout closed (it exited)
        buf = concat(buf, chunk);
        for (;;) {
            const he = headerEnd(buf);
            if (he < 0) break; // header not fully arrived yet
            const header = td.decode(buf.subarray(0, he));
            const match = /content-length:\s*(\d+)/i.exec(header);
            const bodyStart = he + 4; // skip the \r\n\r\n
            if (!match) {
                buf = buf.subarray(bodyStart); // malformed header — drop and resync
                continue;
            }
            const len = parseInt(match[1]!, 10); // Content-Length is BYTES, not chars
            if (buf.length < bodyStart + len) break; // body not fully arrived yet
            const body = td.decode(buf.subarray(bodyStart, bodyStart + len));
            buf = buf.subarray(bodyStart + len);
            emitTrace("recv", body, t0);
            for (const h of handlers) h(body);
        }
    });

    return {
        send(message) {
            emitTrace("send", message, t0);
            const body = te.encode(message);
            const header = te.encode(`Content-Length: ${body.length}\r\n\r\n`);
            session.stdin(concat(header, body));
        },
        subscribe(handler) {
            handlers.push(handler);
        },
        unsubscribe(handler) {
            handlers = handlers.filter((h) => h !== handler);
        },
    };
}
