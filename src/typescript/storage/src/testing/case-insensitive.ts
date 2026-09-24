/**
 * A store as a disk that ignores case (macOS, Windows): a path finds an
 * entry however it is spelled, and names keep the spelling they were
 * created or renamed with.
 */
import type { VfsInterface } from '../vfs.js'
import { basename, dirname, joinPath, normalizePath } from '../path.js'

export function caseInsensitive(fs: VfsInterface): VfsInterface {
    /** `path` as the entries on disk spell it (segments not found as given). */
    const spelled = async (path: string): Promise<string> => {
        let out = ''
        for (const segment of normalizePath(path).split('/').filter(Boolean)) {
            const entries = await fs.readDir(out || '/').catch(() => [])
            const found = entries.find(([name]) => name.toLowerCase() === segment.toLowerCase())?.[0] ?? segment
            out = out ? `${out}/${found}` : found
        }
        return out
    }
    return {
        readFile: async (path) => fs.readFile(await spelled(path)),
        writeFile: async (path, data) => fs.writeFile(await spelled(path), data),
        readBytes: async (path) => fs.readBytes(await spelled(path)),
        writeBytes: async (path, data) => fs.writeBytes(await spelled(path), data),
        mkdir: async (path, options) => fs.mkdir(await spelled(path), options),
        readDir: async (path) => fs.readDir(await spelled(path)),
        exists: async (path) => fs.exists(await spelled(path)),
        stat: async (path) => fs.stat(await spelled(path)),
        unlink: async (path) => fs.unlink(await spelled(path)),
        async rename(oldPath, newPath) {
            const from = await spelled(oldPath)
            const to = await spelled(newPath)
            // Another spelling of the same entry: renamed in place.
            if (to === from) return fs.rename(from, joinPath(dirname(from), basename(newPath)))
            return fs.rename(from, to)
        },
        watch: (path, options) => fs.watch(path, options),
    }
}
