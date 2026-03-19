import { createCodeblock } from "../../editor";
import { Vfs } from "../../utils/fs";
import { SearchIndex } from "../../utils/search";

async function init() {
    const fs = await Vfs.worker();
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
