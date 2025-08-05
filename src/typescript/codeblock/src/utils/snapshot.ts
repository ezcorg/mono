import fsPromises from 'fs/promises';
import multimatch from 'multimatch';
import { SnapshotNode } from '@ezdevlol/memfs/snapshot';
import { CborEncoder } from '@jsonjoy.com/json-pack/lib/cbor/CborEncoder';
import { CborDecoder } from '@jsonjoy.com/json-pack/lib/cbor/CborDecoder';
import { Writer } from '@jsonjoy.com/util/lib/buffers/Writer';
import { CborUint8Array } from '@jsonjoy.com/json-pack/lib/cbor/types';
import { FsApi } from '@ezdevlol/memfs/node/types';

export const writer = new Writer(1024 * 32);
const encoder = new CborEncoder(writer);
const decoder = new CborDecoder();

// Cross-platform compression utilities
const isNode = typeof process !== 'undefined' && process.versions?.node;

/**
 * Compress data using gzip compression.
 * Uses Node.js zlib in Node.js environment, browser CompressionStream in browser.
 */
const compress = async (data: Uint8Array): Promise<Uint8Array> => {
    if (isNode) {
        // Node.js environment
        try {
            const { gzip } = await import('zlib');
            const { promisify } = await import('util');
            const gzipAsync = promisify(gzip);
            return new Uint8Array(await gzipAsync(data));
        } catch (error) {
            console.warn('Node.js compression failed, returning uncompressed data:', error);
            return data;
        }
    } else {
        // Browser environment
        if (typeof CompressionStream === 'undefined') {
            // Fallback: return uncompressed data if CompressionStream is not available
            console.warn('CompressionStream not available, returning uncompressed data');
            return data;
        }

        try {
            const stream = new CompressionStream('gzip');
            const writer = stream.writable.getWriter();
            const reader = stream.readable.getReader();

            writer.write(data);
            writer.close();

            const chunks: Uint8Array[] = [];
            let done = false;

            while (!done) {
                const { value, done: readerDone } = await reader.read();
                done = readerDone;
                if (value) chunks.push(value);
            }

            // Concatenate all chunks
            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }

            return result;
        } catch (error) {
            console.warn('Browser compression failed, returning uncompressed data:', error);
            return data;
        }
    }
};

/**
 * Decompress gzip-compressed data.
 * Uses Node.js zlib in Node.js environment, browser DecompressionStream in browser.
 */
/**
 * Check if data appears to be gzip compressed by looking at the magic bytes
 */
const isGzipCompressed = (data: Uint8Array): boolean => {
    return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
};

const decompress = async (data: Uint8Array): Promise<Uint8Array> => {
    console.log('decompressData: Starting decompression, data length:', data.length);
    console.log('decompressData: First few bytes:', Array.from(data.slice(0, 10)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));

    // Check if data is actually compressed
    if (!isGzipCompressed(data)) {
        console.log('decompressData: Data does not appear to be gzip compressed, returning as-is');
        return data;
    }

    console.log('decompressData: Data appears to be gzip compressed');

    if (isNode) {
        console.log('decompressData: Using Node.js zlib');
        // Node.js environment
        const { gunzip } = await import('zlib');
        const { promisify } = await import('util');
        const gunzipAsync = promisify(gunzip);
        const result = new Uint8Array(await gunzipAsync(data));
        console.log('decompressData: Node.js decompression successful, result length:', result.length);
        return result;
    } else {
        console.log('decompressData: Using browser DecompressionStream');
        // Browser environment
        if (typeof DecompressionStream === 'undefined') {
            // Fallback: assume data is uncompressed if DecompressionStream is not available
            console.warn('decompressData: DecompressionStream not available, assuming uncompressed data');
            return data;
        }

        try {
            const stream = new DecompressionStream('gzip');
            const writer = stream.writable.getWriter();
            const reader = stream.readable.getReader();

            console.log('decompressData: Writing data to decompression stream');
            writer.write(data);
            writer.close();

            const chunks: Uint8Array[] = [];
            let done = false;

            console.log('decompressData: Reading decompressed chunks');
            while (!done) {
                const { value, done: readerDone } = await reader.read();
                done = readerDone;
                if (value) {
                    console.log('decompressData: Received chunk of length:', value.length);
                    chunks.push(value);
                }
            }

            // Concatenate all chunks
            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            console.log('decompressData: Total decompressed length:', totalLength);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }

            console.log('decompressData: Browser decompression successful');
            return result;
        } catch (error) {
            console.warn('decompressData: Browser decompression failed, returning original data:', error);
            return data;
        }
    }
};

