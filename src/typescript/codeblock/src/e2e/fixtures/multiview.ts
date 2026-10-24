import { createCodeblock, fileChangeBus } from "../../editor";
import { browserVfs } from "@joinezco/storage/browser";
import { Vault } from "@joinezco/vault";

async function init() {
    // Use FSA (OPFS) directly — SharedWorker hangs in headless Chrome.
    // The vault indexes the store for the toolbar's search; editors write through its fs.
    const vault = new Vault(await browserVfs(`codeblock-test-multiview-${Date.now()}`));
    const { fs, search, files } = vault;

    const parentA = document.getElementById('editor-a') as HTMLDivElement;
    const parentB = document.getElementById('editor-b') as HTMLDivElement;

    // Create editors with initial content (not filepath) to avoid VFS read timing issues
    const viewA = createCodeblock({
        parent: parentA, fs, content: 'hello world', language: 'md', toolbar: true, search, files, cwd: '/',
    });

    const viewB = createCodeblock({
        parent: parentB, fs, content: 'hello world', language: 'md', toolbar: true, search, files, cwd: '/',
    });

    // Manually subscribe both to the same file for sync testing
    // Use 'shared.txt' to match what the tests notify on; the bus is the vault's filesystem's.
    fileChangeBus.subscribe(fs, 'shared.txt', viewA, (content) => {
        if (viewA.state.doc.toString() !== content) {
            viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: content } });
        }
    });
    fileChangeBus.subscribe(fs, 'shared.txt', viewB, (content) => {
        if (viewB.state.doc.toString() !== content) {
            viewB.dispatch({ changes: { from: 0, to: viewB.state.doc.length, insert: content } });
        }
    });

    // Expose to window for test access
    (window as any).__views = { viewA, viewB };
    (window as any).__fileChangeBus = fileChangeBus;
    (window as any).__fs = fs;
    (window as any).__editorsReady = true;
}

init().catch(e => console.error('[multiview-test] Init failed:', e));
