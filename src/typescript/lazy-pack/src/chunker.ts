/**
 * Chunk assignment strategies — decide which files go into which chunk.
 */

import path from 'node:path';

export type ChunkAssignment = Map<string, string[]>; // chunkName → file paths (relative)

/**
 * "package" strategy: group by npm package.
 *
 * Files under `node_modules/<scope>/<pkg>/` or `node_modules/<pkg>/`
 * share a chunk. Everything else goes into a "rootfs" chunk.
 */
export function chunkByPackage(filePaths: string[]): ChunkAssignment {
    const chunks: ChunkAssignment = new Map();

    for (const rel of filePaths) {
        const chunkName = getPackageChunkName(rel);
        if (!chunks.has(chunkName)) chunks.set(chunkName, []);
        chunks.get(chunkName)!.push(rel);
    }

    return chunks;
}

/**
 * "directory" strategy: group by top-level directory.
 */
export function chunkByDirectory(filePaths: string[]): ChunkAssignment {
    const chunks: ChunkAssignment = new Map();

    for (const rel of filePaths) {
        const firstSlash = rel.indexOf('/');
        const chunkName = firstSlash === -1 ? 'root' : rel.substring(0, firstSlash);
        if (!chunks.has(chunkName)) chunks.set(chunkName, []);
        chunks.get(chunkName)!.push(rel);
    }

    return chunks;
}

function getPackageChunkName(relPath: string): string {
    const parts = relPath.split('/');

    // Check for node_modules/<scope>/<pkg> or node_modules/<pkg>
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] === 'node_modules' && i + 1 < parts.length) {
            if (parts[i + 1].startsWith('@') && i + 2 < parts.length) {
                // Scoped package: node_modules/@scope/pkg
                return `pkg-${parts[i + 1]}-${parts[i + 2]}`;
            } else {
                // Regular package: node_modules/pkg
                return `pkg-${parts[i + 1]}`;
            }
        }
    }

    // Not in node_modules — group into "rootfs"
    return 'rootfs';
}
