import { FileType } from "@volar/language-service";
import type { promises as fs } from "@zenfs/core";

// TODO: consider changing interface to allow writes at specific offsets within files
export interface Fs {
    /**
     * Reads the entire contents of a file asynchronously
     * @param path A path to a file
     */
    readFile: (
        path: string,
    ) => Promise<string>;

    /**
     * Writes data to a file asynchronously
     * @param path A path to a file
     * @param data The data to write
     */
    writeFile: (
        path: string,
        data: string,
    ) => Promise<void>;

    /**
     * Watch for changes to a file or directory
     * @param path A path to a file/directory
     * @param options Configuration options for watching
     */
    watch: (
        path: string,
        options: {
            signal: AbortSignal,
        }
    ) => AsyncGenerator<{ eventType: 'rename' | 'change', filename: string }>;

    /**
     * Creates a directory asynchronously
     * @param path A path to a directory, URL, or parent FileSystemDirectoryHandle
     * @param options Configuration options for directory creation
     */
    mkdir: (
        path: string,
        options: {
            recursive: boolean,
        }
    ) => Promise<void>;

    readDir: (
        path: string,
    ) => Promise<[string, FileType][]>;

    /**
     * Checks whether a given file or folder exists
     * @param path A path to a file or folder
     * @returns A promise that resolves to true if the file or folder exists, false otherwise
     */
    exists: (
        path: string,
    ) => Promise<boolean>;

    stat: (
        path: string,
    ) => Promise<any | undefined>;
}

export type FsMountOptions = {
    mount: (args: { buffer: ArrayBuffer }) => Promise<MountResult>;
}

export type MountArgs = {
    buffer?: ArrayBuffer;
    mountPoint?: string;
}

export type MountResult = {
    fs: typeof fs;
}