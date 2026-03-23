import { TopLevelFs } from "@joinezco/jswasi/filesystem";
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

async function loadFs() {
    const fs = new TopLevelFs();
    const config = {
        "fsType": "fsa",
        "opts": {
            "name": "fsa1",
            "keepMetadata": "true",
            "create": "true"
        }
    }
    await fs.addMount(
        // @ts-expect-error
        undefined,
        "",
        undefined,
        "/",
        config.fsType,
        0n,
        config.opts);
    return await Vfs.fromJswasiFs(fs);
}

// await reset();
const fs = await loadFs()
const parent = document.getElementById('editor') as HTMLDivElement;
const path = '.codeblock/index.json'
const index = await SearchIndex.get(fs, path, ['path', 'basename', 'dirname', 'extension']);
createCodeblock({
    parent, fs, language: 'ts', toolbar: true, index, cwd: '/',
    typescript: { resolveLib },
    jswasi: {
        rootfsUrl: '/jswasi/rootfs.tgz',
        opfsBucket: 'fsa1',
    }
});
