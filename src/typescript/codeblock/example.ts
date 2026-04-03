import { createCodeblock } from "./src/editor";
import { Vfs } from "./src/utils/fs";
import { SearchIndex } from "./src/utils/search";

// Lazy loaders for TypeScript lib .d.ts files (Vite resolves these at build time)
const tsLibLoaders = import.meta.glob<string>(
    './node_modules/typescript/lib/lib.*.d.ts',
    { query: '?raw', import: 'default' }
);

const resolveLib = async (name: string): Promise<string> => {
    const key = `./node_modules/typescript/lib/lib.${name}.d.ts`;
    const loader = tsLibLoaders[key];
    if (!loader) throw new Error(`TypeScript lib not found: ${name}`);
    return loader();
};

// Load a lazy filesystem backed by OPFS.
// On first visit the manifest is fetched (~1KB) and chunks are loaded on demand.
// On subsequent visits, files are served directly from OPFS.
const fs = await Vfs.lazy({
    manifestUrl: '/lazy/fs.json',
    backingName: 'codeblock-example',
});

const parent = document.getElementById('editor') as HTMLDivElement;
const path = '.codeblock/index.json'
const index = await SearchIndex.get(fs, path, ['path', 'basename', 'dirname', 'extension']);
createCodeblock({
    parent, fs, filepath: 'example.ts', language: 'ts', toolbar: true, index, cwd: '/',
    settings: { agentUrl: 'http://localhost:3141' },
    typescript: { resolveLib },
});
