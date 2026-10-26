// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { memoryVfs } from '@joinezco/storage';
import { ToolbarCore, getFileIcon } from './toolbar-core';

vi.mock('../lsps', () => ({ extOrLanguageToLanguageId: { ts: 'typescript', md: 'markdown' } }));

describe('Files imported from disk', () => {
    it('keep their bytes, whatever their names say', async () => {
        const fs = memoryVfs({});
        const opened: string[] = [];
        const core = new ToolbarCore({
            fs,
            openFile: (path) => void opened.push(path),
            getDocContent: () => '',
            focusEditor() {},
            persist: async () => {},
            closeFile() {},
        });
        // Text that is not UTF-8 (Latin-1's "café"), a BOM, and an image under
        // a name the toolbar has no list entry for.
        const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
        const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
        const heic = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe]);
        const files = [new File([latin1], 'notes.txt'), new File([bom], 'bom.md'), new File([heic], 'photo.heic')];
        await (core as unknown as { importFiles(files: File[]): Promise<void> }).importFiles(files);
        expect([...(await fs.readBytes('notes.txt'))]).toEqual([...latin1]);
        expect([...(await fs.readBytes('bom.md'))]).toEqual([...bom]);
        expect([...(await fs.readBytes('photo.heic'))]).toEqual([...heic]);
        expect(opened).toEqual(['notes.txt']);
        core.destroy();
    });
});

