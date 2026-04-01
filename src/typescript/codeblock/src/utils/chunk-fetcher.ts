/**
 * ChunkFetcher — downloads, decompresses, and extracts tar.gz chunks
 * on demand.  Shared by LazyVfs (VfsInterface layer) and
 * LazyFilesystem (jswasi Filesystem layer).
 *
 * Each chunk is fetched at most once; concurrent requests for the
 * same chunk share a single in-flight promise.
 */

import { type LazyManifest, getChunkUrl } from "./lazy-manifest";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ChunkFetcherOpts {
    manifest: LazyManifest;
    /** Absolute URL of the manifest file (used to resolve relative baseUrl). */
    manifestUrl: string;
    /** Write an extracted file to the backing store. */
    writeFile: (path: string, data: Uint8Array) => Promise<void>;
    /** Ensure a directory exists in the backing store. */
    ensureDir: (path: string) => Promise<void>;
}

export class ChunkFetcher {
    private manifest: LazyManifest;
    private manifestUrl: string;
    private writeFile: ChunkFetcherOpts['writeFile'];
    private ensureDir: ChunkFetcherOpts['ensureDir'];

    private hydrated = new Set<string>();
    private pending = new Map<string, Promise<void>>();

    constructor(opts: ChunkFetcherOpts) {
        this.manifest = opts.manifest;
        this.manifestUrl = opts.manifestUrl;
        this.writeFile = opts.writeFile;
        this.ensureDir = opts.ensureDir;
    }

    /** True if every file in `chunkId` has been extracted to the backing store. */
    isHydrated(chunkId: string): boolean {
        return this.hydrated.has(chunkId);
    }

    /**
     * Ensure all files from `chunkId` are extracted to the backing store.
     * Concurrent calls for the same chunk share a single fetch.
     */
    async hydrate(chunkId: string): Promise<void> {
        if (this.hydrated.has(chunkId)) return;

        let p = this.pending.get(chunkId);
        if (!p) {
            p = this._doHydrate(chunkId);
            this.pending.set(chunkId, p);
            p.finally(() => this.pending.delete(chunkId));
        }
        return p;
    }

    /** Kick off prefetch for all chunks in `manifest.prefetch`. Non-blocking. */
    prefetch(): void {
        for (const id of this.manifest.prefetch) {
            this.hydrate(id).catch(err =>
                console.warn(`[LazyFS] prefetch chunk ${id} failed:`, err)
            );
        }
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private async _doHydrate(chunkId: string): Promise<void> {
        const url = getChunkUrl(this.manifest, chunkId, this.manifestUrl);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`[LazyFS] chunk fetch failed: ${res.status} ${url}`);

        // Decompress gzip → raw tar bytes
        const raw = await decompressGzip(res);
        const entries = parseTar(raw);

        // Extract files (parallel writes, batched to limit concurrency)
        const BATCH = 8;
        for (let i = 0; i < entries.length; i += BATCH) {
            const batch = entries.slice(i, i + BATCH);
            await Promise.all(batch.map(async (entry) => {
                if (entry.type === 'directory') {
                    await this.ensureDir(entry.path);
                } else if (entry.type === 'file' && entry.data.byteLength > 0) {
                    // Ensure parent directory exists
                    const lastSlash = entry.path.lastIndexOf('/');
                    if (lastSlash > 0) {
                        await this.ensureDir(entry.path.substring(0, lastSlash));
                    }
                    await this.writeFile(entry.path, entry.data);
                }
            }));
        }

        this.hydrated.add(chunkId);
    }
}

// ---------------------------------------------------------------------------
// Gzip decompression
// ---------------------------------------------------------------------------

async function decompressGzip(response: Response): Promise<ArrayBuffer> {
    // Read the raw bytes first so we can inspect the magic header.
    // If the server already applied transparent decompression
    // (Content-Encoding: gzip), the bytes we receive are plain tar.
    const buf = await response.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // Gzip magic: 0x1f 0x8b
    const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

    if (isGzip && typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        return new Response(ds.readable).arrayBuffer();
    }

    // Already decompressed (or DecompressionStream unavailable)
    return buf;
}

// ---------------------------------------------------------------------------
// Minimal tar parser
// ---------------------------------------------------------------------------
// TAR format: sequence of 512-byte header blocks followed by file data
// (rounded up to 512-byte boundary).  We only need path, size, and
// type — no need for a full POSIX tar implementation.

interface TarEntry {
    path: string;
    type: 'file' | 'directory' | 'symlink';
    data: Uint8Array;
    linkTarget?: string;
}

const TAR_BLOCK = 512;
const DECODER = new TextDecoder();

function parseTar(buffer: ArrayBuffer): TarEntry[] {
    const bytes = new Uint8Array(buffer);
    const entries: TarEntry[] = [];
    let offset = 0;

    while (offset + TAR_BLOCK <= bytes.length) {
        const header = bytes.subarray(offset, offset + TAR_BLOCK);

        // Two consecutive zero blocks mark the end of the archive
        if (isZeroBlock(header)) break;

        const path = readString(header, 0, 100);
        const size = readOctal(header, 124, 12);
        const typeFlag = String.fromCharCode(header[156]);
        const linkTarget = readString(header, 157, 100);

        // GNU/POSIX long name extension (type 'L')
        // The next entry's data IS the long filename
        let resolvedPath = path;

        // UStar prefix (bytes 345-500)
        const prefix = readString(header, 345, 155);
        if (prefix) resolvedPath = prefix + '/' + path;

        // Determine entry type
        let type: TarEntry['type'];
        if (typeFlag === '5' || typeFlag === 'D') {
            type = 'directory';
        } else if (typeFlag === '2' || typeFlag === '1') {
            type = 'symlink';
        } else {
            type = 'file';
        }

        // Strip leading './' or '/' for consistency
        resolvedPath = resolvedPath.replace(/^\.\//, '').replace(/^\//, '');
        // Strip trailing '/' from directory paths
        if (type === 'directory') resolvedPath = resolvedPath.replace(/\/$/, '');

        offset += TAR_BLOCK;

        // Read file data
        const dataBlocks = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
        const data = size > 0 ? bytes.slice(offset, offset + size) : new Uint8Array(0);
        offset += dataBlocks;

        if (!resolvedPath) continue; // skip empty entries

        entries.push({
            path: resolvedPath,
            type,
            data,
            linkTarget: type === 'symlink' ? linkTarget : undefined,
        });
    }

    return entries;
}

function readString(buf: Uint8Array, offset: number, length: number): string {
    // Find the null terminator
    let end = offset;
    const max = offset + length;
    while (end < max && buf[end] !== 0) end++;
    return DECODER.decode(buf.subarray(offset, end));
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
    const str = readString(buf, offset, length).trim();
    return str ? parseInt(str, 8) || 0 : 0;
}

function isZeroBlock(block: Uint8Array): boolean {
    for (let i = 0; i < block.length; i++) {
        if (block[i] !== 0) return false;
    }
    return true;
}
