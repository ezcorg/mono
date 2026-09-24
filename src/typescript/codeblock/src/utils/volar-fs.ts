import { statTime, type VfsInterface } from "@joinezco/storage";
import { FileSystem, FileType } from '@volar/language-service';
import { URI } from 'vscode-uri';

/** A vault as Volar's language service reads it, with the caches a
 *  language server needs (TypeScript's lib files, node_modules). */
export class VolarFs implements FileSystem {
    #fs: VfsInterface
    #fileCache = new Map<string, string>()
    #fileCacheBytes = 0
    #statCache = new Map<string, { type: FileType; ctime: number; mtime: number; size: number }>()
    #dirCache = new Map<string, [string, FileType][]>()

    /** Approximate memory limit for #fileCache (~64 MB). */
    static readonly FILE_CACHE_LIMIT = 64 * 1024 * 1024;

    constructor(fs: VfsInterface) {
        this.#fs = fs
    }

    /** Estimated bytes per character (V8 uses UTF-16 = 2 bytes per char). */
    static #charBytes(content: string): number {
        return content.length * 2;
    }

    /** Insert or refresh a file in the LRU cache, evicting if over limit. */
    #cacheFile(path: string, content: string): void {
        // If already present, remove first so re-insertion moves it to end (LRU)
        const existing = this.#fileCache.get(path);
        if (existing !== undefined) {
            this.#fileCacheBytes -= VolarFs.#charBytes(existing);
            this.#fileCache.delete(path);
        }

        const bytes = VolarFs.#charBytes(content);
        this.#fileCache.set(path, content);
        this.#fileCacheBytes += bytes;

        // Evict oldest entries until under limit
        while (this.#fileCacheBytes > VolarFs.FILE_CACHE_LIMIT && this.#fileCache.size > 1) {
            const oldest = this.#fileCache.keys().next().value!;
            const oldContent = this.#fileCache.get(oldest)!;
            this.#fileCacheBytes -= VolarFs.#charBytes(oldContent);
            this.#fileCache.delete(oldest);
        }
    }

    /**
     * Synchronously populate the cache from a pre-resolved map of path → content.
     * This bypasses async VFS reads entirely, ensuring TypeScript gets lib files
     * immediately on first program creation.
     */
    preloadFromMap(files: Record<string, string>): void {
        const now = Date.now();
        for (const [path, content] of Object.entries(files)) {
            this.#cacheFile(path, content);
            this.#statCache.set(path, {
                type: FileType.File,
                ctime: now,
                mtime: now,
                size: content.length,
            });
        }
        // Build directory tree from file paths
        const dirChildren = new Map<string, Map<string, FileType>>();
        for (const path of Object.keys(files)) {
            let dir = path;
            let child = '';
            while (true) {
                const lastSlash = dir.lastIndexOf('/');
                if (lastSlash < 0) break;
                child = dir.substring(lastSlash + 1);
                dir = dir.substring(0, lastSlash) || '/';

                if (!dirChildren.has(dir)) {
                    dirChildren.set(dir, new Map());
                }
                const children = dirChildren.get(dir)!;
                // First encounter of this child — it's the file itself
                if (!children.has(child)) {
                    // If we've already seen this as a parent dir, it's a Directory
                    children.set(child, dirChildren.has(dir === '/' ? `/${child}` : `${dir}/${child}`) ? FileType.Directory : FileType.File);
                }
                if (dir === '/') break;
            }
        }
        // Update directory type for children that are actually directories
        for (const [dirPath, children] of dirChildren) {
            for (const [name] of children) {
                const fullPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`;
                if (dirChildren.has(fullPath)) {
                    children.set(name, FileType.Directory);
                }
            }
        }
        // Cache directory listings and stats
        for (const [dirPath, children] of dirChildren) {
            this.#dirCache.set(dirPath, [...children.entries()]);
            this.#statCache.set(dirPath, {
                type: FileType.Directory,
                ctime: now,
                mtime: now,
                size: 0,
            });
        }
    }

    stat(uri: URI) {
        const cached = this.#statCache.get(uri.path);
        if (cached) return cached;
        // Volar wants numeric times; a VFS may report `Date`s (memfs, Node).
        return Promise.resolve(this.#fs.stat(uri.path)).then((s) => s
            ? { type: s.type, size: s.size, ctime: statTime(s.ctime), mtime: statTime(s.mtime) }
            : undefined);
    }
    readDirectory(uri: URI) {
        // Only use dirCache for node_modules subtree (stable, preloaded).
        // Root and user directories must go through live VFS to pick up new files.
        if (uri.path.startsWith('/node_modules/')) {
            const cached = this.#dirCache.get(uri.path);
            if (cached) return cached;
        }
        return this.#fs.readDir(uri.path);
    }
    readFile(uri: URI): string | Promise<string> {
        const cached = this.#fileCache.get(uri.path);
        if (cached !== undefined) {
            // Touch: move to end of LRU
            this.#fileCache.delete(uri.path);
            this.#fileCache.set(uri.path, cached);
            return cached;
        }
        // Cache miss — read from VFS and cache the result.
        // Always wrap in Promise.resolve() to normalize Comlink proxy
        // thenables into real Promises. This is critical because Volar's
        // fileSystem cache stores the raw return value — a Comlink proxy
        // thenable behaves differently from a real Promise when cached
        // (proxy property access creates new proxies on every access).
        const result = this.#fs.readFile(uri.path);
        return Promise.resolve(result).then(content => {
            this.#cacheFile(uri.path, content);
            return content;
        });
    }

    getCacheSize(): number {
        return this.#fileCache.size;
    }

    getCacheSizeBytes(): number {
        return this.#fileCacheBytes;
    }
}