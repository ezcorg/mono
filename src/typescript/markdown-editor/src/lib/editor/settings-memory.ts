/**
 * Files for an editor made without a filesystem: settings kept in this
 * browser (localStorage, under `ezco-settings:`), shared by every editor
 * on the page and there again after a reload, as a host's choices were
 * before there were settings files; in memory, gone with the page, where
 * localStorage is missing or refused. (A host wanting them in its vault
 * gives the editor a filesystem, or `settings.fs`.)
 */
import type { ConfigFiles } from '@joinezco/config'

const PREFIX = 'ezco-settings:'

export function localFiles(): ConfigFiles {
    const memory = new Map<string, string>()
    const clean = (p: string) => p.replace(/^\/+/, '')
    const read = (path: string): string | undefined => {
        try {
            return localStorage.getItem(PREFIX + path) ?? undefined
        } catch {
            return memory.get(path)
        }
    }
    const write = (path: string, data: string) => {
        try {
            localStorage.setItem(PREFIX + path, data)
        } catch {
            memory.set(path, data)
        }
    }
    return {
        readFile: async (path) => {
            const text = read(clean(path))
            if (text === undefined) throw new Error(`ENOENT: ${path}`)
            return text
        },
        writeFile: async (path, data) => write(clean(path), data),
        exists: async (path) => read(clean(path)) !== undefined,
        mkdir: async () => {},
    }
}
