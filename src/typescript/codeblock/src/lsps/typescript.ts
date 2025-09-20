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
}

export const createLanguageServer = async ({ connection, fs }: CreateTypescriptEnvironmentArgs) => {
    const server = createServerBase(connection, {
        timer: {
            setImmediate: (callback: (...args: any[]) => void, ...args: any[]) => {
                setTimeout(callback, 0, ...args);
            },
        },
    });
    server.fileSystem.install('file', new VolarFs(fs));
    server.onInitialize((params) => {
        console.debug('ts server on init', params)
    })
    connection.onShutdown(() => {
        console.debug('ts server shutdown')
    })
    connection.onInitialize(async (params) => {
        const languageServicePlugins = getLanguageServicePlugins(ts)

        return server.initialize(
            params,
            createTypeScriptProject(
                // @ts-ignore
                ts,
                undefined,
                async () => ({
                    // rootUri: params.rootUri,
                    languagePlugins: []
                })
            ),
            languageServicePlugins
        )
    })
    connection.onInitialized(() => {
        server.initialized();
        const extensions = [
            '.tsx',
            '.jsx',
            '.js',
            '.ts'
        ]
        server.fileWatcher.watchFiles([`**/*.{${extensions.join(',')}}`])
    });
    return server;
}