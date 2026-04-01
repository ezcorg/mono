/**
 * Dedicated OPFS Worker — owns all Origin Private File System access.
 *
 * Spawned by the fs SharedWorker.  Uses createSyncAccessHandle() for
 * fast synchronous reads/writes (only available in dedicated Workers).
 *
 * Protocol: simple request/response messages on the global scope.
 * { id, method, args } → { id, result } | { id, error }
 */

let root: FileSystemDirectoryHandle | null = null;
let bucketHandle: FileSystemDirectoryHandle | null = null;

// Cache directory handles to avoid re-traversing for every operation
const dirCache = new Map<string, FileSystemDirectoryHandle>();

async function init(bucketName: string) {
    root = await navigator.storage.getDirectory();
    bucketHandle = await root.getDirectoryHandle(bucketName, { create: true });
    dirCache.set('', bucketHandle);
}

async function getDirHandle(dirPath: string): Promise<FileSystemDirectoryHandle> {
    if (dirCache.has(dirPath)) return dirCache.get(dirPath)!;
    const segments = dirPath.split('/').filter(Boolean);
    let handle = bucketHandle!;
    let built = '';
    for (const seg of segments) {
        built = built ? `${built}/${seg}` : seg;
        if (dirCache.has(built)) {
            handle = dirCache.get(built)!;
        } else {
            handle = await handle.getDirectoryHandle(seg, { create: true });
            dirCache.set(built, handle);
        }
    }
    return handle;
}

