import { CborUint8Array } from "@jsonjoy.com/json-pack/lib/cbor/types";
import { createCodeblock } from "./src/editor";
import { CodeblockFS } from "./src/utils/fs";
import { SearchIndex } from "./src/utils/search";
import { SnapshotNode } from "memfs/snapshot";

async function loadFs() {
    const response = await fetch('/snapshot.bin');
    if (!response.ok) {
        throw new Error(`Failed to load snapshot: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    console.debug('Got snapshot', buffer);

    return await CodeblockFS.worker(buffer as CborUint8Array<SnapshotNode>);
}
const fs = await loadFs()
const parent = document.getElementById('editor') as HTMLDivElement;
const path = '.codeblock/index.json'
const index = await SearchIndex.get(fs, path)
createCodeblock({ parent, fs, file: 'example.ts', toolbar: true, index });