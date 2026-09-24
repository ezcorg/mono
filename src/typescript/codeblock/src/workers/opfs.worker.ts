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
    const segments = dirPath.split('/').filter(s => s && s !== '.');
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

function normalizePath(path: string): string {
    // Strip leading slash and collapse /./ segments — same normalization
    // used by splitPath, so a path always maps to one canonical key.
    return path.replace(/^\//, '').replace(/\/\.(?=\/|$)/g, '');
}

function splitPath(path: string): { dir: string; name: string } {
    const normalized = normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0
        ? { dir: normalized.substring(0, lastSlash), name: normalized.substring(lastSlash + 1) }
        : { dir: '', name: normalized };
}

// ---------------------------------------------------------------------------
// Per-file serialization.
//
// A sync access handle (createSyncAccessHandle) takes an *exclusive* lock on
// its file in Chromium: a second handle on the same file — even for reading —
// throws "Access Handles cannot be created if there is another open Access
// Handle or Writable stream associated with the same file." The worker's
// message handler runs operations concurrently (it doesn't await one message
// before processing the next), and the same file is routinely touched by
// overlapping callers: two snapshot hydrations under React StrictMode, the
// LSP worker reading a lib file while the editor writes it, etc.
//
// Serialize all access-handle work per (normalized) path so only one handle
// is ever open for a given file at a time, while still allowing full
// concurrency across *different* files.
// ---------------------------------------------------------------------------
const fileLocks = new Map<string, Promise<unknown>>();

function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const key = normalizePath(path);
    const prev = fileLocks.get(key) ?? Promise.resolve();
    // Run fn after the previous op on this path settles (ignore its outcome
    // so one failure doesn't poison the queue).
    const result = prev.then(fn, fn);
    // The tail never rejects, so chaining the next op off it is safe.
    const tail = result.then(() => { }, () => { });
    fileLocks.set(key, tail);
    // Drop the map entry once this op is the last one queued for the path,
    // so the map doesn't grow unbounded across a long session.
    tail.then(() => {
        if (fileLocks.get(key) === tail) fileLocks.delete(key);
    });
    return result;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

let syncHandleSupported: boolean | null = null;

async function readBytes(path: string): Promise<Uint8Array> {
    const { dir, name } = splitPath(path);
    const dirHandle = await getDirHandle(dir);
    const fileHandle = await dirHandle.getFileHandle(name);

    // Try sync access handle (fast path in dedicated workers). Serialize
    // per-path so we never hold two handles on the same file at once.
    if (syncHandleSupported !== false) {
        try {
            return await withFileLock(path, async () => {
                const accessHandle = await (fileHandle as any).createSyncAccessHandle();
                if (syncHandleSupported === null) {
                    syncHandleSupported = true;
                    console.debug('[opfs-worker] createSyncAccessHandle: SUPPORTED');
                }
                try {
                    const size = accessHandle.getSize();
                    const buf = new Uint8Array(size);
                    accessHandle.read(buf, { at: 0 });
                    return buf;
                } finally {
                    accessHandle.close();
                }
            });
        } catch (e) {
            if (syncHandleSupported === null) {
                syncHandleSupported = false;
                console.warn('[opfs-worker] createSyncAccessHandle: NOT SUPPORTED, using getFile() fallback', e);
            } else {
                // Sync handles are supported but this read still failed
                // (genuine I/O error) — surface it rather than masking it
                // behind the getFile() fallback.
                throw e;
            }
        }
    }

    // Fallback: async read via getFile()
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
}

async function readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await readBytes(path));
}

async function writeBytes(path: string, data: Uint8Array): Promise<void> {
    const { dir, name } = splitPath(path);
    const dirHandle = await getDirHandle(dir);
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    await withFileLock(path, async () => {
        const accessHandle = await (fileHandle as any).createSyncAccessHandle();
        try {
            accessHandle.truncate(0);
            accessHandle.write(data, { at: 0 });
            accessHandle.flush();
        } finally {
            accessHandle.close();
        }
    });
}

async function writeFile(path: string, data: string): Promise<void> {
    await writeBytes(path, new TextEncoder().encode(data));
}

/** Move a file or a directory. OPFS's `move()` is used for files where the
 *  browser has it; directories (which not every browser can move) and
 *  browsers without it copy and then remove. */
async function rename(oldPath: string, newPath: string): Promise<void> {
    const from = splitPath(oldPath);
    const to = splitPath(newPath);
    const fromDir = await getDirHandle(from.dir);
    const toDir = await getDirHandle(to.dir);
    let fileHandle: FileSystemFileHandle | null = null;
    try {
        fileHandle = await fromDir.getFileHandle(from.name);
    } catch {
        fileHandle = null;
    }
    if (fileHandle) {
        await withFileLock(oldPath, () => withFileLock(newPath, async () => {
            try {
                await toDir.removeEntry(to.name);
            } catch { /* nothing there */ }
            if (typeof (fileHandle as any).move === 'function') {
                await (fileHandle as any).move(toDir, to.name);
                return;
            }
            const bytes = new Uint8Array(await (await fileHandle!.getFile()).arrayBuffer());
            const target = await toDir.getFileHandle(to.name, { create: true });
            const writable = await (target as any).createWritable();
            await writable.write(bytes);
            await writable.close();
            await fromDir.removeEntry(from.name);
        }));
        return;
    }
    // A directory: copy the tree, then drop the original and its cached handles.
    const source = await fromDir.getDirectoryHandle(from.name);
    const target = await toDir.getDirectoryHandle(to.name, { create: true });
    await copyTree(source, target);
    await fromDir.removeEntry(from.name, { recursive: true });
    const prefix = normalizePath(oldPath);
    for (const key of [...dirCache.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}/`)) dirCache.delete(key);
    }
}

async function copyTree(source: FileSystemDirectoryHandle, target: FileSystemDirectoryHandle): Promise<void> {
    for await (const [name, handle] of (source as any).entries()) {
        if (handle.kind === 'directory') {
            await copyTree(handle, await target.getDirectoryHandle(name, { create: true }));
        } else {
            const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
            const out = await target.getFileHandle(name, { create: true });
            const writable = await (out as any).createWritable();
            await writable.write(bytes);
            await writable.close();
        }
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

async function stat(path: string): Promise<{ type: number; size: number; mtime?: number } | null> {
    const { dir, name } = splitPath(path);
    try {
        const dirHandle = await getDirHandle(dir);
        try {
            const fh = await dirHandle.getFileHandle(name);
            const file = await fh.getFile();
            return { type: 1, size: file.size, mtime: file.lastModified }; // FileType.File
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

const methods: Record<string, (...args: any[]) => Promise<any>> = {
    init: (bucketName: string) => init(bucketName),
    readFile,
    writeFile,
    readBytes,
    writeBytes,
    rename,
    mkdir,
    exists,
    stat,
    readDir,
    unlink,
    clearBucket,
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
            // NotFoundError is expected for resolver probes (e.g. @types/* lookups)
            if (e?.name !== 'NotFoundError') {
                console.warn(`[opfs-worker] ${method}(${args?.[0]}) failed:`, e);
            }
            replyTo.postMessage({ id, error: e?.message ?? String(e) });
        }
    );
}

self.addEventListener('message', (ev) => handleMessage(ev, self as any));
