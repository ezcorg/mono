/**
 * Lazy filesystem manifest — describes a tree of files split into
 * individually-fetchable chunks.  Shared by the runtime (browser)
 * and the `lazy-pack` CLI (Node).
 *
 * The manifest is intentionally a plain JSON structure with no
 * special classes so it survives `JSON.parse` / structured-clone
 * without wrappers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * On-disk manifest format (`fs.json`).
 *
 * ```jsonc
 * {
 *   "version": 1,
 *   "baseUrl": "./chunks/",
 *   "prefetch": ["a1b2c3"],
 *   "files": {
 *     "usr/bin/wasibox":                      ["a1b2c3", 45678],
 *     "node_modules/typescript/lib/lib.es5.d.ts": ["d4e5f6", 243800]
 *   }
 * }
 * ```
 */
export interface LazyManifest {
    /** Schema version — currently always 1. */
    version: 1;
    /** Base URL for chunk files, relative to the manifest URL. */
    baseUrl: string;
    /** Chunk IDs to fetch eagerly after manifest load. */
    prefetch: string[];
    /**
     * Map of file paths to `[chunkId, uncompressedSizeBytes]`.
     * Paths are relative (no leading `/`).
     */
    files: Record<string, [chunkId: string, size: number]>;
    /**
     * Map of symlink paths to their targets (relative paths).
     * Symlinks are resolved at read time without fetching a chunk.
     */
    symlinks?: Record<string, string>;
}

/** Pre-computed directory tree derived from manifest file paths. */
export interface DirectoryTree {
    /** Set of all directory paths (no trailing `/`). */
    dirs: Set<string>;
    /** Map from directory path → immediate child entries `[name, isDir]`. */
    children: Map<string, [name: string, isDir: boolean][]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch and parse a manifest from a URL. */
export async function loadManifest(url: string): Promise<LazyManifest> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load lazy manifest: ${res.status} ${url}`);
    const data: LazyManifest = await res.json();
    if (data.version !== 1) throw new Error(`Unsupported lazy manifest version: ${data.version}`);
    return data;
}

/** Resolve a chunk ID to its full fetch URL. */
export function getChunkUrl(manifest: LazyManifest, chunkId: string, manifestUrl: string): string {
    // Resolve baseUrl relative to the manifest's own URL.
    // manifestUrl may be relative (e.g. "/lazy/fs.json"), so resolve
    // against the page origin first to get a valid URL base.
    const absManifest = new URL(manifestUrl, globalThis.location?.href ?? 'file:///');
    const base = new URL(manifest.baseUrl, absManifest);
    return new URL(`${chunkId}.zip`, base).href;
}

/** Return all file paths that belong to a given chunk. */
export function getFilesInChunk(manifest: LazyManifest, chunkId: string): string[] {
    const paths: string[] = [];
    for (const [path, [cid]] of Object.entries(manifest.files)) {
        if (cid === chunkId) paths.push(path);
    }
    return paths;
}

/**
 * Build a directory tree from the manifest's file paths.
 *
 * This is computed once at load time and used to answer
 * `readDir`, `exists`, and `stat` for directories without
 * any network calls.
 */
export function buildDirectoryTree(manifest: LazyManifest): DirectoryTree {
    const dirs = new Set<string>();
    const children = new Map<string, [string, boolean][]>();

    // Ensure the root is always present
    dirs.add('');

    // Helper: register a path and all its parent directories
    function registerPath(filePath: string, isDir: boolean) {
        const lastSlash = filePath.lastIndexOf('/');
        const parentDir = lastSlash === -1 ? '' : filePath.substring(0, lastSlash);
        const name = lastSlash === -1 ? filePath : filePath.substring(lastSlash + 1);

        if (!children.has(parentDir)) children.set(parentDir, []);
        const siblings = children.get(parentDir)!;
        if (!siblings.some(([n]) => n === name)) {
            siblings.push([name, isDir]);
        }

        // Walk up the path creating intermediate directories
        let dir = parentDir;
        while (dir !== '') {
            if (dirs.has(dir)) break;
            dirs.add(dir);
            const parentSlash = dir.lastIndexOf('/');
            const parent = parentSlash === -1 ? '' : dir.substring(0, parentSlash);
            const dirName = parentSlash === -1 ? dir : dir.substring(parentSlash + 1);
            if (!children.has(parent)) children.set(parent, []);
            const parentChildren = children.get(parent)!;
            if (!parentChildren.some(([n]) => n === dirName)) {
                parentChildren.push([dirName, true]);
            }
            dir = parent;
        }
    }

    // Register real files
    for (const filePath of Object.keys(manifest.files)) {
        registerPath(filePath, false);
    }

    // Register symlinks — a symlink whose target is a directory appears
    // as a directory in listings so `readDir` works through it.
    if (manifest.symlinks) {
        for (const [linkPath, target] of Object.entries(manifest.symlinks)) {
            // Determine if the target is a directory by checking if any
            // manifest path starts with `resolved target + /`.
            const resolved = resolveSymlinkTarget(linkPath, target);
            const targetIsDir = dirs.has(resolved)
                || Object.keys(manifest.files).some(f => f.startsWith(resolved + '/'));
            registerPath(linkPath, targetIsDir);
        }
    }

    return { dirs, children };
}

/** Resolve a potentially-relative symlink target against the link's location. */
function resolveSymlinkTarget(linkPath: string, target: string): string {
    if (!target.startsWith('.')) return target;
    const linkDir = linkPath.substring(0, linkPath.lastIndexOf('/'));
    const parts = linkDir.split('/').filter(Boolean);
    for (const seg of target.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.') parts.push(seg);
    }
    return parts.join('/');
}

/**
 * Return the set of unique chunk IDs referenced by the manifest.
 */
export function getChunkIds(manifest: LazyManifest): Set<string> {
    const ids = new Set<string>();
    for (const [cid] of Object.values(manifest.files)) {
        ids.add(cid);
    }
    return ids;
}
