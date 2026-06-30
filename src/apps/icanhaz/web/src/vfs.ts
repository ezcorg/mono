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
//! KNOWN LIMITATION: `readFile`/`writeFile`/`readDir` open a descriptor (and
//! `readDir` a directory-entry-stream) that wRPC has no way to drop — they
//! accumulate in the host's resource table. Fine for a demo; a real editor needs a
//! descriptor-drop path (host GC, or wRPC gaining resource-drop) or descriptor
//! reuse. `watch` is a no-op (wasi:filesystem@0.2 has no change notifications).

import type { Transport } from "./wrpc";
import * as fsmount from "./generated/fs-mount";
import * as fs from "./generated/wasi-filesystem";

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
        },

        async writeFile(path, data) {
            const fd = await open(path, { create: true, truncate: true }, { read: true, write: true });
            const bytes = te.encode(data);
            let offset = 0n;
            const len = BigInt(bytes.length);
            while (offset < len) {
                const r = await fs.descriptorWrite(t, fd, bytes.subarray(Number(offset)), offset);
                if (r.tag !== "ok") throw new Error(`write ${path}: ${r.val}`);
                if (r.val === 0n) break; // guard against a 0-byte write looping forever
                offset += r.val;
            }
        },

        // wasi:filesystem@0.2 has no change-notification interface — live updates
        // would need a poll loop or a dedicated host watch capability.
        async *watch() {
            return;
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
            const dir = p === "." ? root : await open(path, { directory: true }, { read: true });
            const sr = await fs.descriptorReadDirectory(t, dir);
            if (sr.tag !== "ok") throw new Error(`readDir ${path}: ${sr.val}`);
            const stream = sr.val;
            const out: [string, FileType][] = [];
            for (;;) {
                const er = await fs.directoryEntryStreamReadDirectoryEntry(t, stream);
                if (er.tag !== "ok") throw new Error(`readDir ${path}: ${er.val}`);
                const entry = er.val; // option<directory-entry>
                if (entry === undefined) break;
                out.push([entry.name, fileType(entry.type)]);
            }
            return out;
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
