import { afterEach, describe, expect, it } from 'vitest';
import { undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import { memoryVfs, type VfsInterface } from '@joinezco/storage';
import { createCodeblock, currentFileField, openFileEffect } from './editor';

const views: EditorView[] = [];
afterEach(() => {
    for (const view of views) {
        view.destroy();
        view.dom.remove();
    }
    views.length = 0;
});

function mount(fs: VfsInterface, filepath?: string): EditorView {
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = createCodeblock({ parent, fs, filepath, toolbar: false });
    views.push(view);
    return view;
}

const open = (view: EditorView, path: string) => view.dispatch({ effects: openFileEffect.of({ path }) });

const loaded = (view: EditorView, path: string) =>
    until(() => {
        const file = view.state.field(currentFileField);
        return file.path === path && !file.loading;
    });

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

async function until(condition: () => boolean, timeout = 5000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeout) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
}
