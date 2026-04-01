/**
 * Core packing logic: walk a directory, assign files to chunks,
 * produce ZIP archives (per-file deflate) with content-hashed
 * filenames, and emit the fs.json manifest.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { chunkByPackage, chunkByDirectory } from './chunker.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PackOptions {
    inputDir: string;
    outputDir: string;
    chunkStrategy: 'package' | 'directory';
    prefetchGlobs: string[];
    excludeGlobs: string[];
    baseUrl: string;
}

export interface PackResult {
    manifestPath: string;
    fileCount: number;
    symlinkCount: number;
    chunkCount: number;
}

interface WalkResult {
    files: string[];
    symlinks: Map<string, string>;
}

export async function pack(opts: PackOptions): Promise<PackResult> {
    const { inputDir, outputDir, chunkStrategy, prefetchGlobs, excludeGlobs, baseUrl } = opts;
    const chunksDir = path.join(outputDir, 'chunks');

    await fsp.mkdir(chunksDir, { recursive: true });

    const { files: allFiles, symlinks } = await walkDir(inputDir, inputDir, excludeGlobs);
    const relativePaths = allFiles.map(f => path.relative(inputDir, f));

    const chunks = chunkStrategy === 'package'
        ? chunkByPackage(relativePaths)
        : chunkByDirectory(relativePaths);

    const chunkNameToHash = new Map<string, string>();
    const manifest: Manifest = {
        version: 1,
        baseUrl,
        prefetch: [],
        files: {},
        symlinks: symlinks.size > 0 ? Object.fromEntries(symlinks) : undefined,
    };

    for (const [chunkName, files] of chunks) {
        const zipBuffer = await createZip(inputDir, files);

        const hash = crypto.createHash('sha256').update(zipBuffer).digest('hex').substring(0, 12);
        chunkNameToHash.set(chunkName, hash);

        await fsp.writeFile(path.join(chunksDir, `${hash}.zip`), zipBuffer);

        for (const relPath of files) {
            const absPath = path.join(inputDir, relPath);
            const stat = await fsp.stat(absPath);
            manifest.files[relPath] = [hash, stat.size];
        }
    }

    if (prefetchGlobs.length > 0) {
        const prefetchChunks = new Set<string>();
        for (const [chunkName, files] of chunks) {
            for (const file of files) {
                if (matchesAnyGlob(file, prefetchGlobs)) {
                    prefetchChunks.add(chunkNameToHash.get(chunkName)!);
                    break;
                }
            }
        }
        manifest.prefetch = [...prefetchChunks];
    } else {
        const rootfsHash = chunkNameToHash.get('rootfs');
        if (rootfsHash) manifest.prefetch = [rootfsHash];
    }

    const manifestPath = path.join(outputDir, 'fs.json');
    await fsp.writeFile(manifestPath, JSON.stringify(manifest));

    return {
        manifestPath,
        fileCount: relativePaths.length,
        symlinkCount: symlinks.size,
        chunkCount: chunks.size,
    };
}

// ---------------------------------------------------------------------------
// Manifest type
// ---------------------------------------------------------------------------

interface Manifest {
    version: 1;
    baseUrl: string;
    prefetch: string[];
    files: Record<string, [string, number]>;
    symlinks?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

async function walkDir(dir: string, rootDir: string, excludeGlobs: string[]): Promise<WalkResult> {
    const files: string[] = [];
    const symlinks = new Map<string, string>();

    async function walk(currentDir: string) {
        const entries = await fsp.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
            const full = path.join(currentDir, entry.name);
            const rel = path.relative(rootDir, full);

            if (excludeGlobs.length && matchesAnyGlob(rel, excludeGlobs)) continue;

            let lst;
            try { lst = await fsp.lstat(full); } catch { continue; }

            if (lst.isSymbolicLink()) {
                const target = await fsp.readlink(full);
                symlinks.set(rel, target);

                let realSt;
                try { realSt = await fsp.stat(full); } catch { continue; }
                if (realSt.isDirectory()) await walk(full);
            } else if (lst.isDirectory()) {
                await walk(full);
            } else if (lst.isFile()) {
                files.push(full);
            }
        }
    }

    await walk(dir);

    const seen = new Map<string, string>();
    const deduped: string[] = [];
    for (const absPath of files) {
        let real: string;
        try { real = await fsp.realpath(absPath); } catch { continue; }
        if (!seen.has(real)) {
            seen.set(real, absPath);
            deduped.push(absPath);
        }
    }

    return { files: deduped, symlinks };
}

// ---------------------------------------------------------------------------
// ZIP archive creator
// ---------------------------------------------------------------------------
// Produces a standard ZIP file with per-entry deflate compression.
// Each file is independently compressed, allowing the reader to
// decompress individual entries without reading the whole archive.

interface ZipEntry {
    path: string;
    compressed: Buffer;
    uncompressed: number;
    crc32: number;
    offset: number;
}

async function createZip(baseDir: string, relativePaths: string[]): Promise<Buffer> {
    const entries: ZipEntry[] = [];
    const parts: Buffer[] = [];
    let offset = 0;

    for (const relPath of relativePaths) {
        const absPath = path.join(baseDir, relPath);
        const content = await fsp.readFile(absPath);
        const compressed = await deflateRaw(content);
        const crc = crc32(content);

        const localHeader = createLocalFileHeader(relPath, compressed.length, content.length, crc);

        entries.push({
            path: relPath,
            compressed,
            uncompressed: content.length,
            crc32: crc,
            offset,
        });

        parts.push(localHeader);
        parts.push(compressed);
        offset += localHeader.length + compressed.length;
    }

    // Central directory
    const centralStart = offset;
    for (const entry of entries) {
        const cdHeader = createCentralDirectoryHeader(entry);
        parts.push(cdHeader);
        offset += cdHeader.length;
    }
    const centralSize = offset - centralStart;

    // End of central directory
    const eocd = createEndOfCentralDirectory(entries.length, centralSize, centralStart);
    parts.push(eocd);

    return Buffer.concat(parts);
}

function createLocalFileHeader(filePath: string, compressedSize: number, uncompressedSize: number, crc: number): Buffer {
    const pathBuf = Buffer.from(filePath, 'utf8');
    const header = Buffer.alloc(30 + pathBuf.length);
    header.writeUInt32LE(0x04034b50, 0);    // local file header signature
    header.writeUInt16LE(20, 4);             // version needed (2.0)
    header.writeUInt16LE(0, 6);              // flags
    header.writeUInt16LE(8, 8);              // compression: deflate
    header.writeUInt16LE(0, 10);             // mod time
    header.writeUInt16LE(0, 12);             // mod date
    header.writeUInt32LE(crc, 14);           // crc-32
    header.writeUInt32LE(compressedSize, 18);
    header.writeUInt32LE(uncompressedSize, 22);
    header.writeUInt16LE(pathBuf.length, 26);
    header.writeUInt16LE(0, 28);             // extra field length
    pathBuf.copy(header, 30);
    return header;
}

function createCentralDirectoryHeader(entry: ZipEntry): Buffer {
    const pathBuf = Buffer.from(entry.path, 'utf8');
    const header = Buffer.alloc(46 + pathBuf.length);
    header.writeUInt32LE(0x02014b50, 0);     // central directory signature
    header.writeUInt16LE(20, 4);              // version made by
    header.writeUInt16LE(20, 6);              // version needed
    header.writeUInt16LE(0, 8);               // flags
    header.writeUInt16LE(8, 10);              // compression: deflate
    header.writeUInt16LE(0, 12);              // mod time
    header.writeUInt16LE(0, 14);              // mod date
    header.writeUInt32LE(entry.crc32, 16);
    header.writeUInt32LE(entry.compressed.length, 20);
    header.writeUInt32LE(entry.uncompressed, 24);
    header.writeUInt16LE(pathBuf.length, 28);
    header.writeUInt16LE(0, 30);              // extra field length
    header.writeUInt16LE(0, 32);              // file comment length
    header.writeUInt16LE(0, 34);              // disk number start
    header.writeUInt16LE(0, 36);              // internal attributes
    header.writeUInt32LE(0, 38);              // external attributes
    header.writeUInt32LE(entry.offset, 42);   // local header offset
    pathBuf.copy(header, 46);
    return header;
}

function createEndOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number): Buffer {
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);       // EOCD signature
    eocd.writeUInt16LE(0, 4);                 // disk number
    eocd.writeUInt16LE(0, 6);                 // disk with central dir
    eocd.writeUInt16LE(entryCount, 8);        // entries on this disk
    eocd.writeUInt16LE(entryCount, 10);       // total entries
    eocd.writeUInt32LE(centralSize, 12);      // central directory size
    eocd.writeUInt32LE(centralOffset, 16);    // central directory offset
    eocd.writeUInt16LE(0, 20);                // comment length
    return eocd;
}

// ---------------------------------------------------------------------------
// Compression helpers
// ---------------------------------------------------------------------------

function deflateRaw(data: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        zlib.deflateRaw(data, (err, result) => err ? reject(err) : resolve(result));
    });
}

// CRC-32 lookup table
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crc32Table[i] = c;
}

function crc32(data: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = crc32Table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
    return globs.some(glob => matchGlob(filePath, glob));
}

function matchGlob(filePath: string, glob: string): boolean {
    const regex = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '{{GLOBSTAR_SLASH}}')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/{{GLOBSTAR_SLASH}}/g, '(.*/)?')
        .replace(/{{GLOBSTAR}}/g, '.*');
    return new RegExp(`^${regex}$`).test(filePath);
}
