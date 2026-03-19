import { createCodeblock, fileChangeBus } from "../../editor";
import { Vfs } from "../../utils/fs";
import { SearchIndex } from "../../utils/search";

async function init() {
    const fs = await Vfs.worker();

    const index = await SearchIndex.get(fs, '.codeblock/index.json');

    const parentA = document.getElementById('editor-a') as HTMLDivElement;
    const parentB = document.getElementById('editor-b') as HTMLDivElement;

    // Create editors with initial content (not filepath) to avoid VFS read timing issues
    const viewA = createCodeblock({
        parent: parentA, fs, content: 'hello world', language: 'md', toolbar: true, index, cwd: '/',
    });

    const viewB = createCodeblock({
        parent: parentB, fs, content: 'hello world', language: 'md', toolbar: true, index, cwd: '/',
    });

    // Manually subscribe both to the same file for sync testing
    fileChangeBus.subscribe('shared.md', viewA, (content) => {
        if (viewA.state.doc.toString() !== content) {
            viewA.dispatch({ changes: { from: 0, to: viewA.state.doc.length, insert: content } });
        }
    });
    fileChangeBus.subscribe('shared.md', viewB, (content) => {
        if (viewB.state.doc.toString() !== content) {
            viewB.dispatch({ changes: { from: 0, to: viewB.state.doc.length, insert: content } });
        }
    });

    // Expose to window for test access
    (window as any).__views = { viewA, viewB };
    (window as any).__fileChangeBus = fileChangeBus;
    (window as any).__editorsReady = true;
}

init().catch(e => console.error('[multiview-test] Init failed:', e));
