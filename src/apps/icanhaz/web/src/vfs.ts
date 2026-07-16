//! A `VfsInterface`-shaped filesystem (codeblock's contract) backed by the host's
//! real `wasi:filesystem@0.2` over wRPC — the seam that lets the markdown-editor /
//! codeblock edit host files remotely, gated + scoped by a NoCap grant.
//!
//! `mount(grant)` exchanges the consented grant for the root descriptor (the host
//! confines it to the grant's subtree — the mediating policy), then every method
//! rides the generated `wasi:filesystem` bindings. Path-only ops (`stat`/`exists`/
//! `unlink`/`mkdir`) use the `*-at` methods, so they open no descriptor.
//!
//! Structurally matches codeblock's `VfsInterface` (kept dependency-free here on
//! purpose — no `@volar`/codeblock import; the editor consumes it structurally).
//!
//! DESCRIPTOR LIFETIME: `readFile`/`writeFile`/`readDir` open a per-op descriptor
//! (and `readDir` a directory-entry-stream). These are guest-exported resources the
//! host holds in its shared-resource table; without a drop they'd accumulate for the
//! connection's life. So each of those ops **drops the handle it opened** when it's
//! done, via `dropHandle` → the host's `icanhaz:fspass/resources@0.1.0#drop` (which
//! evicts the table entry and runs the guest destructor, closing the real fd). The
//! long-lived mount `root` is kept. `watch` is a no-op (wasi:filesystem@0.2 has no
//! change notifications).

import { type Transport, invoke, encodeBytes, readBool, resultValue } from "./wrpc";
import * as fsmount from "./generated/fs-mount";
import * as fs from "./generated/wasi-filesystem";
import { open as watchOpen } from "./generated/watch";

/** `@volar/language-service` FileType values (Unknown/File/Directory/SymbolicLink). */
export type FileType = 0 | 1 | 2 | 64;

/** Mirrors codeblock's `VfsInterface` (src/types.ts) — consumed structurally. */
export interface VfsLike {
    readFile(path: string): Promise<string>;
    writeFile(path: string, data: string): Promise<void>;
    watch(path: string, options: { signal: AbortSignal }): AsyncGenerator<{ eventType: "rename" | "change"; filename: string }>;
    mkdir(path: string, options: { recursive: boolean }): Promise<void>;
    readDir(path: string): Promise<[string, FileType][]>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<unknown | undefined>;
    unlink(path: string): Promise<void>;
}

const td = new TextDecoder();
const te = new TextEncoder();

// wasi:filesystem `open-at`/`*-at` paths are relative to the descriptor.
const rel = (p: string): string => p.replace(/^\/+/, "") || ".";

const fileType = (t: fs.DescriptorType): FileType =>
    t === "directory" ? 2 : t === "symbolic-link" ? 64 : t === "regular-file" ? 1 : 0;

const toDate = (d: fs.Datetime | undefined): Date | undefined =>
    d ? new Date(Number(d.seconds) * 1000 + Math.floor(d.nanoseconds / 1e6)) : undefined;

function concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return out;
}

// The host serves this alongside the filesystem: `drop(handle: list<u8>)` evicts a
// guest-exported resource handle (descriptor / directory-entry-stream) from the
// shared-resource table and runs its guest destructor (closing the fd).
const RESOURCES_INSTANCE = "icanhaz:fspass/resources@0.1.0";

/** Release a guest resource handle (descriptor / directory-entry-stream) the host
 *  holds for us. Resolves to whether a live handle was actually released (the host
 *  ran its destructor + evicted it); `false` if it was already gone. Throws on
 *  transport error. Exported so a caller/test that obtained a handle directly can
 *  release it. */
export async function dropResource(t: Transport, handle: Uint8Array): Promise<boolean> {
    const resp = await invoke(t, RESOURCES_INSTANCE, "drop", encodeBytes(handle));
    return readBool(resultValue(resp), 0)[0];
}

/** Best-effort drop used internally: a failure is non-fatal — the handle would just
 *  linger until the transport closes (the old behavior) — so we never surface it. */
async function dropHandle(t: Transport, handle: Uint8Array): Promise<void> {
    try {
        await dropResource(t, handle);
    } catch {
        /* best-effort: the handle is still reclaimed when the connection closes */
    }
}

/**
 * Mount a NoCap filesystem grant and present it as a `VfsInterface`. Throws if the
 * grant is refused at the consent gate.
 */