export type BuildPathFilterArgs = {
    include?: string[],
    exclude?: string[]
}

export const buildFilter = ({ include, exclude }: BuildPathFilterArgs) => {

    return (path: string) => {
        if (!(include || exclude)) return true;

        const included = include ? !!multimatch(path, include, { partial: true }).length : true;
        const excluded = exclude ? !!multimatch(path, exclude).length : false;

        return included && !excluded;
    }
}

export type IgnoreArgs = {
    fs: typeof fsPromises,
    root: string,
    exclude: string[],
    gitignore: string | null
}

export const getGitignored = async (path: string, fs = typeof fsPromises) => {
    // @ts-expect-error
    const content = await fs.readFile(path, 'utf-8')
    // @ts-ignore
    return parse(content).patterns;
};

export type TakeSnapshotProps = {
    root: string;
    filter: (path: string) => (Promise<boolean> | boolean);
};

export const snapshotDefaults: TakeSnapshotProps = {
    root: typeof process !== 'undefined' ? process.cwd() : './',
    filter: () => Promise.resolve(true),
};

/**
 * Takes a snapshot of the file system based on the provided properties.
 * The snapshot is encoded with CBOR and compressed with gzip.
 *
 * @param props - The properties to configure the snapshot.
 */
export const takeSnapshot = async (props: Partial<TakeSnapshotProps> = {}) => {
    const { root, filter } = { ...snapshotDefaults, ...props };

    console.log('Taking snapshot of filesystem', { root, filter });

    const snapshot = await Snapshot
        .take({ fs: fsPromises, path: root, filter })
        .then((snapshot) => encoder.encode(snapshot))
        .then((encoded) => compress(encoded));
    return snapshot;
};

export type SnapshotOptions = {
    fs: FsApi,
    path?: string,
    separator?: string,
}

export namespace Snapshot {
    // TODO: refactor `from` here

    export const take = async ({ fs, path, filter, separator = '/' }: {
        fs: typeof fsPromises,
        path: TakeSnapshotProps['root'],
        filter?: TakeSnapshotProps['filter'],
        separator?: string,
    }): Promise<SnapshotNode> => {

        if (filter && !await filter(path)) return null;

        // TODO: think about handling snapshotting symlinks better
        // for now we just resolve and include
        const stats = await fs.stat(path);

        if (stats.isDirectory()) {
            const list = await fs.readdir(path);
            const entries: { [child: string]: SnapshotNode } = {};
            const dir = path.endsWith(separator) ? path : path + separator;
            for (const child of list) {
                const childSnapshot = await Snapshot.take({ fs, path: `${dir}${child}`, separator, filter });
                if (childSnapshot) entries[child] = childSnapshot;
            }
            return [0 /* Folder */, {}, entries];
        } else if (stats.isFile()) {
            const buf = (await fs.readFile(path)) as Buffer;
            const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
            return [1 /* File */, stats, uint8];
        } else if (stats.isSymbolicLink()) {
            // TODO: branch never actually reached as `fs.stat` doesn't return symlinks
            return [
                2 /* Symlink */,
                {
                    target: (await fs.readlink(path, { encoding: 'utf8' })) as string,
                },
            ];
        }
        return null;
    }

