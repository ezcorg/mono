import { create as createTypeScriptServicePlugins } from 'volar-service-typescript'
import { VfsInterface } from '../types';
import { Connection, createServerBase, createTypeScriptProject } from '@volar/language-server/browser';
import ts from 'typescript';
import { VolarFs } from '../utils/fs';

function getLanguageServicePlugins(_ts: typeof ts) {
    const plugins = [
        // @ts-ignore
        ...createTypeScriptServicePlugins(_ts),
        // ...more?
    ]
    return plugins
}

export type CreateTypescriptEnvironmentArgs = {
    connection: Connection
    fs: VfsInterface
    /** Pre-resolved lib file contents keyed by path, for synchronous cache population */
    libFiles?: Record<string, string>
}

export const createLanguageServer = async ({ connection, fs, libFiles }: CreateTypescriptEnvironmentArgs) => {
    const server = createServerBase(connection, {
        timer: {
            setImmediate: (callback: (...args: any[]) => void, ...args: any[]) => {
                setTimeout(callback, 0, ...args);
            },
        },
    });
    const volarFs = new VolarFs(fs);
    if (libFiles) {
        volarFs.preloadFromMap(libFiles);
    }
    server.fileSystem.install('file', volarFs);
    connection.onInitialize(async (params) => {
        const languageServicePlugins = getLanguageServicePlugins(ts)
        return server.initialize(
            params,
            createTypeScriptProject(
                // @ts-ignore
                ts,
                undefined,
                async (_ctx) => ({
                    languagePlugins: []
                })
            ),
            languageServicePlugins
        )
    })
    connection.onInitialized(() => {
        server.initialized();
        server.fileWatcher.watchFiles(['**/*.{tsx,jsx,js,ts}'])
    });
    return server;
}