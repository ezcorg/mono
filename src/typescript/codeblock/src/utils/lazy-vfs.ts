/**
 * LazyVfs — a VfsInterface wrapper that combines a backing store
 * (typically OPFS) with a lazy manifest.
 *
 * Directory listings, existence checks, and stats are answered from
 * the manifest without network calls.  File reads trigger on-demand
 * chunk fetches; once extracted the files live in the backing store
 * and are never re-fetched (even across page reloads).
 */

import { FileType } from "@volar/language-service";
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
        // Check backing store first (covers user-created files + hydrated files)
        if (await this.backing.exists(path)) return true;
        // Check manifest
        return norm in this.manifest.files || this.dirTree.dirs.has(norm);
    }

    async stat(path: string): Promise<any | undefined> {
        const norm = normalizePath(path);
        // Try backing store
        const backingStat = await this.backing.stat(path).catch(() => undefined);
        if (backingStat) return backingStat;
        // Synthetic stat from manifest
        const entry = this.manifest.files[norm];
        if (entry) {
            const [, size] = entry;
            return {
                type: FileType.File,
                size,
                ctime: 0,
                mtime: 0,
            };
        }
        if (this.dirTree.dirs.has(norm)) {
            return {
                type: FileType.Directory,
                size: 0,
                ctime: 0,
                mtime: 0,
            };
        }
        return undefined;
    }

    async readDir(path: string): Promise<[string, FileType][]> {
        const norm = normalizePath(path);
        // Get entries from backing store
        let backingEntries: [string, FileType][] = [];
        try {
            backingEntries = await this.backing.readDir(path);
        } catch { /* directory may not exist in backing yet */ }

        // Get entries from manifest
        const manifestEntries = this.dirTree.children.get(norm) ?? [];

        // Merge: backing entries take precedence (they're real files)
        const seen = new Set(backingEntries.map(([name]) => name));
        const merged = [...backingEntries];
        for (const [name, isDir] of manifestEntries) {
            if (!seen.has(name)) {
                merged.push([name, isDir ? FileType.Directory : FileType.File]);
            }
        }
        return merged;
    }

    // -------------------------------------------------------------------
    // Content — triggers chunk hydration on cache miss
    // -------------------------------------------------------------------

    async readFile(path: string): Promise<string> {
        const norm = normalizePath(path);
        // Try backing store first
        try {
            return await this.backing.readFile(path);
        } catch {
            // Not in backing store — check manifest
        }

        const entry = this.manifest.files[norm];
        if (!entry) throw new Error(`ENOENT: ${path}`);

        const [chunkId] = entry;
        await this.fetcher.hydrate(chunkId);

        // After hydration, the file should be in the backing store
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a path for manifest lookup: strip leading `/` and `./`. */
function normalizePath(path: string): string {
    return path.replace(/^\.?\//, '');
}
