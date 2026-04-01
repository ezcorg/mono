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
    return new URL(`${chunkId}.tar.gz`, base).href;
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

    for (const filePath of Object.keys(manifest.files)) {
        // Register the file as a child of its parent directory
        const lastSlash = filePath.lastIndexOf('/');
        const parentDir = lastSlash === -1 ? '' : filePath.substring(0, lastSlash);
        const fileName = lastSlash === -1 ? filePath : filePath.substring(lastSlash + 1);

        if (!children.has(parentDir)) children.set(parentDir, []);
        const siblings = children.get(parentDir)!;
        if (!siblings.some(([n]) => n === fileName)) {
            siblings.push([fileName, false]);
        }

        // Walk up the path creating intermediate directories
        let dir = parentDir;
        while (dir !== '') {
            if (dirs.has(dir)) break; // already registered everything above
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

    return { dirs, children };
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
