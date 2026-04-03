/**
 * ChunkFetcher — downloads ZIP chunks and extracts entries one at a
 * time, writing each to the backing store before moving to the next.
 *
 * ZIP format allows per-entry decompression (each file is independently
 * deflate-compressed), so we never hold more than one file's data in
 * memory at a time.
 */

import { type LazyManifest, getChunkUrl } from "./lazy-manifest";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ChunkFetcherOpts {
    manifest: LazyManifest;
    manifestUrl: string;
    /** Write a file to the backing store (used for storing chunk zips). */
    writeFile: (path: string, data: Uint8Array) => Promise<void>;
    /** Ensure a directory exists. */
    ensureDir: (path: string) => Promise<void>;
    /** Read a stored chunk zip from the backing store. */
    readFile: (path: string) => Promise<ArrayBuffer>;
    fetchChunk?: (url: string) => Promise<ArrayBuffer>;
}

export class ChunkFetcher {
    private manifest: LazyManifest;
    private manifestUrl: string;
    private writeFile: ChunkFetcherOpts['writeFile'];
    private readChunkZip: ChunkFetcherOpts['readFile'];
    private fetchChunk: (url: string) => Promise<ArrayBuffer>;

    private hydrated = new Set<string>();
    private pending = new Map<string, Promise<void>>();
    /** In-memory cache of recently used zip buffers. */
    private zipCache = new Map<string, Uint8Array>();

    constructor(opts: ChunkFetcherOpts) {
        this.manifest = opts.manifest;
        this.manifestUrl = opts.manifestUrl;
        this.writeFile = opts.writeFile;
        this.readChunkZip = opts.readFile;
        this.fetchChunk = opts.fetchChunk ?? defaultFetchChunk;
    }

    isHydrated(chunkId: string): boolean {
        return this.hydrated.has(chunkId);
    }

    async hydrate(chunkId: string): Promise<void> {
        if (this.hydrated.has(chunkId)) return;

        let p = this.pending.get(chunkId);
        if (!p) {
            p = this._doHydrate(chunkId).catch(e => {
                console.error(`[LazyFS] chunk ${chunkId} hydration failed:`, e);
                throw e;
            });
            this.pending.set(chunkId, p);
            p.finally(() => this.pending.delete(chunkId));
        }
        return p;
    }

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
        const t0 = performance.now();
        const buf = await this.fetchChunk(url);
        const fetchMs = performance.now() - t0;

        // Store the zip blob as a single OPFS file instead of extracting
        // individual files.  This avoids per-file OPFS write overhead
        // (which is 43x slower on Firefox than Chrome).
        //
        // On read, files are extracted directly from the stored zip.
        await this.writeFile(`.chunks/${chunkId}.zip`, new Uint8Array(buf));

        // Cache the zip in memory for immediate reads (avoids re-reading
        // from OPFS before the first read completes).
        this.zipCache.set(chunkId, new Uint8Array(buf));

        const entries = readCentralDirectory(new Uint8Array(buf));
        const fileCount = entries.filter(e => !e.path.endsWith('/')).length;

        const totalMs = performance.now() - t0;
        console.debug(`[LazyFS] hydrated ${chunkId} (${fileCount} files, ${(buf.byteLength / 1024).toFixed(0)}KB, fetch=${fetchMs.toFixed(0)}ms, total=${totalMs.toFixed(0)}ms)`);
        this.hydrated.add(chunkId);
    }

    /**
     * Read a file directly from a hydrated chunk's zip archive.
     * Decompresses only the requested entry.
     */
    async readFromChunk(chunkId: string, filePath: string): Promise<Uint8Array> {
        let zip = this.zipCache.get(chunkId);
        if (!zip) {
            // Read the stored zip from OPFS
            const buf = await this.readChunkZip(`.chunks/${chunkId}.zip`);
            zip = new Uint8Array(buf);
            this.zipCache.set(chunkId, zip);
        }
        const entries = readCentralDirectory(zip);
        const entry = entries.find(e => e.path === filePath);
        if (!entry) throw new Error(`File not found in chunk: ${filePath}`);
        return extractEntryAsync(zip, entry);
    }
}

async function defaultFetchChunk(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`[LazyFS] chunk fetch failed: ${res.status} ${url}`);
    return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// ZIP reader — minimal implementation for local file entries
// ---------------------------------------------------------------------------

interface ZipEntryInfo {
    path: string;
    compressedSize: number;
    uncompressedSize: number;
    compression: number;  // 0 = stored, 8 = deflate
    localHeaderOffset: number;
}

/**
 * Read the central directory from the end of the ZIP buffer.
 * Returns metadata for each entry (no decompression yet).
 */
function readCentralDirectory(zip: Uint8Array): ZipEntryInfo[] {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    // Find End of Central Directory record (search backwards for signature)
    let eocdOffset = -1;
    for (let i = zip.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) throw new Error('Invalid ZIP: EOCD not found');

    const entryCount = view.getUint16(eocdOffset + 10, true);
    const centralOffset = view.getUint32(eocdOffset + 16, true);

    const entries: ZipEntryInfo[] = [];
    let offset = centralOffset;

    for (let i = 0; i < entryCount; i++) {
        if (view.getUint32(offset, true) !== 0x02014b50) {
            throw new Error('Invalid ZIP: bad central directory entry');
        }

        const compression = view.getUint16(offset + 10, true);
        const compressedSize = view.getUint32(offset + 20, true);
        const uncompressedSize = view.getUint32(offset + 24, true);
        const nameLen = view.getUint16(offset + 28, true);
        const extraLen = view.getUint16(offset + 30, true);
        const commentLen = view.getUint16(offset + 32, true);
        const localHeaderOffset = view.getUint32(offset + 42, true);

        const pathBytes = zip.subarray(offset + 46, offset + 46 + nameLen);
        const path = new TextDecoder().decode(pathBytes);

        entries.push({ path, compressedSize, uncompressedSize, compression, localHeaderOffset });

        offset += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
}

/**
 * Extract and decompress a single ZIP entry.
 * Uses DecompressionStream('deflate-raw') for per-entry decompression.
 */
async function extractEntryAsync(zip: Uint8Array, entry: ZipEntryInfo): Promise<Uint8Array> {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const lhOffset = entry.localHeaderOffset;

    if (view.getUint32(lhOffset, true) !== 0x04034b50) {
        throw new Error(`Invalid ZIP: bad local header at ${lhOffset}`);
    }

    const nameLen = view.getUint16(lhOffset + 26, true);
    const extraLen = view.getUint16(lhOffset + 28, true);
    const dataOffset = lhOffset + 30 + nameLen + extraLen;

    const compressed = zip.subarray(dataOffset, dataOffset + entry.compressedSize);

    if (entry.compression === 0) {
        return compressed;
    }

    // Deflate-raw decompression via DecompressionStream
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(compressed));
    writer.close();
    const decompressed = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(decompressed);
}
