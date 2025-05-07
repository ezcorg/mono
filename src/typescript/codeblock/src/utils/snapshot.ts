import path from 'node:path';
import parse from 'parse-gitignore';
import nodeFs from 'node:fs';
import { promises as _fs, mount, Passthrough, resolveMountConfig, SingleBuffer } from "@zenfs/core";
import multimatch from 'multimatch';

export const copyDir = async (fs: typeof _fs, source: string, dest: string, filter: (path: string) => boolean = () => true) => {
    const symlinkQueue: { src: string; dest: string }[] = [];

    async function copyRecursive(src: string, dst: string) {
        try {
            const entries = await fs.readdir(src, { withFileTypes: true });
            await fs.mkdir(dst, { recursive: true });

            for (const entry of entries) {
                const srcPath = path.join(src, entry.name);
                const srcRelPath = path.relative(source, srcPath);
                const dstPath = path.join(dst, entry.name);

                if (!filter(srcRelPath)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    await copyRecursive(srcPath, dstPath);
                } else if (entry.isFile()) {
                    const data = nodeFs.readFileSync(srcRelPath);
                    const stats = nodeFs.statSync(srcRelPath);

                    await fs.writeFile(dstPath, data, { encoding: 'utf-8' });
                    // Copy file metadata
                    // console.log('stats', stats)
                    await fs.chown(dstPath, stats.uid, stats.gid);
                    await fs.chmod(dstPath, stats.mode);
                    await fs.utimes(dstPath, stats.atime, stats.mtime);
                } else if (entry.isSymbolicLink()) {
                    symlinkQueue.push({ src: srcPath, dest: dstPath });
                }
            }
        } catch (e) {
            console.error(`Failed to copy ${src} to ${dest}:`, e);
            throw e;
        }
    }

    async function resolveSymlinks() {
        for (const { src, dest } of symlinkQueue) {
            try {
                const target = await fs.readlink(src);
                const absoluteTarget = path.resolve(path.dirname(src), target);

                try {
                    await fs.stat(absoluteTarget);
                    await fs.symlink(target, dest);
                } catch {
                    await fs.copyFile(absoluteTarget, dest);
                }
            } catch (err) {
                console.error(`Failed to copy symlink ${src}:`, err);
            }
        }
    }

    await copyRecursive(source, dest);
    await resolveSymlinks();
}

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
    fs: typeof _fs,
    root: string,
    exclude: string[],
    gitignore: string | null
}

export const getGitignored = async (path: string, fs = _fs) => {
    const content = await fs.readFile(path, 'utf-8')
    // @ts-ignore
    return parse(content).patterns;
};

export type SnapshotProps<T> = {
    transform?: (fs: typeof _fs) => Promise<typeof _fs>;
} & Partial<TakeSnapshotProps> & T;
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
    let { root, filter } = { ...snapshotDefaults, ...props };

    const estimateUsed = async (path: string) => {
        const { bsize, blocks, bfree } = await _fs.statfs(path);
        const size = blocks;
        const free = bfree;
        const used = size - free;
        return used * bsize;
    }
    // const buffer = new ArrayBuffer((await estimateUsed(root)) * 100000);
    const buffer = new ArrayBuffer(1024 * 1024 * 1024 / 4);
    console.debug('buffer', { size: buffer.byteLength });

    try {
        const readable = await resolveMountConfig({ backend: Passthrough, fs: nodeFs, prefix: root });
        const writable = await resolveMountConfig({ backend: SingleBuffer, buffer });
        // TODO: there's probably a better way to do this
        const hostPath = '/mnt/host';
        const snapshotPath = '/mnt/snapshot';
        mount(hostPath, readable);
        mount(snapshotPath, writable);
        await readable.ready()
        await writable.ready()
        await copyDir(_fs, hostPath, snapshotPath, filter)
    } catch (e) {
        console.error('got error', e)
    }

    return buffer;
};
