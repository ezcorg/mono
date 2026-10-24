import { describe, expect, it } from 'vitest';
import { clampRange, findRegion, followRange, formatLineRange, lineCount, lineRange, mapRange, rangeOf, sliceLines, spliceLines } from './region';

const FILE = ['use std::io;', '', 'fn main() {', '    let x = 1;', '    println!("{x}");', '}', ''].join('\n');

describe('A line range', () => {
    it('reads and writes GitHub’s fragment', () => {
        expect(lineRange('L3-L6')).toEqual({ from: 3, to: 6 });
        expect(lineRange('L3-6')).toEqual({ from: 3, to: 6 });
        expect(lineRange('l4')).toEqual({ from: 4, to: 4 });
        // Backwards is the line alone; nonsense is nothing.
        expect(lineRange('L6-L3')).toEqual({ from: 6, to: 6 });
        expect(lineRange('Goals')).toBeNull();
        expect(lineRange(null)).toBeNull();
        expect(formatLineRange({ from: 3, to: 6 })).toBe('L3-L6');
        expect(formatLineRange({ from: 4, to: 4 })).toBe('L4');
    });

    it('slices a file’s lines, and puts others in their place', () => {
        expect(lineCount(FILE)).toBe(6);
        expect(sliceLines(FILE, { from: 3, to: 6 })).toBe('fn main() {\n    let x = 1;\n    println!("{x}");\n}');
        const next = spliceLines(FILE, { from: 4, to: 4 }, '    let x = 1;\n    let y = 2;');
        expect(next).toBe(['use std::io;', '', 'fn main() {', '    let x = 1;', '    let y = 2;', '    println!("{x}");', '}', ''].join('\n'));
        expect(rangeOf(4, '    let x = 1;\n    let y = 2;')).toEqual({ from: 4, to: 5 });
        // A range past the end is kept to the lines there are.
        expect(clampRange({ from: 5, to: 40 }, lineCount(FILE))).toEqual({ from: 5, to: 6 });
        expect(clampRange({ from: 40, to: 80 }, lineCount(FILE))).toEqual({ from: 6, to: 6 });
    });
});

describe('Following a range across an edit', () => {
    const range = { from: 3, to: 6 };

    it('moves it by the lines added or taken away above it', () => {
        const added = '// a header\n// of two lines\n' + FILE;
        expect(mapRange(FILE, added, range)).toEqual({ from: 5, to: 8 });
        const removed = FILE.replace('use std::io;\n\n', '');
        expect(mapRange(FILE, removed, range)).toEqual({ from: 1, to: 4 });
        // Right before the first line is above it.
        const touching = FILE.replace('\nfn main', '\n// main\nfn main');
        expect(mapRange(FILE, touching, range)).toEqual({ from: 4, to: 7 });
    });

    it('leaves it where it is for an edit below it', () => {
        expect(mapRange(FILE, FILE + 'fn other() {}\n', range)).toEqual(range);
    });

    it('gives up on an edit to its own lines', () => {
        expect(mapRange(FILE, FILE.replace('let x = 1', 'let x = 2'), range)).toBeNull();
        expect(followRange(FILE, FILE.replace('let x = 1', 'let x = 2'), range)).toBeNull();
    });

    it('finds the lines by their text when edits on both sides of them make one run', () => {
        const both = '// above\n' + FILE + 'fn below() {}\n';
        expect(mapRange(FILE, both, range)).toBeNull();
        expect(followRange(FILE, both, range)).toEqual({ from: 4, to: 7 });
    });

    it('finds the nearest of repeated lines, and not lines that are only blank', () => {
        const repeated = 'x\n}\ny\n}\nz';
        expect(findRegion(repeated, '}', 4)).toEqual({ from: 4, to: 4 });
        expect(findRegion(repeated, '}', 1)).toEqual({ from: 2, to: 2 });
        expect(findRegion(FILE, '', 2)).toBeNull();
        expect(findRegion(FILE, 'fn nothing()', 2)).toBeNull();
    });
});
