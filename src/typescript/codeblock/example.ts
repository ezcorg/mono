import { TopLevelFs } from "@joinezco/jswasi/filesystem";
import { createCodeblock } from "./src/editor";
import { Vfs } from "./src/utils/fs";
import { SearchIndex } from "./src/utils/search";

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
createCodeblock({ parent, fs, language: 'ts', toolbar: true, index, cwd: '/' });