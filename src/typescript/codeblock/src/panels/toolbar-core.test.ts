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
