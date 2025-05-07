import { create as createTypeScriptServicePlugins } from 'volar-service-typescript'
import { Fs } from '../types';
import { Connection, createServerBase, createTypeScriptProject } from '@volar/language-server/browser';
import ts from 'typescript';
import { VolarFs } from '../utils/fs';

function getLanguageServicePlugins(_ts: typeof ts) {
    const plugins = [
        ...createTypeScriptServicePlugins(_ts),
        // ...more?
    ]
    return plugins
}

export type CreateTypescriptEnvironmentArgs = {
    connection: Connection
    fs: Fs
}

export const createLanguageServer = async ({ connection, fs }: CreateTypescriptEnvironmentArgs) => {
    console.log('creating language server', connection, fs)
    const server = createServerBase(connection, {
        timer: {
            setImmediate: (callback: (...args: any[]) => void, ...args: any[]) => {
                setTimeout(callback, 0, ...args);
            },
        },
    });
    console.log('have server', server)
    server.fileSystem.install('file', new VolarFs(fs));
    server.onInitialize((params) => {
        console.log('server on init', params)
    })
    connection.onShutdown(() => {
        console.log('why con shutdown bb')
    })
    connection.onInitialize(async (params) => {
        const languageServicePlugins = getLanguageServicePlugins(ts)
        console.log('language service', languageServicePlugins)

        return server.initialize(
            params,
            createTypeScriptProject(
                ts,
                undefined,
                async () => ({
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