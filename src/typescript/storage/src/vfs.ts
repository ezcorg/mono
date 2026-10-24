/**
 * The filesystem contract every environment implements.
 *
 * A vault is a folder of files, and everything above this interface (the
 * editor, the code block, the indexes in this package) reaches files only
 * through it. Implementations live where the environment is: an OPFS or
 * in-memory worker in the browser, the host disk through Tauri, a granted
 * directory through the icanhaz daemon, Node's `fs` in tests. Paths are
 * vault-relative with `/` as the separator; a leading `/` means the vault
 * root, never the host's.
 */

/** Entry kinds, numerically identical to `@volar/language-service`'s
 *  `FileType` so a listing can be handed to a language server as is. */
export const FileType = {
    Unknown: 0,
    File: 1,
    Directory: 2,
    SymbolicLink: 64,
} as const
export type FileType = (typeof FileType)[keyof typeof FileType]

export interface FileStat {
    type: FileType
    size: number
    /** Last modification, as a `Date` or milliseconds since the epoch. Absent
     *  (or 0) when the backing store does not track it. */
    mtime?: Date | number | null
    ctime?: Date | number | null
    atime?: Date | number | null
    name?: string
}

export interface WatchEvent {
    /** `change` for new contents; `rename` for an entry created, removed or moved. */
    eventType: 'rename' | 'change'
    /** The entry's path relative to the watched path (so, watching the
     *  root, a vault path). */
    filename: string
}

// TODO: consider changing interface to allow writes at specific offsets within files
export interface VfsInterface {
    /**
     * Reads the entire contents of a file asynchronously
     * @param path A path to a file
     */
    readFile: (path: string) => Promise<string>

    /**
     * Writes data to a file asynchronously
     * @param path A path to a file
     * @param data The data to write
     */
    writeFile: (path: string, data: string) => Promise<void>

    /**
     * Reads a file's bytes: attachments (images, PDFs) and anything else that
     * is not UTF-8 text.
     */
    readBytes: (path: string) => Promise<Uint8Array>

    /** Writes bytes to a file, creating it or replacing its contents. */
    writeBytes: (path: string, data: Uint8Array) => Promise<void>

    /**
     * Moves a file or directory. The destination's parent must exist; a file
     * already at the destination is replaced.
     */
    rename: (oldPath: string, newPath: string) => Promise<void>

    /**
     * Watch for changes to a file or directory
     * @param path A path to a file/directory
     * @param options Configuration options for watching
     */
    watch: (path: string, options: { signal: AbortSignal }) => AsyncGenerator<WatchEvent>

    /**
     * Creates a directory asynchronously
     * @param path A path to a directory
     * @param options Configuration options for directory creation
     */
    mkdir: (path: string, options: { recursive: boolean }) => Promise<void>

    readDir: (path: string) => Promise<[string, FileType][]>

    /**
     * Checks whether a given file or folder exists
     * @param path A path to a file or folder
     * @returns A promise that resolves to true if the file or folder exists, false otherwise
     */
    exists: (path: string) => Promise<boolean>

    stat: (path: string) => Promise<FileStat | null | undefined>

    /**
     * Deletes a file
     * @param path A path to a file
     */
    unlink: (path: string) => Promise<void>

    /**
     * Optional: another port reaching this same filesystem, for a worker to
     * use directly rather than through this thread. A filesystem served from
     * a worker has it (`remoteVfs`); `vfsPort` gives a port for any.
     */
    connect?: () => Promise<MessagePort>
}

/** Milliseconds since the epoch for a stat time, or 0 when unknown. */
export function statTime(time: FileStat['mtime']): number {
    if (time == null) return 0
    return typeof time === 'number' ? time : time.getTime()
}

/**
 * Every file under `path`, depth first, as rooted paths (`/notes/a.md`).
 * Directories are descended into, not yielded.
 */
export async function* walk(fs: VfsInterface, path = '/'): AsyncIterable<string> {
    const files = await fs.readDir(path)
    for (const [filename, type] of files) {
        const joined = `${path === '/' ? '' : path}/${filename}`
        if (type === FileType.Directory) {
            yield* walk(fs, joined)
        } else {
            yield joined
        }
    }
}
