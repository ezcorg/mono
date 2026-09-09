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

// The same filesystem the editors run on: a SharedWorker over OPFS (in-memory where OPFS is missing).
// Files persist across visits; the first one gets a file to look at.
const fs = await Vfs.worker(undefined, 'codeblock-example');
if (!(await fs.exists('example.ts'))) await fs.writeFile('example.ts', 'export const hello = (name: string) => `hello, ${name}`;\n');

const parent = document.getElementById('editor') as HTMLDivElement;
const path = '.codeblock/index.json'
const index = await SearchIndex.get(fs, path, ['path', 'basename', 'dirname', 'extension']);
createCodeblock({
    parent, fs, filepath: 'example.ts', language: 'ts', toolbar: true, index, cwd: '/',
    settings: { agentUrl: 'http://localhost:3141' },
    typescript: { resolveLib },
});