function splitPath(path: string): { dir: string; name: string } {
    const normalized = path.replace(/^\//, '');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0
        ? { dir: normalized.substring(0, lastSlash), name: normalized.substring(lastSlash + 1) }
        : { dir: '', name: normalized };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

let syncHandleSupported: boolean | null = null;

async function readFile(path: string): Promise<string> {
    const { dir, name } = splitPath(path);
    const dirHandle = await getDirHandle(dir);
    const fileHandle = await dirHandle.getFileHandle(name);

    // Try sync access handle (fast path in dedicated workers)
    if (syncHandleSupported !== false) {
        try {
            const accessHandle = await (fileHandle as any).createSyncAccessHandle();
            if (syncHandleSupported === null) {
                syncHandleSupported = true;
                console.debug('[opfs-worker] createSyncAccessHandle: SUPPORTED');
            }
            try {
                const size = accessHandle.getSize();
                const buf = new Uint8Array(size);
                accessHandle.read(buf, { at: 0 });
                return new TextDecoder().decode(buf);
            } finally {
                accessHandle.close();
            }
        } catch (e) {
            if (syncHandleSupported === null) {
                syncHandleSupported = false;
                console.warn('[opfs-worker] createSyncAccessHandle: NOT SUPPORTED, using getFile() fallback', e);
            }
        }
    }

    // Fallback: async read via getFile()
    const file = await fileHandle.getFile();
    return file.text();
}

async function writeFile(path: string, data: string): Promise<void> {
    const { dir, name } = splitPath(path);
    const dirHandle = await getDirHandle(dir);
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const accessHandle = await (fileHandle as any).createSyncAccessHandle();
    try {
        const encoded = new TextEncoder().encode(data);
        accessHandle.truncate(0);
        accessHandle.write(encoded, { at: 0 });
        accessHandle.flush();
    } finally {
        accessHandle.close();
    }
}

async function writeBinary(path: string, data: Uint8Array): Promise<void> {
    const { dir, name } = splitPath(path);
    const dirHandle = await getDirHandle(dir);
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const accessHandle = await (fileHandle as any).createSyncAccessHandle();
    try {
        accessHandle.truncate(0);
        accessHandle.write(data, { at: 0 });
        accessHandle.flush();
    } finally {
        accessHandle.close();
    }
}

async function mkdir(path: string): Promise<void> {
    const normalized = path.replace(/^\//, '');
    if (!normalized) return;
    await getDirHandle(normalized);
}

async function exists(path: string): Promise<boolean> {
    const { dir, name } = splitPath(path);
    try {
        const dirHandle = await getDirHandle(dir);
        // Try as file first, then directory
        try {
            await dirHandle.getFileHandle(name);
            return true;
        } catch {
            await dirHandle.getDirectoryHandle(name);
            return true;
        }
    } catch {
        return false;
    }
}

async function stat(path: string): Promise<{ type: number; size: number } | null> {
    const { dir, name } = splitPath(path);
    try {
        const dirHandle = await getDirHandle(dir);
        try {
            const fh = await dirHandle.getFileHandle(name);
            const file = await fh.getFile();
            return { type: 1, size: file.size }; // FileType.File
        } catch {
            try {
                await dirHandle.getDirectoryHandle(name);
                return { type: 2, size: 0 }; // FileType.Directory
            } catch {
                return null;
            }
        }
    } catch {
        return null;
    }
}

async function readDir(path: string): Promise<[string, number][]> {
    const normalized = path.replace(/^\//, '');
    try {
        const dirHandle = await getDirHandle(normalized);
        const entries: [string, number][] = [];
        for await (const [name, handle] of (dirHandle as any).entries()) {
            entries.push([name, handle.kind === 'directory' ? 2 : 1]);
        }
        return entries;
    } catch {
        return [];
    }
}

async function unlink(path: string): Promise<void> {
    const { dir, name } = splitPath(path);
    const dirHandle = await getDirHandle(dir);
    await dirHandle.removeEntry(name);
}

async function clearBucket(bucketName: string): Promise<void> {
    if (!root) root = await navigator.storage.getDirectory();
    try {
        await root.removeEntry(bucketName, { recursive: true });
    } catch { /* doesn't exist */ }
    dirCache.clear();
    bucketHandle = await root.getDirectoryHandle(bucketName, { create: true });
    dirCache.set('', bucketHandle);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function fetchUrl(url: string): Promise<ArrayBuffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
    return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Lazy VFS — runs entirely in this dedicated worker
// ---------------------------------------------------------------------------

let lazyVfsInstance: any = null;

async function mountLazy(opts: { manifestUrl: string; backingName: string }): Promise<void> {
    const { manifestUrl, backingName } = opts;

    // Initialize OPFS bucket
    await init(backingName);

    // Create a VfsInterface that wraps our local OPFS methods
    const backing = {
        readFile: (path: string) => readFile(path),
        writeFile: (path: string, data: string) => writeFile(path, data),
        mkdir: async (path: string, options?: { recursive?: boolean }) => {
            const normalized = path.replace(/^\//, '');
            if (!normalized) return;
            if (options?.recursive) {
                const parts = normalized.split('/').filter(Boolean);
                for (let i = 0; i < parts.length; i++) {
                    await mkdir(parts.slice(0, i + 1).join('/'));
                }
            } else {
                await mkdir(normalized);
            }
        },
        readDir,
        exists,
        stat,
        unlink,
        watch: async function* () {},
    };

    // Load manifest
    const manifestRes = await fetch(manifestUrl);
    if (!manifestRes.ok) throw new Error(`Failed to load manifest: ${manifestRes.status}`);
    const manifest = await manifestRes.json();

    // Check version
    const { subtle } = crypto;
    const keys = Object.keys(manifest.files).sort().join('\n');
    const hashBuf = await subtle.digest('SHA-256', new TextEncoder().encode(keys));
    const manifestHash = Array.from(new Uint8Array(hashBuf)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');

    let storedHash = '';
    try { storedHash = await readFile('.lazy-version'); } catch {}
    if (storedHash !== manifestHash) {
        console.debug(`[opfs-worker] Manifest changed (${storedHash || 'none'} → ${manifestHash}), clearing`);
        await clearBucket(backingName);
        await writeFile('.lazy-version', manifestHash);
    }

    // Build directory tree, create LazyVfs + ChunkFetcher
    // Import dynamically to keep the worker lean on initial load
    const { LazyVfs } = await import('../utils/lazy-vfs');
    const { ChunkFetcher } = await import('../utils/chunk-fetcher');

    const fetcher = new ChunkFetcher({
        manifest,
        manifestUrl,
        fetchChunk: fetchUrl,
        async writeFile(path, data) {
            try {
                await writeBinary(path, data);
            } catch {
                const parent = path.substring(0, path.lastIndexOf('/'));
                if (parent) await backing.mkdir(parent, { recursive: true });
                await writeBinary(path, data);
            }
        },
        async ensureDir(path) {
            await backing.mkdir(path, { recursive: true }).catch(() => {});
        },
        async readFile(path) {
            const { dir, name } = (() => {
                const normalized = path.replace(/^\//, '');
                const lastSlash = normalized.lastIndexOf('/');
                return lastSlash >= 0
                    ? { dir: normalized.substring(0, lastSlash), name: normalized.substring(lastSlash + 1) }
                    : { dir: '', name: normalized };
            })();
            const dirHandle = await getDirHandle(dir);
            const fileHandle = await dirHandle.getFileHandle(name);
            const accessHandle = await (fileHandle as any).createSyncAccessHandle();
            try {
                const size = accessHandle.getSize();
                const buf = new ArrayBuffer(size);
                accessHandle.read(new Uint8Array(buf), { at: 0 });
                return buf;
            } finally {
                accessHandle.close();
            }
        },
    });
    fetcher.prefetch();

    lazyVfsInstance = new LazyVfs(backing, manifest, fetcher);
    console.debug('[opfs-worker] LazyVfs mounted');
}

// Proxy methods that delegate to the LazyVfs when mounted
async function lazyReadFile(path: string): Promise<string> {
    if (lazyVfsInstance) return lazyVfsInstance.readFile(path);
    return readFile(path);
}
async function lazyExists(path: string): Promise<boolean> {
    if (lazyVfsInstance) return lazyVfsInstance.exists(path);
    return exists(path);
}
async function lazyStat(path: string): Promise<any> {
    if (lazyVfsInstance) return lazyVfsInstance.stat(path);
    return stat(path);
}
async function lazyReadDir(path: string): Promise<any> {
    if (lazyVfsInstance) return lazyVfsInstance.readDir(path);
    return readDir(path);
}

const methods: Record<string, (...args: any[]) => Promise<any>> = {
    init: (bucketName: string) => init(bucketName),
    readFile,
    writeFile,
    writeBinary: (path: string, data: Uint8Array) => writeBinary(path, data),
    mkdir,
    exists,
    stat,
    readDir,
    unlink,
    clearBucket,
    fetchUrl,
    mountLazy,
    // Lazy-aware methods (used by the VFS port from the LSP worker)
    lazyReadFile,
    lazyExists,
    lazyStat,
    lazyReadDir,
};

let messageCount = 0;

function handleMessage(ev: MessageEvent, replyTo: { postMessage: (msg: any) => void }) {
    const data = ev.data;

    // Handle init-port message from main thread (provides a MessagePort
    // for the SharedWorker to communicate with us directly).
    if (data?.type === 'init-port' && data.port) {
        const port = data.port as MessagePort;
        port.start();
        port.addEventListener('message', (e) => handleMessage(e, port));
        return;
    }

    const { id, method, args } = data;
    messageCount++;

    const fn = methods[method];
    if (!fn) {
        console.warn(`[opfs-worker] unknown method: ${method}`);
        replyTo.postMessage({ id, error: `Unknown OPFS method: ${method}` });
        return;
    }

    fn(...args).then(
        result => replyTo.postMessage({ id, result: result ?? null }),
        (e: any) => {
            console.warn(`[opfs-worker] ${method}(${args?.[0]}) failed:`, e);
            replyTo.postMessage({ id, error: e?.message ?? String(e) });
        }
    );
}

self.addEventListener('message', (ev) => handleMessage(ev, self as any));
