// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { memoryVfs } from '@joinezco/storage';
import { ToolbarCore } from './toolbar-core';

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
