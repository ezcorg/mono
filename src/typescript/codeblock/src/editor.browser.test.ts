import { afterEach, describe, expect, it } from 'vitest';
import { undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { memoryVfs, Vault, type VfsInterface } from '@joinezco/storage';
import { opfsBucket, opfsVfs, removeOpfsBucket } from '@joinezco/storage/browser';
import { createCodeblock, currentFileField, onFileEvent, openFileEffect, whenFileLoaded, type FileEvent } from './editor';

const views: EditorView[] = [];
afterEach(() => {
    for (const view of views) {
        view.destroy();
        view.dom.remove();
    }
    views.length = 0;
});

function mount(fs: VfsInterface, filepath?: string, toolbar = false, vault?: Vault): EditorView {
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = createCodeblock({ parent, fs, filepath, toolbar, search: vault?.search, files: vault?.files });
    views.push(view);
    return view;
}

const open = (view: EditorView, path: string) => view.dispatch({ effects: openFileEffect.of({ path }) });

const loaded = (view: EditorView, path: string) => whenFileLoaded(view, path);

/** Past the autosave's 500 ms debounce. */
const autosave = () => new Promise((r) => setTimeout(r, 700));

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

describe('Files in a code block', () => {
    it('leave an image as it is: opening it, waiting and leaving it write nothing', async () => {
        const fs = memoryVfs({ 'pic.png': PNG, 'a.txt': 'text' });
        const view = mount(fs, 'a.txt');
        await loaded(view, 'a.txt');
        open(view, 'pic.png');
        await loaded(view, 'pic.png');
        expect(view.state.readOnly).toBe(true);
        await autosave();
        expect([...(await fs.readBytes('pic.png'))]).toEqual([...PNG]);
        open(view, 'a.txt');
        await loaded(view, 'a.txt');
        expect(view.state.readOnly).toBe(false);
        await autosave();
        expect([...(await fs.readBytes('pic.png'))]).toEqual([...PNG]);
    });

    it('keep an image’s bytes when it is renamed from the toolbar', async () => {
        const fs = memoryVfs({ 'pic.png': PNG });
        const view = mount(fs, 'pic.png', true);
        await loaded(view, 'pic.png');
        const input = view.dom.querySelector('.cm-toolbar-input') as HTMLInputElement;
        input.focus();
        input.value = 'moved.png';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const command = () => [...view.dom.querySelectorAll('.cm-command-result')].find((r) => r.textContent?.includes('Rename to "moved.png"')) as HTMLElement | undefined;
        await until(() => !!command());
        command()!.click();
        await loaded(view, 'moved.png');
        expect(await fs.exists('pic.png')).toBe(false);
        expect([...(await fs.readBytes('moved.png'))]).toEqual([...PNG]);
    });

    it('are put down unsaved when deleted from the toolbar while open', async () => {
        const vault = await Vault.open(memoryVfs({ 'a.txt': 'A', 'b.txt': 'B' }), { watch: false });
        const view = mount(vault.fs, 'a.txt', true, vault);
        const events: FileEvent[] = [];
        onFileEvent(view, (event) => events.push(event));
        await loaded(view, 'a.txt');
        // An edit still inside the autosave debounce.
        view.dispatch({ changes: { from: 1, insert: '!' }, userEvent: 'input.type' });
        const input = view.dom.querySelector('.cm-toolbar-input') as HTMLInputElement;
        const key = (k: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
        input.focus();
        input.value = 'a.txt';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await until(() => !!view.dom.querySelector('.cm-file-result'));
        for (let i = 0; i < 5 && !view.dom.querySelector('.cm-file-result.selected'); i++) key('ArrowDown');
        key('Delete');
        key('Enter');
        await until(() => events.some((e) => e.type === 'close'));
        await autosave();
        expect(await vault.fs.exists('a.txt')).toBe(false);
        expect(view.state.field(currentFileField).path).toBeNull();
        expect(view.state.doc.toString()).toBe('');
        expect(view.state.readOnly).toBe(false);
        expect(events[events.length - 1]).toEqual({ type: 'close', path: 'a.txt' });
    });

    it('rename to another spelling of their name on a disk that ignores case', async () => {
        const store = caseInsensitive(memoryVfs({ 'plan.md': '# Plan' }));
        const vault = await Vault.open(store, { watch: false });
        const view = mount(vault.fs, 'plan.md', true, vault);
        await loaded(view, 'plan.md');
        const input = view.dom.querySelector('.cm-toolbar-input') as HTMLInputElement;
        input.focus();
        input.value = 'Plan.md';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const command = () => [...view.dom.querySelectorAll('.cm-command-result')].find((r) => r.textContent?.includes('Rename to "Plan.md"')) as HTMLElement | undefined;
        await until(() => !!command());
        command()!.click();
        // No "exists, overwrite?": it is the same file.
        await loaded(view, 'Plan.md');
        expect(input.placeholder).not.toMatch(/Overwrite/);
        expect((await store.readDir('/')).map(([name]) => name)).toEqual(['Plan.md']);
        expect(await store.readFile('Plan.md')).toBe('# Plan');
    });

    it('act on what is typed, not an earlier keystroke’s results, when Enter comes first', async () => {
        const vault = await Vault.open(memoryVfs({ 'a.txt': 'A', 'plan.md': '# Plan' }), { watch: false });
        // The search for `plan` answers after Enter is pressed.
        const search = {
            search: async (query: string, options?: { limit?: number }) => {
                if (query === 'plan') await new Promise((r) => setTimeout(r, 300));
                return vault.search.search(query, options);
            },
        };
        const parent = document.createElement('div');
        document.body.append(parent);
        const view = createCodeblock({ parent, fs: vault.fs, filepath: 'a.txt', toolbar: true, search, files: vault.files });
        views.push(view);
        await loaded(view, 'a.txt');
        const input = view.dom.querySelector('.cm-toolbar-input') as HTMLInputElement;
        const type = (text: string) => {
            input.value = text;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        input.focus();
        type('x');
        await until(() => [...view.dom.querySelectorAll('.cm-command-result')].some((r) => r.textContent?.includes('"x"')));
        type('plan');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await loaded(view, 'plan.md');
        expect(await vault.fs.exists('x')).toBe(false);
    });

    it('clear their own files, leaving the origin’s other vaults, and stay editable', async () => {
        const other = opfsVfs(await opfsBucket('codeblock-test-other-vault'));
        await other.writeFile('keep.md', 'kept');
        const fs = memoryVfs({ 'a.txt': 'A', 'dir/b.txt': 'B' });
        const view = mount(fs, 'a.txt', true);
        await loaded(view, 'a.txt');
        const input = view.dom.querySelector('.cm-toolbar-input') as HTMLInputElement;
        input.focus();
        input.value = 'settings';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const entry = () => [...view.dom.querySelectorAll('.cm-search-result')].find((r) => r.textContent?.includes('Clear filesystem')) as HTMLElement | undefined;
        await until(() => !!entry());
        entry()!.click();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await until(() => view.state.field(currentFileField).path === null);
        await until(async () => !(await fs.exists('a.txt')) && !(await fs.exists('dir/b.txt')));
        expect(view.state.readOnly).toBe(false);
        expect(await other.readFile('keep.md')).toBe('kept');
        await removeOpfsBucket('codeblock-test-other-vault');
    });

    it('show a file that is not text instead of editing it, and never write it', async () => {
        // A PDF's head: text, then bytes that are not UTF-8, and NULs.
        const pdf = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n'), 0xe2, 0xe3, 0xcf, 0xd3, 0, 0, 10, 0xff]);
        const fs = memoryVfs({ 'doc.pdf': pdf, 'a.txt': 'text' });
        const view = mount(fs, 'a.txt');
        await loaded(view, 'a.txt');
        open(view, 'doc.pdf');
        await loaded(view, 'doc.pdf');
        expect(view.state.readOnly).toBe(true);
        expect(view.dom.querySelector('.cm-binary-preview')?.textContent).toMatch(/doc\.pdf.*not text/);
        await autosave();
        open(view, 'a.txt');
        await loaded(view, 'a.txt');
        await autosave();
        expect([...(await fs.readBytes('doc.pdf'))]).toEqual([...pdf]);
        expect(view.dom.querySelector('.cm-binary-preview')).toBeNull();
    });

    it('are written when edited, and only then (an untouched file keeps its CRLFs)', async () => {
        const fs = memoryVfs({ 'crlf.txt': 'one\r\ntwo\r\n', 'b.txt': 'b' });
        const view = mount(fs, 'crlf.txt');
        await loaded(view, 'crlf.txt');
        open(view, 'b.txt');
        await loaded(view, 'b.txt');
        await autosave();
        expect(await fs.readFile('crlf.txt')).toBe('one\r\ntwo\r\n');
        expect(await fs.readFile('b.txt')).toBe('b');
        view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
        await autosave();
        expect(await fs.readFile('b.txt')).toBe('xb');
    });

    it('load the last file asked for when opens overlap', async () => {
        const fs = memoryVfs({ 'long.txt': 'a much longer first file', 'b.txt': 'B', 'c.txt': 'C' });
        const view = mount(fs, 'long.txt');
        await loaded(view, 'long.txt');
        open(view, 'b.txt');
        open(view, 'c.txt');
        await loaded(view, 'c.txt');
        await autosave();
        expect(view.state.doc.toString()).toBe('C');
        expect(await fs.readFile('b.txt')).toBe('B');
        expect(await fs.readFile('c.txt')).toBe('C');
    });

    it('say when they are loaded and saved, and can be waited for', async () => {
        const fs = memoryVfs({ 'a.txt': 'A', 'b.txt': 'B' });
        const view = mount(fs, 'a.txt');
        const events: FileEvent[] = [];
        onFileEvent(view, (event) => events.push(event));
        await whenFileLoaded(view, 'a.txt');
        // Already loaded: resolves at once.
        await whenFileLoaded(view);
        open(view, 'b.txt');
        await whenFileLoaded(view, 'b.txt');
        view.dispatch({ changes: { from: 1, insert: '!' }, userEvent: 'input.type' });
        await until(() => events.some((e) => e.type === 'save'));
        expect(events).toEqual([
            { type: 'load', path: 'a.txt' },
            { type: 'load', path: 'b.txt' },
            { type: 'save', path: 'b.txt' },
        ]);
        expect(await fs.readFile('b.txt')).toBe('B!');
    });

    it('say when one cannot be opened, or saved (and keep the edits unsaved)', async () => {
        const store = memoryVfs({ 'a.txt': 'A', 'locked.txt': 'L' });
        let failWrites = true;
        const fs: VfsInterface = {
            ...store,
            readBytes: (path) => (path === 'locked.txt' ? Promise.reject(new Error('EACCES')) : store.readBytes(path)),
            writeFile: (path, data) => (failWrites ? Promise.reject(new Error('EROFS')) : store.writeFile(path, data)),
        };
        const view = mount(fs, 'a.txt');
        const events: FileEvent[] = [];
        onFileEvent(view, (event) => events.push(event));
        await loaded(view, 'a.txt');
        view.dispatch({ changes: { from: 1, insert: '!' }, userEvent: 'input.type' });
        await until(() => events.some((e) => e.type === 'error'));
        expect(events.find((e) => e.type === 'error')).toMatchObject({ path: 'a.txt', error: { message: 'EROFS' } });
        failWrites = false;
        // Still unsaved, so leaving writes it.
        open(view, 'locked.txt');
        await expect(whenFileLoaded(view, 'locked.txt')).rejects.toThrow('EACCES');
        expect(await store.readFile('a.txt')).toBe('A!');
    });

    it('save on the version they loaded, and keep their edits as a conflict copy when the file changed underneath', async () => {
        const vault = await Vault.open(memoryVfs({ 'a.txt': 'A' }), { watch: false });
        const parent = document.createElement('div');
        document.body.append(parent);
        const view = createCodeblock({ parent, fs: vault.fs, filepath: 'a.txt', toolbar: false, versions: vault.versions });
        views.push(view);
        const events: FileEvent[] = [];
        onFileEvent(view, (event) => events.push(event));
        await loaded(view, 'a.txt');

        // A save on top of the loaded version is a new version on it.
        view.dispatch({ changes: { from: 1, insert: '1' }, userEvent: 'input.type' });
        await until(() => events.some((e) => e.type === 'save'));
        const [saved, first] = await vault.versions.history('a.txt');
        expect(saved.parents).toEqual([first.id]);

        // Changed underneath (another program), then edited here.
        await vault.fs.writeFile('a.txt', 'changed elsewhere');
        view.dispatch({ changes: { from: 2, insert: '2' }, userEvent: 'input.type' });
        await until(() => events.some((e) => e.type === 'conflict'));
        const conflict = events.find((e) => e.type === 'conflict') as Extract<FileEvent, { type: 'conflict' }>;
        expect(conflict.path).toBe('a.txt');
        expect(conflict.copy).toMatch(/^a \(conflict, .+\)\.txt$/);
        expect(await vault.fs.readFile(conflict.copy)).toBe('A12');
        // The file is the other writer's, and so is the view now.
        expect(await vault.fs.readFile('a.txt')).toBe('changed elsewhere');
        await until(() => view.state.doc.toString() === 'changed elsewhere');
        // Editing on from there is a save, not another conflict.
        view.dispatch({ changes: { from: 0, insert: '3 ' }, userEvent: 'input.type' });
        await until(async () => (await vault.fs.readFile('a.txt')) === '3 changed elsewhere');
        expect(events.filter((e) => e.type === 'conflict')).toHaveLength(1);
    });

    it('keep one file’s edits out of the next one’s undo', async () => {
        const fs = memoryVfs({ 'a.txt': 'A', 'b.txt': 'B' });
        const view = mount(fs, 'a.txt');
        await loaded(view, 'a.txt');
        view.dispatch({ changes: { from: 1, insert: '!' }, userEvent: 'input.type' });
        open(view, 'b.txt');
        await loaded(view, 'b.txt');
        undo(view);
        await autosave();
        expect(view.state.doc.toString()).toBe('B');
        expect(await fs.readFile('b.txt')).toBe('B');
        expect(await fs.readFile('a.txt')).toBe('A!');
    });
});

async function until(condition: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
    const start = Date.now();
    while (!(await condition())) {
        if (Date.now() - start > timeout) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
}

/** `fs` as a disk that ignores case: a path finds an entry however it is
 *  spelled; names keep the spelling they were given. */
function caseInsensitive(fs: VfsInterface): VfsInterface {
    const spelled = async (path: string) => {
        let out = '';
        for (const segment of path.split('/').filter(Boolean)) {
            const entries = await fs.readDir(out || '/').catch(() => [] as [string, number][]);
            const found = entries.find(([name]) => name.toLowerCase() === segment.toLowerCase())?.[0] ?? segment;
            out = out ? `${out}/${found}` : found;
        }
        return out;
    };
    const at = <A extends unknown[], R>(fn: (path: string, ...rest: A) => Promise<R>) =>
        async (path: string, ...rest: A): Promise<R> => fn(await spelled(path), ...rest);
    return {
        readFile: at((p) => fs.readFile(p)),
        writeFile: at((p, d: string) => fs.writeFile(p, d)),
        readBytes: at((p) => fs.readBytes(p)),
        writeBytes: at((p, d: Uint8Array) => fs.writeBytes(p, d)),
        mkdir: at((p, o: { recursive: boolean }) => fs.mkdir(p, o)),
        readDir: at((p) => fs.readDir(p)),
        exists: at((p) => fs.exists(p)),
        stat: at((p) => fs.stat(p)),
        unlink: at((p) => fs.unlink(p)),
        async rename(oldPath, newPath) {
            const from = await spelled(oldPath);
            const to = await spelled(newPath);
            if (to !== from) return fs.rename(from, to);
            const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
            return fs.rename(from, parent + newPath.split('/').pop());
        },
        watch: (path, options) => fs.watch(path, options),
    };
}