export async function wrpcFilesystem(t: Transport, grant: string): Promise<VfsLike> {
    const mounted = await fsmount.openRoot(t, grant);
    if (mounted.tag !== "ok") throw new Error(`filesystem mount denied: ${mounted.val}`);
    const root = mounted.val; // the grant-scoped root descriptor (an opaque handle)

    const open = async (path: string, openFlags: fs.OpenFlags, flags: fs.DescriptorFlags): Promise<Uint8Array> => {
        const r = await fs.descriptorOpenAt(t, root, {}, rel(path), openFlags, flags);
        if (r.tag !== "ok") throw new Error(`open ${path}: ${r.val}`);
        return r.val;
    };

    return {
        async readFile(path) {
            const fd = await open(path, {}, { read: true });
            try {
                const chunks: Uint8Array[] = [];
                let offset = 0n;
                for (;;) {
                    const r = await fs.descriptorRead(t, fd, 65536n, offset);
                    if (r.tag !== "ok") throw new Error(`read ${path}: ${r.val}`);
                    const [chunk, eof] = r.val;
                    chunks.push(chunk);
                    offset += BigInt(chunk.length);
                    if (eof) break;
                }
                return td.decode(concat(chunks));
            } finally {
                await dropHandle(t, fd);
            }
        },

        async writeFile(path, data) {
            // Do NOT open with truncate: it empties the file on disk first, and a native
            // watcher (rust-analyzer's cargo-check/flycheck) can read that empty window and
            // cache a bogus error (e.g. "main function not found"). Instead overwrite in place,
            // then set-size to trim any leftover tail — the file is never empty on disk.
            const fd = await open(path, { create: true, truncate: false }, { read: true, write: true });
            try {
                const bytes = te.encode(data);
                let offset = 0n;
                const len = BigInt(bytes.length);
                while (offset < len) {
                    const r = await fs.descriptorWrite(t, fd, bytes.subarray(Number(offset)), offset);
                    if (r.tag !== "ok") throw new Error(`write ${path}: ${r.val}`);
                    if (r.val === 0n) break; // guard against a 0-byte write looping forever
                    offset += r.val;
                }
                // Trim to the exact length (removes any tail left when overwriting longer content).
                const s = await fs.descriptorSetSize(t, fd, len);
                if (s.tag !== "ok") throw new Error(`set-size ${path}: ${s.val}`);
            } finally {
                await dropHandle(t, fd);
            }
        },

        // Native change events via the host `watch` capability (a `notify` watcher
        // under the grant's jail). Events arrive framed as [kind u8][len u16 BE][path]
        // and are decoded here into codeblock's {eventType, filename} stream. The
        // watcher stops when this generator returns (abort → session close).
        async *watch(path, options) {
            const signal = options?.signal;
            const session = await watchOpen(t, grant, rel(path), true);
            const events: Array<{ eventType: "rename" | "change"; filename: string }> = [];
            let buf: Uint8Array = new Uint8Array(0);
            let ended = false;
            let wake: (() => void) | undefined;

            session.onData((chunk) => {
                if (chunk === null) {
                    ended = true;
                } else {
                    buf = concat([buf, chunk]);
                    while (buf.length >= 3) {
                        const len = (buf[1]! << 8) | buf[2]!;
                        if (buf.length < 3 + len) break;
                        events.push({
                            eventType: buf[0] === 0 ? "rename" : "change",
                            filename: td.decode(buf.subarray(3, 3 + len)),
                        });
                        buf = buf.subarray(3 + len);
                    }
                }
                wake?.();
            });
            const onAbort = () => {
                ended = true;
                session.close();
                wake?.();
            };
            signal?.addEventListener("abort", onAbort, { once: true });

            try {
                while (!ended || events.length) {
                    if (events.length) {
                        yield events.shift()!;
                        continue;
                    }
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                    wake = undefined;
                }
            } finally {
                signal?.removeEventListener("abort", onAbort);
                session.close();
            }
        },

        async mkdir(path, options) {
            const target = rel(path);
            if (!options.recursive) {
                const r = await fs.descriptorCreateDirectoryAt(t, root, target);
                if (r.tag !== "ok") throw new Error(`mkdir ${path}: ${r.val}`);
                return;
            }
            let acc = "";
            for (const part of target.split("/").filter(Boolean)) {
                acc = acc ? `${acc}/${part}` : part;
                const r = await fs.descriptorCreateDirectoryAt(t, root, acc);
                if (r.tag !== "ok" && r.val !== "exist") throw new Error(`mkdir ${acc}: ${r.val}`);
            }
        },

        async readDir(path) {
            const p = rel(path);
            // `.` reuses the long-lived mount root (don't drop it); any other path
            // opens a fresh directory descriptor that we drop when done.
            const dir = p === "." ? root : await open(path, { directory: true }, { read: true });
            try {
                const sr = await fs.descriptorReadDirectory(t, dir);
                if (sr.tag !== "ok") throw new Error(`readDir ${path}: ${sr.val}`);
                const stream = sr.val;
                try {
                    const out: [string, FileType][] = [];
                    for (;;) {
                        const er = await fs.directoryEntryStreamReadDirectoryEntry(t, stream);
                        if (er.tag !== "ok") throw new Error(`readDir ${path}: ${er.val}`);
                        const entry = er.val; // option<directory-entry>
                        if (entry === undefined) break;
                        out.push([entry.name, fileType(entry.type)]);
                    }
                    return out;
                } finally {
                    await dropHandle(t, stream); // the directory-entry-stream
                }
            } finally {
                if (dir !== root) await dropHandle(t, dir);
            }
        },

        async exists(path) {
            const r = await fs.descriptorStatAt(t, root, {}, rel(path));
            return r.tag === "ok";
        },

        async stat(path) {
            const r = await fs.descriptorStatAt(t, root, {}, rel(path));
            if (r.tag !== "ok") return null;
            const s = r.val;
            return {
                name: path,
                size: Number(s.size),
                type: fileType(s.type),
                atime: toDate(s.dataAccessTimestamp),
                mtime: toDate(s.dataModificationTimestamp),
                ctime: toDate(s.statusChangeTimestamp),
            };
        },

        async unlink(path) {
            const r = await fs.descriptorUnlinkFileAt(t, root, rel(path));
            if (r.tag !== "ok") throw new Error(`unlink ${path}: ${r.val}`);
        },
    };
}
