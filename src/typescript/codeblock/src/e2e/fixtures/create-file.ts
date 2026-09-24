import { createCodeblock } from "../../editor";
import { browserVfs } from "@joinezco/storage/browser";
import { Vault } from "@joinezco/storage";

async function init() {
    // Use FSA (OPFS) with unique bucket name for test isolation
    const vault = new Vault(await browserVfs(`codeblock-test-create-${Date.now()}`));
    const { fs, search, files } = vault;

    const parent = document.getElementById('editor') as HTMLDivElement;

    // Start with unnamed content (no filepath)
    const view = createCodeblock({
        parent,
        fs,
        content: 'initial content here',
        language: 'txt' as any,
        toolbar: true,
        search,
        files,
        cwd: '/',
    });

    (window as any).__view = view;
    (window as any).__fs = fs;
    (window as any).__vault = vault;
    (window as any).__ready = true;
}

init().catch(e => console.error('Init failed:', e));