describe('The field, as files open', () => {
    // The dropdown scrolls its selection into view; jsdom has no layout.
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    const make = (opened: string[]) =>
        new ToolbarCore({
            fs: memoryVfs({}),
            openFile: (path) => void opened.push(path),
            getDocContent: () => '',
            focusEditor() {},
            persist: async () => {},
            closeFile() {},
        });
    const typeInto = (core: ToolbarCore, text: string) => {
        core.input.focus();
        core.input.value = text;
        core.input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    it('keeps what is being typed when a file opens on its own, and names it once the field is reset', () => {
        const core = make([]);
        document.body.append(core.dom);
        typeInto(core, 'src/li');
        // The block's own file arrives (a region loading) under the typing.
        core.setFilePath('note.md');
        expect(core.input.value).toBe('src/li');
        core.resetInputToCurrentFile();
        expect(core.input.value).toBe('note.md');
        // Not being typed in, the field follows the file.
        core.input.blur();
        core.setFilePath('other.md', 'other.md#L2-L3');
        expect(core.input.value).toBe('other.md#L2-L3');
        core.destroy();
        core.dom.remove();
    });

    it('names the file it opened itself, lines and all, though the field is still focused', () => {
        const opened: string[] = [];
        const core = make(opened);
        document.body.append(core.dom);
        typeInto(core, 'src/lib.rs#L2-L3');
        (core as unknown as { handleSearchResult(r: unknown): void }).handleSearchResult({ id: 'src/lib.rs', path: 'src/lib.rs', match: 'path' });
        expect(opened).toEqual(['src/lib.rs#L2-L3']);
        expect(document.activeElement).toBe(core.input);
        core.setFilePath('src/lib.rs', 'src/lib.rs#L2-L3');
        expect(core.input.value).toBe('src/lib.rs#L2-L3');
        core.destroy();
        core.dom.remove();
    });
});

describe('Create new file, for a language', () => {
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    const make = (setLanguage?: (language: string) => void) => {
        const languages: string[] = [];
        const opened: string[] = [];
        const focused = { count: 0 };
        const core = new ToolbarCore({
            fs: memoryVfs({}),
            openFile: (path) => void opened.push(path),
            getDocContent: () => '',
            focusEditor() {
                focused.count++;
            },
            persist: async () => {},
            closeFile() {},
            ...(setLanguage ? { setLanguage: (language: string) => (languages.push(language), setLanguage(language)) } : {}),
        });
        document.body.append(core.dom);
        return { core, languages, opened, focused };
    };
    const press = (core: ToolbarCore, key: string) => core.input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const startNaming = (core: ToolbarCore, query: string) =>
        (core as unknown as { handleCommandResult(c: unknown): void }).handleCommandResult({ id: 'Create new file', type: 'create-file', icon: '', query, requiresInput: true });

    it('takes Enter on an empty name as "no name": the block becomes one of the language, and the field says so', () => {
        const { core, languages, opened, focused } = make(() => {});
        startNaming(core, 'yml');
        expect(core.isNamingModeActive()).toBe(true);
        expect(core.input.placeholder).toBe('filename.yml (or Enter for an unnamed yml block)');
        press(core, 'Enter');
        expect(core.isNamingModeActive()).toBe(false);
        expect(languages).toEqual(['yml']);
        expect(opened).toEqual([]);
        expect(core.input.value).toBe('yml');
        expect(core.input.placeholder).toBe('');
        expect(focused.count).toBe(1);
        core.destroy();
        core.dom.remove();
    });

    it('still names the file when a name is typed, with the language as its extension', async () => {
        const { core, languages, opened } = make(() => {});
        startNaming(core, 'yml');
        core.input.value = 'config';
        press(core, 'Enter');
        // The path is checked against the filesystem before the file is made.
        await new Promise((r) => setTimeout(r, 20));
        expect(languages).toEqual([]);
        expect(opened).toEqual(['config.yml']);
        core.destroy();
        core.dom.remove();
    });

    it('requires a name where the host keeps no unnamed blocks', () => {
        const { core, opened } = make();
        startNaming(core, 'yml');
        expect(core.input.placeholder).toBe('filename.yml');
        press(core, 'Enter');
        expect(core.isNamingModeActive()).toBe(true);
        expect(opened).toEqual([]);
        core.destroy();
        core.dom.remove();
    });
});

describe('Deleting a file from the field', () => {
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    const press = (core: ToolbarCore, key: string) => core.input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

    it('offers "Delete" for the file the field names, asks, and removes it on Enter', async () => {
        const fs = memoryVfs({ 'notes/a.md': '# A', 'notes/b.md': '# B' });
        const closed: string[] = [];
        const core = new ToolbarCore({
            fs,
            filepath: 'notes/a.md',
            openFile() {},
            getDocContent: () => '# A',
            focusEditor() {},
            persist: async () => {},
            closeFile() {
                closed.push('closed');
            },
            getCurrentFilePath: () => 'notes/a.md',
        });
        document.body.append(core.dom);
        // The field clicked into, untouched: the open file's commands.
        core.input.focus();
        core.input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 20));
        const labels = [...core.dom.querySelectorAll('.cm-search-result-label')].map((l) => l.textContent);
        expect(labels).toContain('Delete "notes/a.md"');
        const row = [...core.dom.querySelectorAll<HTMLElement>('.cm-search-result')].find((r) => r.textContent?.includes('Delete "notes/a.md"'))!;
        row.click();
        expect(core.input.placeholder).toBe('Delete "notes/a.md"? (Enter to confirm, Esc to cancel)');
        press(core, 'Enter');
        await new Promise((r) => setTimeout(r, 20));
        expect(await fs.exists('notes/a.md')).toBe(false);
        expect(await fs.exists('notes/b.md')).toBe(true);
        // The open file was put down first, not written back.
        expect(closed).toEqual(['closed']);
        core.destroy();
        core.dom.remove();
    });

    it('offers no "Delete" for a name that is not a file', async () => {
        const core = new ToolbarCore({
            fs: memoryVfs({ 'a.md': '# A' }),
            openFile() {},
            getDocContent: () => '',
            focusEditor() {},
            persist: async () => {},
            closeFile() {},
        });
        document.body.append(core.dom);
        core.input.focus();
        core.input.value = 'nothing.md';
        core.input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 20));
        const labels = [...core.dom.querySelectorAll('.cm-search-result-label')].map((l) => l.textContent);
        expect(labels.some((l) => l?.startsWith('Delete'))).toBe(false);
        core.destroy();
        core.dom.remove();
    });
});

