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

    // Pre-read node_modules package.json files so the TS module resolver
    // has them synchronously on its first pass.  Without this, the resolver
    // sees readFile return undefined (async not resolved yet), caches
    // "module not found", and never retries even after the async resolves.
    try {
        const preload: Record<string, string> = {};
        const entries = await fs.readDir('node_modules');
        const readPkg = async (dir: string) => {
            const pkgPath = `${dir}/package.json`;
            try {
                preload[`/${pkgPath}`] = await fs.readFile(pkgPath);
            } catch { /* no package.json */ }
        };
        await Promise.all(entries.map(async ([name, type]) => {
            if (type !== 2) return; // not a directory
            if (name.startsWith('@')) {
                // Scoped: read each sub-package
                try {
                    const scoped = await fs.readDir(`node_modules/${name}`);
                    await Promise.all(scoped.map(([sub, sType]) =>
                        sType === 2 ? readPkg(`node_modules/${name}/${sub}`) : Promise.resolve()
                    ));
                } catch {}
            } else {
                await readPkg(`node_modules/${name}`);
            }
        }));
        // Also preload the .d.ts files that each package.json points to
        // via `types`, `typings`, or `exports` fields. The TS resolver
        // needs these available synchronously after reading package.json.
        await Promise.all(Object.entries(preload).map(async ([pkgPath, content]) => {
            try {
                const pkg = JSON.parse(content);
                const dir = pkgPath.substring(0, pkgPath.lastIndexOf('/'));
                const typePaths: string[] = [];

                // Extract type entry points from package.json
                if (pkg.types) typePaths.push(`${dir}/${pkg.types}`);
                if (pkg.typings) typePaths.push(`${dir}/${pkg.typings}`);
                if (pkg.exports) {
                    // Walk exports to find types conditions
                    const walkExports = (obj: any, _prefix: string) => {
                        if (typeof obj === 'string') return;
                        if (obj?.types) typePaths.push(`${dir}/${obj.types}`);
                        if (obj?.import && typeof obj.import === 'string') {
                            // Infer .d.ts from .js path
                            const dts = obj.import.replace(/\.js$/, '.d.ts');
                            typePaths.push(`${dir}/${dts}`);
                        }
                        if (typeof obj === 'object') {
                            for (const [key, val] of Object.entries(obj)) {
                                if (key === '.' || key.startsWith('./')) {
                                    walkExports(val, key);
                                }
                            }
                        }
                    };
                    walkExports(pkg.exports['.'] || pkg.exports, '.');
                }

                for (const tp of typePaths) {
                    const normalized = tp.replace(/^\//, '');
                    try {
                        preload[tp.startsWith('/') ? tp : `/${normalized}`] = await fs.readFile(normalized);
                    } catch { /* file doesn't exist */ }
                }
            } catch { /* invalid JSON or other error */ }
        }));

        if (Object.keys(preload).length > 0) {
            volarFs.preloadFromMap(preload);
        }
    } catch (e) {
        console.warn('[lsp] Failed to preload package.json files:', e);
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
        server.fileWatcher.watchFiles(['**/*.{tsx,jsx,js,ts,json}'])
    });

    return server;
}