    export const mount = async (buffer: CborUint8Array<SnapshotNode>, { fs, path = '/', separator = '/' }: SnapshotOptions): Promise<void> => {
        try {
            console.log('Snapshot.mount: Starting mount process');
            console.log('Snapshot.mount: Buffer type:', typeof buffer);
            console.log('Snapshot.mount: Buffer length:', buffer?.byteLength || buffer?.length || 'unknown');
            console.log('Snapshot.mount: Buffer constructor:', buffer?.constructor?.name);

            // Convert buffer to Uint8Array if needed
            const uint8Buffer = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            console.log('Snapshot.mount: Converted to Uint8Array, length:', uint8Buffer.length);

            // Check if data appears to be compressed
            const isCompressed = isGzipCompressed(uint8Buffer);
            console.log('Snapshot.mount: Data appears compressed:', isCompressed);

            // Try to decompress the buffer first, then decode
            let decompressed: Uint8Array;
            try {
                decompressed = await decompress(uint8Buffer);
                console.log('Snapshot.mount: Successfully processed buffer, decompressed length:', decompressed.length);
            } catch (decompressError) {
                console.warn('Snapshot.mount: Decompression failed, using original buffer:', decompressError);
                // Fallback: assume the buffer is already uncompressed (for backward compatibility)
                decompressed = uint8Buffer;
            }

            console.log('Snapshot.mount: Attempting to decode CBOR data...');
            const snapshot = await decoder.decode(decompressed) as SnapshotNode;
            console.log('Snapshot.mount: Successfully decoded snapshot, type:', typeof snapshot);
            console.log('Snapshot.mount: Snapshot structure:', Array.isArray(snapshot) ? `Array[${snapshot.length}]` : snapshot);

            if (snapshot) {
                console.log('Snapshot.mount: Starting fromSnapshot process...');
                await fromSnapshot(snapshot, { fs, path, separator });
                console.log('Snapshot.mount: Successfully mounted snapshot');
            } else {
                console.warn('Snapshot.mount: Decoded snapshot is null or undefined');
            }
        } catch (error) {
            console.error('Snapshot.mount: Failed to mount snapshot:', error);
            throw error;
        }
    }
    /**
     * Load and mount a snapshot directly from a URL in a web worker environment.
     * This is more efficient for large snapshots as it avoids transferring data through the main thread.
     */
    export const loadAndMount = async (url: string, { fs, path = '/', separator = '/' }: SnapshotOptions): Promise<void> => {
        try {
            console.log('Snapshot.loadAndMount: Starting direct load from URL:', url);

            // Fetch the snapshot data directly in the worker
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch snapshot: ${response.status} ${response.statusText}`);
            }

            console.log('Snapshot.loadAndMount: Response received, content-length:', response.headers.get('content-length'));

            // Get the response as ArrayBuffer for better performance
            const arrayBuffer = await response.arrayBuffer();
            const uint8Buffer = new Uint8Array(arrayBuffer);

            console.log('Snapshot.loadAndMount: Downloaded buffer length:', uint8Buffer.length);

            // Use the existing mount logic
            await Snapshot.mount(uint8Buffer as CborUint8Array<SnapshotNode>, { fs, path, separator });

        } catch (error) {
            console.error('Snapshot.loadAndMount: Failed to load and mount snapshot:', error);
            throw error;
        }
    }

    /**
     * Load and mount a snapshot with streaming support for better performance with large files.
     * This version processes the data in chunks as it arrives.
     */
    export const loadAndMountStreaming = async (url: string, { fs, path = '/', separator = '/' }: SnapshotOptions): Promise<void> => {
        try {
            console.log('Snapshot.loadAndMountStreaming: Starting streaming load from URL:', url);

            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch snapshot: ${response.status} ${response.statusText}`);
            }

            if (!response.body) {
                throw new Error('Response body is not available for streaming');
            }

            console.log('Snapshot.loadAndMountStreaming: Starting streaming download...');

            // Collect all chunks
            const chunks: Uint8Array[] = [];
            const reader = response.body.getReader();
            let totalLength = 0;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    chunks.push(value);
                    totalLength += value.length;

                    // Log progress for large files
                    if (totalLength % (5 * 1024 * 1024) === 0) {
                        console.log(`Snapshot.loadAndMountStreaming: Downloaded ${Math.round(totalLength / (1024 * 1024))}MB`);
                    }
                }
            } finally {
                reader.releaseLock();
            }

            console.log('Snapshot.loadAndMountStreaming: Download complete, total length:', totalLength);

            // Combine all chunks into a single buffer
            const uint8Buffer = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                uint8Buffer.set(chunk, offset);
                offset += chunk.length;
            }

            console.log('Snapshot.loadAndMountStreaming: Combined buffer created, mounting...');

            // Use the existing mount logic
            await Snapshot.mount(uint8Buffer as CborUint8Array<SnapshotNode>, { fs, path, separator });

        } catch (error) {
            console.error('Snapshot.loadAndMountStreaming: Failed to load and mount snapshot:', error);
            throw error;
        }
    }
}

export const fromSnapshot = async (
    snapshot: SnapshotNode,
    { fs, path = '/', separator = '/' }: SnapshotOptions,
): Promise<void> => {
    if (!snapshot) return;
    switch (snapshot[0]) {
        case 0: {
            if (!path.endsWith(separator)) path = path + separator;
            const [, , entries] = snapshot;
            fs.mkdirSync(path, { recursive: true });
            for (const [name, child] of Object.entries(entries))
                await fromSnapshot(child, { fs, path: `${path}${name}`, separator });
            break;
        }
        case 1: {
            const [, , data] = snapshot;
            fs.writeFileSync(path, data);
            break;
        }
        case 2: {
            const [, { target }] = snapshot;
            fs.symlinkSync(target, path);
            break;
        }
    }
};