describe('The list, in sections', () => {
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    const press = (core: ToolbarCore, key: string) => core.input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    const rows = (core: ToolbarCore) => [...core.dom.querySelectorAll<HTMLElement>('.cm-search-results > li')];
    const labels = (core: ToolbarCore) => rows(core).map((li) => (li.matches('.cm-search-separator') ? '---' : li.querySelector('.cm-search-result-label')!.textContent));
    const settle = () => new Promise((r) => setTimeout(r, 20));
    const hit = (path: string) => ({ path, score: 1, match: 'path' as const });

    it('divides the open file’s commands from the host’s and from the settings, Delete among the file’s and Settings last', async () => {
        const core = new ToolbarCore({
            fs: memoryVfs({ 'notes/a.md': '# A' }),
            filepath: 'notes/a.md',
            openFile() {},
            getDocContent: () => '# A',
            focusEditor() {},
            persist: async () => {},
            closeFile() {},
            getCurrentFilePath: () => 'notes/a.md',
            commands: () => [{ id: 'Toggle sidebar', run() {} }],
            buildSettingsEntries: () => [],
        });
        document.body.append(core.dom);
        core.input.focus();
        core.input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await settle();
        // The field names the open file, so there is nothing to save or create it as.
        expect(labels(core)).toEqual([
            'Open file', 'Import file(s)', 'Import folder', 'Delete "notes/a.md"',
            '---', 'Toggle sidebar',
            '---', 'Settings',
        ]);
        // The lines are passed over: the arrows go row to row.
        for (let i = 0; i < 4; i++) press(core, 'ArrowDown');
        expect(core.dom.querySelector('.cm-search-result.selected .cm-search-result-label')!.textContent).toBe('Toggle sidebar');
        core.destroy();
        core.dom.remove();
    });

    it('keeps the selection on the row "Show more" stood on, which is the first file it hid', async () => {
        const hits = ['notes/one.md', 'notes/two.md', 'notes/three.md', 'notes/four.md', 'notes/five.md'].map(hit);
        const core = new ToolbarCore({
            fs: memoryVfs({}),
            search: { search: async () => hits },
            openFile() {},
            getDocContent: () => '',
            focusEditor() {},
            persist: async () => {},
            closeFile() {},
        });
        document.body.append(core.dom);
        core.input.focus();
        core.input.value = 'notes';
        core.input.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        expect(labels(core).slice(0, 4)).toEqual(['notes/one.md', 'notes/two.md', 'Show 3 more results', '---']);
        press(core, 'ArrowDown');
        press(core, 'ArrowDown');
        press(core, 'Enter');
        await settle();
        expect(labels(core).slice(0, 6)).toEqual(['notes/one.md', 'notes/two.md', 'notes/three.md', 'notes/four.md', 'notes/five.md', '---']);
        expect(core.dom.querySelector('.cm-search-result.selected .cm-search-result-label')!.textContent).toBe('notes/three.md');
        core.destroy();
        core.dom.remove();
    });

    it('knows the file a query names wherever the search ranks it', async () => {
        const core = new ToolbarCore({
            fs: memoryVfs({}),
            search: { search: async () => [hit('notes/testing.md'), hit('test.md')] },
            openFile() {},
            getDocContent: () => '',
            focusEditor() {},
            persist: async () => {},
            closeFile() {},
        });
        document.body.append(core.dom);
        core.input.focus();
        core.input.value = 'test.md';
        core.input.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        const all = labels(core);
        expect(all).toContain('Delete "test.md"');
        expect(all.some((l) => l?.startsWith('Create new file'))).toBe(false);
        core.destroy();
        core.dom.remove();
    });
});

describe('The state icon', () => {
    it('is the open file’s at rest, in its colour, and the search’s while the field is used or pointed at', () => {
        const core = new ToolbarCore({
            fs: memoryVfs({ 'notes/a.md': '# A' }),
            filepath: 'notes/a.md',
            openFile() {},
            getDocContent: () => '# A',
            focusEditor() {},
            persist: async () => {},
            closeFile() {},
        });
        document.body.append(core.dom);
        const md = getFileIcon('notes/a.md').glyph;
        const search = String.fromCharCode(0xf002);
        expect(md).not.toBe(search);
        expect(core.stateIcon.textContent).toBe(md);
        expect(core.stateIcon.style.color).not.toBe('');
        core.input.focus();
        core.input.dispatchEvent(new Event('focus'));
        expect(core.stateIcon.textContent).toBe(search);
        expect(core.stateIcon.style.color).toBe('');
        core.input.blur();
        core.input.dispatchEvent(new Event('blur'));
        expect(core.stateIcon.textContent).toBe(md);
        core.dom.dispatchEvent(new Event('pointerenter'));
        expect(core.stateIcon.textContent).toBe(search);
        core.dom.dispatchEvent(new Event('pointerleave'));
        expect(core.stateIcon.textContent).toBe(md);
        // Another file opened: its icon.
        core.setFilePath('src/lib.ts');
        expect(core.stateIcon.textContent).toBe(getFileIcon('src/lib.ts').glyph);
        expect(core.stateIcon.textContent).not.toBe(md);
        core.destroy();
        core.dom.remove();
    });
});
