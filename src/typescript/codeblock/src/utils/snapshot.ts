import fsPromises from 'fs/promises';
import multimatch from 'multimatch';
import { SnapshotNode } from 'memfs/snapshot';
import { CborEncoder } from '@jsonjoy.com/json-pack/lib/cbor/CborEncoder';
import { CborDecoder } from '@jsonjoy.com/json-pack/lib/cbor/CborDecoder';
import { Writer } from '@jsonjoy.com/util/lib/buffers/Writer';
import { CborUint8Array } from '@jsonjoy.com/json-pack/lib/cbor/types';
import { FsApi } from 'memfs/node/types';

export const writer = new Writer(1024 * 32);
const encoder = new CborEncoder(writer);
const decoder = new CborDecoder();

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
    filter: (path: string) => boolean;
};

export const snapshotDefaults: TakeSnapshotProps = {
    root: typeof process !== 'undefined' ? process.cwd() : './',
    filter: () => true,
};

/**
 * Takes a snapshot of the file system based on the provided properties.
 *
 * @param props - The properties to configure the snapshot.
 */
export const takeSnapshot = async (props: Partial<TakeSnapshotProps> = {}) => {
    const { root, filter } = { ...snapshotDefaults, ...props };

    console.log('Taking snapshot of filesystem', { root, filter });

    const snapshot = await Snapshot
        .take({ fs: fsPromises, path: root, filter })
        .then((snapshot) => encoder.encode(snapshot));
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

        if (filter && !filter(path)) return null;

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
        const snapshot = await decoder.decode(new Uint8Array(buffer)) as SnapshotNode;
        if (snapshot) {
            await fromSnapshot(snapshot, { fs, path, separator });
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