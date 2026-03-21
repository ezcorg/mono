import { createCodeblock } from "../../editor";
import { Vfs } from "../../utils/fs";
import { SearchIndex } from "../../utils/search";

async function init() {
    // Use FSA (OPFS) with unique bucket name for test isolation
    const fs = await Vfs.fsa(`codeblock-test-create-${Date.now()}`);
    const index = await SearchIndex.get(fs, '.codeblock/index.json');

    const parent = document.getElementById('editor') as HTMLDivElement;

    // Start with unnamed content (no filepath)
    const view = createCodeblock({
        parent,
        fs,
        content: 'initial content here',
        language: 'txt' as any,
        toolbar: true,
        index,
        cwd: '/',
    });

    (window as any).__view = view;
    (window as any).__fs = fs;
    (window as any).__index = index;
    (window as any).__ready = true;
}

init().catch(e => console.error('Init failed:', e));
