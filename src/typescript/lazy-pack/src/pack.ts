/**
 * Core packing logic: walk a directory, assign files to chunks,
 * produce tar.gz archives with content-hashed filenames, and
 * emit the fs.json manifest.
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
    chunkCount: number;
}

export async function pack(opts: PackOptions): Promise<PackResult> {
    const { inputDir, outputDir, chunkStrategy, prefetchGlobs, excludeGlobs, baseUrl } = opts;
    const chunksDir = path.join(outputDir, 'chunks');

    await fsp.mkdir(chunksDir, { recursive: true });

    // 1. Walk the input directory (follows symlinks, applies excludes)
    const allFiles = await walkDir(inputDir, inputDir, excludeGlobs);
    const relativePaths = allFiles.map(f => path.relative(inputDir, f));

    // 2. Assign files to chunks
    const chunks = chunkStrategy === 'package'
        ? chunkByPackage(relativePaths)
        : chunkByDirectory(relativePaths);

    // 3. Build each chunk as a tar.gz and compute its content hash
    const chunkNameToHash = new Map<string, string>();
    const manifest: Manifest = {
        version: 1,
        baseUrl,
        prefetch: [],
        files: {},
    };

    for (const [chunkName, files] of chunks) {
        // Create tar buffer
        const tarBuffer = await createTar(inputDir, files);

        // Gzip compress
        const compressed = await gzip(tarBuffer);

        // Content hash for immutable filename
        const hash = crypto.createHash('sha256').update(compressed).digest('hex').substring(0, 12);
        chunkNameToHash.set(chunkName, hash);

        // Write chunk file
        const chunkPath = path.join(chunksDir, `${hash}.tar.gz`);
        await fsp.writeFile(chunkPath, compressed);

        // Add files to manifest
        for (const relPath of files) {
            const absPath = path.join(inputDir, relPath);
            const stat = await fsp.stat(absPath);
            manifest.files[relPath] = [hash, stat.size];
        }
    }

    // 4. Determine prefetch chunks
    if (prefetchGlobs.length > 0) {
        const prefetchChunks = new Set<string>();
        for (const [chunkName, files] of chunks) {
            for (const file of files) {
                if (matchesAnyGlob(file, prefetchGlobs)) {
                    const hash = chunkNameToHash.get(chunkName)!;
                    prefetchChunks.add(hash);
                    break; // One match is enough to prefetch the whole chunk
                }
            }
        }
        manifest.prefetch = [...prefetchChunks];
    } else {
        // Default: prefetch the rootfs chunk (non-node_modules files)
        const rootfsHash = chunkNameToHash.get('rootfs');
        if (rootfsHash) manifest.prefetch = [rootfsHash];
    }

    // 5. Write manifest
    const manifestPath = path.join(outputDir, 'fs.json');
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    return {
        manifestPath,
        fileCount: relativePaths.length,
        chunkCount: chunks.size,
    };
}

// ---------------------------------------------------------------------------
// Manifest type (matches the runtime LazyManifest)
// ---------------------------------------------------------------------------

interface Manifest {
    version: 1;
    baseUrl: string;
    prefetch: string[];
    files: Record<string, [string, number]>;
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

async function walkDir(dir: string, rootDir: string, excludeGlobs: string[]): Promise<string[]> {
    const results: string[] = [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(rootDir, full);

        // Apply exclude globs
        if (excludeGlobs.length && matchesAnyGlob(rel, excludeGlobs)) continue;

        // Use stat (not lstat) to follow symlinks
        let st;
        try {
            st = await fsp.stat(full);
        } catch {
            continue; // broken symlink or permission error
        }

        if (st.isDirectory()) {
            results.push(...await walkDir(full, rootDir, excludeGlobs));
        } else if (st.isFile()) {
            results.push(full);
        }
    }

    return results;
}

// ---------------------------------------------------------------------------
// Minimal tar archive creator
// ---------------------------------------------------------------------------
// Creates a POSIX tar (ustar) archive in memory.  We only need files
// and their paths — no ownership, permissions, or special entries.

const TAR_BLOCK = 512;
const USTAR_MAGIC = 'ustar\x0000';

async function createTar(baseDir: string, relativePaths: string[]): Promise<Buffer> {
    const blocks: Buffer[] = [];

    for (const relPath of relativePaths) {
        const absPath = path.join(baseDir, relPath);
        const content = await fsp.readFile(absPath);

        // Build header
        const header = Buffer.alloc(TAR_BLOCK);

        // name (0..100) — for paths > 100 chars, use prefix field
        const { name, prefix } = splitTarPath(relPath);
        writeString(header, 0, 100, name);

        // mode (100..108)
        writeOctal(header, 100, 8, 0o644);

        // uid/gid (108..124)
        writeOctal(header, 108, 8, 0);
        writeOctal(header, 116, 8, 0);

        // size (124..136)
        writeOctal(header, 124, 12, content.length);

        // mtime (136..148)
        writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));

        // typeflag (156) — '0' for regular file
        header[156] = 0x30; // '0'

        // magic (257..265) — "ustar\0" "00"
        header.write(USTAR_MAGIC, 257, 'ascii');

        // prefix (345..500)
        if (prefix) writeString(header, 345, 155, prefix);

        // checksum (148..156) — must be computed after all other fields
        const checksum = computeChecksum(header);
        writeOctal(header, 148, 8, checksum);

        blocks.push(header);

        // File data — padded to 512-byte boundary
        const dataBlocks = Math.ceil(content.length / TAR_BLOCK);
        const padded = Buffer.alloc(dataBlocks * TAR_BLOCK);
        content.copy(padded);
        blocks.push(padded);
    }

    // Two zero blocks mark end of archive
    blocks.push(Buffer.alloc(TAR_BLOCK * 2));

    return Buffer.concat(blocks);
}

function splitTarPath(relPath: string): { name: string; prefix: string } {
    // POSIX ustar: name up to 100 chars, prefix up to 155 chars
    if (relPath.length <= 100) return { name: relPath, prefix: '' };

    // Try to split at a directory boundary
    const maxPrefix = 155;
    const maxName = 100;
    for (let i = Math.min(relPath.length - 1, maxPrefix); i > 0; i--) {
        if (relPath[i] === '/') {
            const prefix = relPath.substring(0, i);
            const name = relPath.substring(i + 1);
            if (prefix.length <= maxPrefix && name.length <= maxName) {
                return { name, prefix };
            }
        }
    }

    // Fallback: truncate (shouldn't happen with reasonable paths)
    return { name: relPath.substring(0, 100), prefix: '' };
}

function writeString(buf: Buffer, offset: number, length: number, value: string) {
    buf.write(value, offset, Math.min(value.length, length - 1), 'utf8');
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number) {
    const str = value.toString(8).padStart(length - 1, '0');
    buf.write(str, offset, length - 1, 'ascii');
    buf[offset + length - 1] = 0; // null terminator
}

function computeChecksum(header: Buffer): number {
    // Checksum field (148..156) is treated as spaces during computation
    let sum = 0;
    for (let i = 0; i < TAR_BLOCK; i++) {
        sum += (i >= 148 && i < 156) ? 0x20 : header[i];
    }
    return sum;
}

// ---------------------------------------------------------------------------
// Gzip helper
// ---------------------------------------------------------------------------

function gzip(data: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        zlib.gzip(data, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

// ---------------------------------------------------------------------------
// Simple glob matching (supports * and **)
// ---------------------------------------------------------------------------

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
    return globs.some(glob => matchGlob(filePath, glob));
}

function matchGlob(filePath: string, glob: string): boolean {
    // Convert glob to regex
    const regex = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special chars
        .replace(/\*\*/g, '{{GLOBSTAR}}')         // Placeholder for **
        .replace(/\*/g, '[^/]*')                   // * matches within path segment
        .replace(/{{GLOBSTAR}}/g, '.*');           // ** matches across segments
    return new RegExp(`^${regex}$`).test(filePath);
}
