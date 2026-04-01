/**
 * LazyVfs — a VfsInterface wrapper that combines a backing store
 * (typically OPFS) with a lazy manifest.
 *
 * Directory listings, existence checks, and stats are answered from
 * the manifest without network calls.  File reads trigger on-demand
 * chunk fetches; once extracted the files live in the backing store
 * and are never re-fetched (even across page reloads).
 *
 * Symlinks in the manifest are resolved transparently — readFile on
 * a symlink follows the chain to the real file.
 */

import { FileType } from "@volar/language-service";

// Raw numeric values matching FileType enum, for use in contexts
// where the @volar/language-service import might not resolve the
// enum correctly at runtime (e.g., in a dedicated worker).
const FILE_TYPE_FILE = 1 as FileType;
const FILE_TYPE_DIR = 2 as FileType;
import type { VfsInterface } from "../types";
import { type LazyManifest, buildDirectoryTree, type DirectoryTree } from "./lazy-manifest";
import { ChunkFetcher } from "./chunk-fetcher";

export class LazyVfs implements VfsInterface {
    private backing: VfsInterface;
    private manifest: LazyManifest;
    private dirTree: DirectoryTree;
    private fetcher: ChunkFetcher;

    constructor(
        backing: VfsInterface,
        manifest: LazyManifest,
        fetcher: ChunkFetcher,
    ) {
        this.backing = backing;
        this.manifest = manifest;
        this.dirTree = buildDirectoryTree(manifest);
        this.fetcher = fetcher;
    }

    // -------------------------------------------------------------------
    // Metadata — answered from manifest + backing, no network calls
    // -------------------------------------------------------------------

    async exists(path: string): Promise<boolean> {
        const norm = normalizePath(path);
        // Check manifest first (fast, synchronous)
        if (norm in this.manifest.files || this.dirTree.dirs.has(norm)) return true;
        if (this.manifest.symlinks && norm in this.manifest.symlinks) return true;
        const resolved = this.resolveSymlinks(norm);
        if (resolved !== norm) {
            if (resolved in this.manifest.files || this.dirTree.dirs.has(resolved)) return true;
        }
        // Fall back to backing store (user-created files)
        return this.backing.exists(path);
    }

    async stat(path: string): Promise<any | null> {
        const norm = normalizePath(path);

        // Check manifest first (avoids OPFS round-trip for manifest files)
        let entry = this.manifest.files[norm];
        if (entry) {
            return { type: FILE_TYPE_FILE, size: entry[1], ctime: 0, mtime: 0 };
        }
        if (this.dirTree.dirs.has(norm)) {
            return { type: FILE_TYPE_DIR, size: 0, ctime: 0, mtime: 0 };
        }

        // Try symlink resolution
        const resolved = this.resolveSymlinks(norm);
        if (resolved !== norm) {
            entry = this.manifest.files[resolved];
            if (entry) {
                return { type: FILE_TYPE_FILE, size: entry[1], ctime: 0, mtime: 0 };
            }
            if (this.dirTree.dirs.has(resolved)) {
                return { type: FILE_TYPE_DIR, size: 0, ctime: 0, mtime: 0 };
            }
        }

        // Fall back to backing store (user-created files)
        return this.backing.stat(path).catch(() => null);
    }

    async readDir(path: string): Promise<[string, FileType][]> {
        const norm = normalizePath(path);
        const resolved = this.resolveSymlinks(norm);

        // Get manifest entries (always available, no OPFS call)
        const manifestEntries = this.dirTree.children.get(resolved)
            ?? this.dirTree.children.get(norm)
            ?? [];

        // Get backing entries (user-created files)
        let backingEntries: [string, FileType][] = [];
        try {
            backingEntries = await this.backing.readDir(path);
        } catch { /* directory may not exist in backing */ }

        // Merge: manifest first, then backing for user-created files
        const seen = new Set<string>();
        const merged: [string, FileType][] = [];
        for (const [name, isDir] of manifestEntries) {
            seen.add(name);
            merged.push([name, isDir ? FILE_TYPE_DIR : FILE_TYPE_FILE]);
        }
        for (const [name, type] of backingEntries) {
            if (!seen.has(name)) {
                merged.push([name, type]);
            }
        }
        return merged;
    }

    // -------------------------------------------------------------------
    // Content — triggers chunk hydration on cache miss
    // -------------------------------------------------------------------

    async readFile(path: string): Promise<string> {
        const norm = normalizePath(path);

        // Check the manifest first — if the file is in a chunk, read
        // directly from the zip archive (no per-file OPFS extraction).
        let entry = this.manifest.files[norm];
        let readPath = norm;

        // Try symlink resolution if not found directly
        if (!entry) {
            const resolved = this.resolveSymlinks(norm);
            if (resolved !== norm) {
                entry = this.manifest.files[resolved];
                readPath = resolved;
            }
        }

        if (entry) {
            const [chunkId] = entry;
            await this.fetcher.hydrate(chunkId);
            const data = await this.fetcher.readFromChunk(chunkId, readPath);
            const content = new TextDecoder().decode(data);
            return content;
        }

        // Not in manifest — try backing store (user-created files)
        return this.backing.readFile(path);
    }

    // -------------------------------------------------------------------
    // Mutations — delegate directly to backing store
    // -------------------------------------------------------------------

    async writeFile(path: string, data: string): Promise<void> {
        return this.backing.writeFile(path, data);
    }

    async mkdir(path: string, options: { recursive: boolean }): Promise<void> {
        return this.backing.mkdir(path, options);
    }

    async unlink(path: string): Promise<void> {
        return this.backing.unlink(path);
    }

    watch(path: string, options: { signal: AbortSignal }) {
        return this.backing.watch(path, options);
    }

    // -------------------------------------------------------------------
    // Symlink resolution
    // -------------------------------------------------------------------

    /**
     * Follow symlink chains in the manifest to find the real path.
     *
     * Unlike a simple lookup, this walks each segment of the path from
     * root to leaf.  If any prefix is a symlink, it resolves that prefix
     * and appends the remaining segments.  This handles the common pnpm
     * pattern where `node_modules/pkg` is a symlink but the caller reads
     * `node_modules/pkg/package.json`.
     */
    private resolveSymlinks(norm: string): string {
        if (!this.manifest.symlinks) return norm;

        const parts = norm.split('/');
        let resolved = '';

        for (let i = 0; i < parts.length; i++) {
            const candidate = resolved ? `${resolved}/${parts[i]}` : parts[i];

            const target = this.manifest.symlinks[candidate];
            if (target) {
                // This segment is a symlink — resolve it and append the rest
                const resolvedTarget = resolveRelative(candidate, target);
                const rest = parts.slice(i + 1).join('/');
                const full = rest ? `${resolvedTarget}/${rest}` : resolvedTarget;
                // Recurse to handle chained symlinks in the resolved path
                return this.resolveSymlinks(full);
            }

            resolved = candidate;
        }

        return resolved;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePath(path: string): string {
    return path.replace(/^\.?\//, '');
}

/** Resolve a potentially-relative target path against a link's location. */
function resolveRelative(linkPath: string, target: string): string {
    if (!target.startsWith('.')) return target;
    const linkDir = linkPath.substring(0, linkPath.lastIndexOf('/'));
    const parts = linkDir.split('/').filter(Boolean);
    for (const seg of target.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.') parts.push(seg);
    }
    return parts.join('/');
}
