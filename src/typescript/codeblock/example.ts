import { CborUint8Array } from "@jsonjoy.com/json-pack/lib/cbor/types";
import { createCodeblock } from "./src/editor";
import { CodeblockFS } from "./src/utils/fs";
import { SearchIndex } from "./src/utils/search";
import { SnapshotNode } from "@ezdevlol/memfs/snapshot";

async function loadFs() {
    const response = await fetch('/snapshot.bin');
    if (!response.ok) {
        throw new Error(`Failed to load snapshot: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    return await CodeblockFS.worker(buffer as unknown as CborUint8Array<SnapshotNode>);
}
const fs = await loadFs()
const parent = document.getElementById('editor') as HTMLDivElement;
const path = '.codeblock/index.json'
const index = await SearchIndex.get(fs, path)
createCodeblock({ parent, fs, language: 'ts', toolbar: true, index, cwd: '/' });