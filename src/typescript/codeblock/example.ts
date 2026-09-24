import { createCodeblock } from "./src/editor";
import { browserVfs } from "@joinezco/storage/browser";
import { Vault } from "@joinezco/storage";

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

// The same filesystem the editors run on: the origin's OPFS through storage's workers (in memory where OPFS is missing).
// Files persist across visits; the first one gets a file to look at.
const vault = new Vault(await browserVfs('codeblock-example'));
const { fs, search, files } = vault;
if (!(await fs.exists('example.ts'))) await fs.writeFile('example.ts', 'export const hello = (name: string) => `hello, ${name}`;\n');

const parent = document.getElementById('editor') as HTMLDivElement;
createCodeblock({
    parent, fs, filepath: 'example.ts', language: 'ts', toolbar: true, search, files, cwd: '/',
    settings: { agentUrl: 'http://localhost:3141' },
    typescript: { resolveLib },
});
