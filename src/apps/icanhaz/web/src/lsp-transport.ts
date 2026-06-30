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
            for (const h of handlers) h(body);
        }
    });

    return {
        send(message) {
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
