//! The interactive terminal a page opens: the host's login shell in a PTY,
//! through the `terminal` capability. Resource-shaped, like every capability:
//! the grant token is presented once, at `open`, and the `terminal` object it
//! returns is the capability; `attach` runs a session on it, with stdin and a
//! control channel in and the PTY's output out. Closing the handle ends the
//! session and releases the object on the daemon.

import type { Transport } from "./wrpc";
import { requestTerminalGrant } from "./wrpc";
import { open, terminalAttach } from "./generated/terminal";
import { drop } from "./generated/resources";

/** A live terminal session (matches what the xterm renderer expects). */
export interface TerminalHandle {
    onOutput(cb: (bytes: Uint8Array) => void): void;
    write(data: string): void;
    /** Tell the PTY its new window size (a control frame `[cols u16 BE][rows u16 BE]`). */
    resize(cols: number, rows: number): void;
    onExit(cb: (code: number) => void): void;
    close(): void;
}

/** Open an interactive terminal (your login shell) over a [`Transport`]. */
export async function openTerminal(
    transport: Transport,
    opts: { cols: number; rows: number; reason?: string; grant?: string },
): Promise<TerminalHandle> {
    // Consent gate: acquire a terminal grant from the broker first (unless the
    // caller already holds one). `open` refuses a token that is not a live
    // terminal grant.
    const grant = opts.grant ?? (await requestTerminalGrant(transport, opts.reason));
    const opened = await open(transport, grant);
    if (opened.tag !== "ok") throw new Error(`terminal refused: ${opened.val}`);
    const terminal = opened.val;
    const session = await terminalAttach(transport, terminal, opts.cols, opts.rows);

    let onOutputCb: ((b: Uint8Array) => void) | undefined;
    let onExitCb: ((code: number) => void) | undefined;
    const outBacklog: Uint8Array[] = [];
    let exited = false;
    let pendingExit: number | null = null;
    let released = false;

    const emitOutput = (b: Uint8Array) => {
        if (onOutputCb) onOutputCb(b);
        else outBacklog.push(b);
    };
    const emitExit = (code: number) => {
        if (exited) return;
        exited = true;
        if (onExitCb) onExitCb(code);
        else pendingExit = code;
    };
    const release = () => {
        if (released) return;
        released = true;
        // Best effort: an unreleased object is reclaimed when the connection closes.
        void drop(transport, terminal).catch(() => {});
    };

    session.onData((chunk) => {
        if (chunk === null) {
            emitExit(0); // the PTY's output ended: the shell exited
            release();
        } else {
            emitOutput(chunk);
        }
    });
    session.onError((e) => {
        console.warn(`terminal session refused: ${e}`);
        emitExit(1);
        release();
    });

    const enc = new TextEncoder();
    return {
        onOutput(cb) {
            onOutputCb = cb;
            for (const b of outBacklog) cb(b);
            outBacklog.length = 0;
        },
        onExit(cb) {
            onExitCb = cb;
            if (pendingExit !== null) cb(pendingExit);
        },
        write(data) {
            session.stdin(enc.encode(data));
        },
        resize(cols, rows) {
            session.control(new Uint8Array([(cols >> 8) & 0xff, cols & 0xff, (rows >> 8) & 0xff, rows & 0xff]));
        },
        close() {
            // End stdin and control (EOF to the shell), close the session's
            // duplex, and release the terminal object.
            try {
                session.closeStdin();
                session.closeControl();
            } catch { /* ignore */ }
            session.close();
            release();
        },
    };
}
