import { afterEach, describe, expect, it } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { memoryVfs, Vault, type VfsInterface } from '@joinezco/storage';
import { redo, undo } from '@codemirror/commands';
import { createCodeblock, onFileEvent, openFileEffect, persistFile, regionField, setRegionEffect, whenFileLoaded, type FileEvent, type FileVersions } from './editor';
import type { LineRange } from './utils/region';

/**
 * A code block showing some lines of a file (a note's
 * ```` ```src/lib.rs#L3-L5 ```` fence): the file is the source of truth, and
 * an edit goes back where those lines are when it is saved.
 */

const views: EditorView[] = [];
afterEach(() => {
    for (const view of views) {
        view.destroy();
        view.dom.remove();
    }
    views.length = 0;
});

const LIB = ['use std::io;', '', 'fn main() {', '    let x = 1;', '}', '', 'fn other() {}', ''].join('\n');

function mount(fs: VfsInterface, options: { range?: LineRange; content?: string; versions?: FileVersions; filepath?: string; style?: string } = {}): EditorView {
    const parent = document.createElement('div');
    if (options.style) parent.style.cssText = options.style;
    document.body.append(parent);
    const view = createCodeblock({ parent, fs, filepath: options.filepath ?? 'src/lib.rs', toolbar: false, range: options.range, content: options.content, versions: options.versions });
    views.push(view);
    return view;
}

