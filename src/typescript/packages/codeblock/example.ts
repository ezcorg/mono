import { createCodeblock } from "./src/editor";
import { CodeblockFS } from "./src/utils/fs";
import { SearchIndex } from "./src/utils/search";

async function loadFs() {
    const response = await fetch('/snapshot.bin');
    if (!response.ok) {
        throw new Error(`Failed to load snapshot: ${response.statusText}`);
    }
    return await CodeblockFS.fromSnapshot(await response.arrayBuffer());
}
const fs = await loadFs()
const parent = document.getElementById('editor') as HTMLDivElement;
const path = '.codeblock/index.json'
const index = await SearchIndex.get(fs, path)
createCodeblock({ parent, fs, file: 'example.ts', toolbar: true, index });