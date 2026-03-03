import { VfsInterface } from "../types";

const LIB_DIR = '/node_modules/typescript/lib';
const TSCONFIG_PATH = '/tsconfig.json';

/**
 * Maps ES target names to the list of TypeScript lib files they require.
 * Each target includes all libs from previous targets plus its own additions.
 * Derived from the `/// <reference lib="..." />` chains in TypeScript's lib files.
 */
const TARGET_LIBS: Record<string, string[]> = {
    es5: [
        'es5',
        'decorators',
        'decorators.legacy',
    ],
    es2015: [
        'es5', 'decorators', 'decorators.legacy',
        'es2015',
        'es2015.core', 'es2015.collection', 'es2015.iterable',
        'es2015.generator', 'es2015.promise', 'es2015.proxy',
        'es2015.reflect', 'es2015.symbol', 'es2015.symbol.wellknown',
    ],
    es2016: [
        'es5', 'decorators', 'decorators.legacy',
        'es2015',
        'es2015.core', 'es2015.collection', 'es2015.iterable',
        'es2015.generator', 'es2015.promise', 'es2015.proxy',
        'es2015.reflect', 'es2015.symbol', 'es2015.symbol.wellknown',
        'es2016',
        'es2016.array.include', 'es2016.intl',
    ],
    es2017: [
        'es5', 'decorators', 'decorators.legacy',
        'es2015',
        'es2015.core', 'es2015.collection', 'es2015.iterable',
        'es2015.generator', 'es2015.promise', 'es2015.proxy',
        'es2015.reflect', 'es2015.symbol', 'es2015.symbol.wellknown',
        'es2016',
        'es2016.array.include', 'es2016.intl',
        'es2017',
        'es2017.arraybuffer', 'es2017.date', 'es2017.intl',
        'es2017.object', 'es2017.sharedmemory', 'es2017.string',
        'es2017.typedarrays',
    ],
    es2018: [
        'es5', 'decorators', 'decorators.legacy',
        'es2015',
        'es2015.core', 'es2015.collection', 'es2015.iterable',
        'es2015.generator', 'es2015.promise', 'es2015.proxy',
        'es2015.reflect', 'es2015.symbol', 'es2015.symbol.wellknown',
        'es2016',
        'es2016.array.include', 'es2016.intl',
        'es2017',
        'es2017.arraybuffer', 'es2017.date', 'es2017.intl',
        'es2017.object', 'es2017.sharedmemory', 'es2017.string',
        'es2017.typedarrays',
        'es2018',
        'es2018.asynciterable', 'es2018.asyncgenerator',
        'es2018.promise', 'es2018.regexp', 'es2018.intl',
    ],
    es2019: [
        'es5', 'decorators', 'decorators.legacy',
        'es2015',
        'es2015.core', 'es2015.collection', 'es2015.iterable',
        'es2015.generator', 'es2015.promise', 'es2015.proxy',
        'es2015.reflect', 'es2015.symbol', 'es2015.symbol.wellknown',
        'es2016',
        'es2016.array.include', 'es2016.intl',
        'es2017',
        'es2017.arraybuffer', 'es2017.date', 'es2017.intl',
        'es2017.object', 'es2017.sharedmemory', 'es2017.string',
        'es2017.typedarrays',
        'es2018',
        'es2018.asynciterable', 'es2018.asyncgenerator',
        'es2018.promise', 'es2018.regexp', 'es2018.intl',
        'es2019',
        'es2019.array', 'es2019.object', 'es2019.string',
        'es2019.symbol', 'es2019.intl',
    ],
    es2020: [
        'es5', 'decorators', 'decorators.legacy',
        'es2015',
        'es2015.core', 'es2015.collection', 'es2015.iterable',
        'es2015.generator', 'es2015.promise', 'es2015.proxy',
        'es2015.reflect', 'es2015.symbol', 'es2015.symbol.wellknown',
        'es2016',
        'es2016.array.include', 'es2016.intl',
        'es2017',
        'es2017.arraybuffer', 'es2017.date', 'es2017.intl',
        'es2017.object', 'es2017.sharedmemory', 'es2017.string',
        'es2017.typedarrays',
        'es2018',
        'es2018.asynciterable', 'es2018.asyncgenerator',
        'es2018.promise', 'es2018.regexp', 'es2018.intl',
        'es2019',
        'es2019.array', 'es2019.object', 'es2019.string',
        'es2019.symbol', 'es2019.intl',
        'es2020',
        'es2020.bigint', 'es2020.date', 'es2020.number',
        'es2020.promise', 'es2020.sharedmemory', 'es2020.string',
        'es2020.symbol.wellknown', 'es2020.intl',
    ],
};

export type TypescriptDefaultsConfig = {
    /** ES target, determines which lib files are needed. Default: "ES2020" */
    target?: string;
    /** Custom tsconfig compilerOptions merged with defaults */
    compilerOptions?: Record<string, any>;
};

/**
 * Returns the list of TypeScript lib file names required for a given ES target.
 * Names are without the `lib.` prefix and `.d.ts` suffix (e.g. "es5", "es2015.collection").
 */
export function getRequiredLibs(target: string = 'es2020'): string[] {
    return TARGET_LIBS[target.toLowerCase()] || TARGET_LIBS.es2020;
}

let prefilled = false;

/**
 * Pre-fills the virtual filesystem with TypeScript default lib definitions and tsconfig.
 * Writes to `/node_modules/typescript/lib/` where Volar's TypeScript language server
 * expects to find them in a browser environment.
 *
 * - Skips files that already exist on the filesystem
 * - Only runs once per session (subsequent calls are no-ops)
 * - Should be called lazily when a TypeScript file is first opened
 *
 * @param fs - Virtual filesystem to write to
 * @param resolveLib - Function that resolves a lib name to its `.d.ts` content.
 *                     Receives names like "es5", "es2015.collection".
 *                     In Vite, use `import.meta.glob('typescript/lib/*.d.ts', { query: '?raw' })`.
 * @param config - Optional target and tsconfig overrides
 */
export async function prefillTypescriptDefaults(
    fs: VfsInterface,
    resolveLib: (name: string) => Promise<string>,
    config: TypescriptDefaultsConfig = {},
): Promise<void> {
    if (prefilled) return;
    prefilled = true;

    const target = config.target || 'ES2020';

    // Write tsconfig.json if it doesn't exist
    if (!await fs.exists(TSCONFIG_PATH)) {
        const tsconfig = {
            compilerOptions: {
                target,
                module: "ESNext",
                moduleResolution: "bundler",
                strict: true,
                skipLibCheck: true,
                ...config.compilerOptions,
            }
        };
        await fs.writeFile(TSCONFIG_PATH, JSON.stringify(tsconfig, null, 2));
    }

    // Write lib files to the path Volar expects in browser environments
    const libs = getRequiredLibs(target);
    await fs.mkdir(LIB_DIR, { recursive: true });

    await Promise.all(libs.map(async (name) => {
        const path = `${LIB_DIR}/lib.${name}.d.ts`;
        if (await fs.exists(path)) return;
        try {
            const content = await resolveLib(name);
            await fs.writeFile(path, content);
        } catch (e) {
            console.error(`Failed to load TypeScript lib: ${name}`, e);
        }
    }));
}

/**
 * Resets the prefilled state. Primarily useful for testing.
 */
export function resetPrefillState() {
    prefilled = false;
}