const type = (view: EditorView, at: number, insert: string) => view.dispatch({ changes: { from: at, insert }, userEvent: 'input.type' });
/** The gutter's line numbers, less the hidden one it measures its width by. */
const numbers = (view: EditorView) =>
    [...view.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')].filter((e) => e.style.visibility !== 'hidden').map((e) => e.textContent);
const endOf = (view: EditorView, line: number) => view.state.doc.line(line).to;

async function until(condition: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
    const start = Date.now();
    while (!(await condition())) {
        if (Date.now() - start > timeout) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
}

describe('A region of a file in a code block', () => {
    it('set by the reader is undone, and redone, by showing what was shown before', async () => {
        const fs = memoryVfs({ 'src/lib.rs': LIB });
        const view = mount(fs);
        await whenFileLoaded(view, 'src/lib.rs');
        expect(view.state.doc.toString()).toBe(LIB);

        // "Show only these lines" (the menu, or `src/lib.rs#L3-L5` in the toolbar).
        view.dispatch({ effects: [openFileEffect.of({ path: 'src/lib.rs' }), setRegionEffect.of({ from: 3, to: 5 })] });
        await until(() => view.state.doc.toString() === 'fn main() {\n    let x = 1;\n}');
        expect(view.state.field(regionField)).toEqual({ from: 3, to: 5 });

        undo(view);
        await until(() => view.state.doc.toString() === LIB);
        expect(view.state.field(regionField)).toBeNull();

        redo(view);
        await until(() => view.state.doc.toString() === 'fn main() {\n    let x = 1;\n}');
        expect(view.state.field(regionField)).toEqual({ from: 3, to: 5 });

        // The region following its lines down the file (a line added above
        // them, found when the edit is saved) is the file's doing, not the
        // reader's: undo takes back the edit, then the region.
        await fs.writeFile('src/lib.rs', '//! The crate.\n' + LIB);
        type(view, endOf(view, 2), ' // changed');
        await persistFile(view);
        await until(() => view.state.field(regionField)?.from === 4);
        undo(view);
        await until(() => view.state.doc.toString() === 'fn main() {\n    let x = 1;\n}');
        expect(view.state.field(regionField)).toEqual({ from: 4, to: 6 });
        undo(view);
        await until(() => view.state.doc.toString().startsWith('//! The crate.\n'));
        expect(view.state.field(regionField)).toBeNull();
    });

    it('shows those lines, numbered as the file numbers them, and puts an edit back in their place', async () => {
        const fs = memoryVfs({ 'src/lib.rs': LIB });
        const view = mount(fs, { range: { from: 3, to: 5 } });
        await whenFileLoaded(view, 'src/lib.rs');
        expect(view.state.doc.toString()).toBe('fn main() {\n    let x = 1;\n}');
        await until(() => numbers(view).join(',') === '3,4,5');

        // A line added: the file has it at its place, and the region is a line longer.
        type(view, endOf(view, 2), '\n    let y = 2;');
        await persistFile(view);
        expect(await fs.readFile('src/lib.rs')).toBe(LIB.replace('    let x = 1;\n', '    let x = 1;\n    let y = 2;\n'));
        await until(() => view.state.field(regionField)?.to === 6);
        expect(view.state.field(regionField)).toEqual({ from: 3, to: 6 });
    });

    it('takes the file’s lines over the text it was given, and finds that text where it moved to', async () => {
        // Two lines were added above since the host last saw the region.
        const fs = memoryVfs({ 'src/lib.rs': '// one\n// two\n' + LIB });
        const moved = mount(fs, { range: { from: 3, to: 5 }, content: 'fn main() {\n    let x = 1;\n}' });
        await whenFileLoaded(moved, 'src/lib.rs');
        expect(moved.state.doc.toString()).toBe('fn main() {\n    let x = 1;\n}');
        expect(moved.state.field(regionField)).toEqual({ from: 5, to: 7 });
        await until(() => numbers(moved).join(',') === '5,6,7');

        // Text the file no longer has: the file's lines win.
        const stale = mount(memoryVfs({ 'src/lib.rs': LIB }), { range: { from: 3, to: 5 }, content: 'fn main() {\n    let x = 99;\n}' });
        await whenFileLoaded(stale, 'src/lib.rs');
        expect(stale.state.doc.toString()).toBe('fn main() {\n    let x = 1;\n}');
        expect(stale.state.field(regionField)).toEqual({ from: 3, to: 5 });
    });

    it('puts an edit where its lines are now when the file changed above them since they were shown', async () => {
        const fs = memoryVfs({ 'src/lib.rs': LIB });
        const view = mount(fs, { range: { from: 3, to: 5 } });
        await whenFileLoaded(view, 'src/lib.rs');
        await fs.writeFile('src/lib.rs', '//! The crate.\n' + LIB.replace('fn other() {}', 'fn other() { todo!() }'));
        type(view, endOf(view, 2), ' // changed here');
        await persistFile(view);
        expect(await fs.readFile('src/lib.rs')).toBe(
            '//! The crate.\n' + LIB.replace('let x = 1;', 'let x = 1; // changed here').replace('fn other() {}', 'fn other() { todo!() }'),
        );
        await until(() => view.state.field(regionField)?.from === 4);
        await until(() => numbers(view).join(',') === '4,5,6');
    });

    it('through a version log: saves on the version it shows, moves with a change above, and keeps a conflict copy when its own lines changed', async () => {
        const vault = await Vault.open(memoryVfs({ 'src/lib.rs': LIB }), { watch: false });
        const view = mount(vault.fs, { range: { from: 3, to: 5 }, versions: vault.versions });
        const events: FileEvent[] = [];
        onFileEvent(view, (event) => events.push(event));
        await whenFileLoaded(view, 'src/lib.rs');

        type(view, endOf(view, 2), ' // one');
        await persistFile(view);
        const [saved, first] = await vault.versions.history('src/lib.rs');
        expect(saved.parents).toEqual([first.id]);

        // A line added above elsewhere: not a conflict, the edit lands on the moved lines.
        await vault.fs.writeFile('src/lib.rs', '// above\n' + (await vault.fs.readFile('src/lib.rs')));
        type(view, endOf(view, 2), ' two');
        await persistFile(view);
        expect(events.filter((e) => e.type === 'conflict')).toEqual([]);
        expect(await vault.fs.readFile('src/lib.rs')).toBe('// above\n' + LIB.replace('let x = 1;', 'let x = 1; // one two'));

        // Its own lines changed elsewhere: a conflict, the copy the whole file with the region's edit.
        await vault.fs.writeFile('src/lib.rs', (await vault.fs.readFile('src/lib.rs')).replace('let x = 1;', 'let x = 42;'));
        type(view, endOf(view, 2), ' three');
        await until(() => events.some((e) => e.type === 'conflict'));
        const conflict = events.find((e) => e.type === 'conflict') as Extract<FileEvent, { type: 'conflict' }>;
        expect(conflict.copy).toMatch(/^src\/lib \(conflict, .+\)\.rs$/);
        expect(await vault.fs.readFile(conflict.copy)).toBe('// above\n' + LIB.replace('let x = 1;', 'let x = 1; // one two three'));
        expect(await vault.fs.readFile('src/lib.rs')).toBe('// above\n' + LIB.replace('let x = 1;', 'let x = 42; // one two'));
        // The region shows the file's lines again.
        await until(() => view.state.doc.toString() === 'fn main() {\n    let x = 42; // one two\n}');
    });

    it('without a log, keeps a conflict copy too rather than writing over lines changed elsewhere', async () => {
        const fs = memoryVfs({ 'src/lib.rs': LIB });
        const view = mount(fs, { range: { from: 3, to: 5 } });
        const events: FileEvent[] = [];
        onFileEvent(view, (event) => events.push(event));
        await whenFileLoaded(view, 'src/lib.rs');
        await fs.writeFile('src/lib.rs', LIB.replace('let x = 1;', 'let x = 42;'));
        type(view, endOf(view, 2), ' // mine');
        await until(() => events.some((e) => e.type === 'conflict'));
        const conflict = events.find((e) => e.type === 'conflict') as Extract<FileEvent, { type: 'conflict' }>;
        expect(await fs.readFile(conflict.copy)).toBe(LIB.replace('let x = 1;', 'let x = 1; // mine'));
        expect(await fs.readFile('src/lib.rs')).toBe(LIB.replace('let x = 1;', 'let x = 42;'));
        await until(() => view.state.doc.toString() === 'fn main() {\n    let x = 42;\n}');
    });

    it('keeps in step with the whole file open beside it, each saving on the other’s version', async () => {
        const vault = await Vault.open(memoryVfs({ 'src/lib.rs': LIB }), { watch: false });
        // The whole file in a box of its own size, so its growing moves
        // nothing on the page: all that changes for the region is its place
        // in the file.
        const region = mount(vault.fs, { range: { from: 3, to: 5 }, versions: vault.versions });
        const whole = mount(vault.fs, { versions: vault.versions, style: 'height: 300px; overflow: auto' });
        const events: FileEvent[] = [];
        onFileEvent(whole, (event) => events.push(event));
        onFileEvent(region, (event) => events.push(event));
        await whenFileLoaded(whole, 'src/lib.rs');
        await whenFileLoaded(region, 'src/lib.rs');

        // Typed in the region: the whole file shows it.
        type(region, endOf(region, 2), ' // from the region');
        await persistFile(region);
        await until(() => whole.state.doc.toString().includes('// from the region'));

        // A line added at the top of the whole file: the region moves down with its lines.
        whole.dispatch({ changes: { from: 0, insert: '// top\n' }, userEvent: 'input.type' });
        await persistFile(whole);
        await until(() => region.state.field(regionField)?.from === 4);
        expect(region.state.doc.toString()).toBe('fn main() {\n    let x = 1; // from the region\n}');
        await until(() => numbers(region).join(',') === '4,5,6');

        // And the region saves again on the version the whole file made.
        type(region, 0, '#[inline]\n');
        await persistFile(region);
        expect(events.filter((e) => e.type === 'conflict')).toEqual([]);
        expect(await vault.fs.readFile('src/lib.rs')).toBe('// top\n' + LIB.replace('fn main', '#[inline]\nfn main').replace('let x = 1;', 'let x = 1; // from the region'));
        await until(() => whole.state.doc.toString() === '// top\n' + LIB.replace('fn main', '#[inline]\nfn main').replace('let x = 1;', 'let x = 1; // from the region'));
    });

    it('numbers its lines from where they are, even when nothing else about it changes', async () => {
        const view = mount(memoryVfs({ 'src/lib.rs': LIB }), { range: { from: 3, to: 5 } });
        await whenFileLoaded(view, 'src/lib.rs');
        await until(() => numbers(view).join(',') === '3,4,5');
        // Settled: the view's first measure (which redraws the gutter) is done.
        for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
        // What a save or another view does when the lines moved but are the same.
        view.dispatch({ effects: setRegionEffect.of({ from: 40, to: 42 }) });
        await until(() => numbers(view).join(',') === '40,41,42');
    });

    it('is the whole file again once another file is opened in it', async () => {
        const fs = memoryVfs({ 'src/lib.rs': LIB, 'b.txt': 'one\ntwo\nthree' });
        const view = mount(fs, { range: { from: 3, to: 5 } });
        await whenFileLoaded(view, 'src/lib.rs');
        view.dispatch({ effects: openFileEffect.of({ path: 'b.txt' }) });
        await whenFileLoaded(view, 'b.txt');
        expect(view.state.doc.toString()).toBe('one\ntwo\nthree');
        expect(view.state.field(regionField)).toBeNull();
        await until(() => numbers(view).join(',') === '1,2,3');
    });
});
