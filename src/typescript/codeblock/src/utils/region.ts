/**
 * Regions: some lines of a file, shown and edited on their own (in a note,
 * a fence such as ```` ```src/lib.rs#L40-L80 ````). The file stays the
 * source of truth: a region's lines are read from it, and an edit is put
 * back where those lines are now, which need not be where they were when
 * they were shown.
 */

/** Lines `from` to `to`, 1-based and inclusive. */
export interface LineRange {
    from: number;
    to: number;
}

/** `L40-L80` or `L40` (GitHub's fragment for lines): the range, or null. */
export function lineRange(fragment: string | null | undefined): LineRange | null {
    const m = /^L(\d+)(?:-L?(\d+))?$/i.exec(fragment ?? '');
    if (!m) return null;
    const from = Math.max(1, Number(m[1]));
    return { from, to: m[2] ? Math.max(from, Number(m[2])) : from };
}

/** The range as a fragment: `L40-L80`, or `L40` for one line. */
export function formatLineRange({ from, to }: LineRange): string {
    return from === to ? `L${from}` : `L${from}-L${to}`;
}

const linesOf = (text: string) => text.split('\n');

/** How many lines `text` has, a final newline ending the last rather than
 *  starting another. */
export function lineCount(text: string): number {
    const lines = linesOf(text);
    return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** The range, kept to lines a text of `count` lines has. */
export function clampRange(range: LineRange, count: number): LineRange {
    const last = Math.max(1, count);
    const from = Math.min(Math.max(1, range.from), last);
    return { from, to: Math.min(Math.max(from, range.to), last) };
}

/** The lines of `range` in `text`. */
export function sliceLines(text: string, range: LineRange): string {
    return linesOf(text).slice(range.from - 1, range.to).join('\n');
}

/** `text` with the lines of `range` replaced by the lines of `region`. */
export function spliceLines(text: string, range: LineRange, region: string): string {
    const lines = linesOf(text);
    return [...lines.slice(0, range.from - 1), ...linesOf(region), ...lines.slice(range.to)].join('\n');
}

/** The range `region` takes up when its first line is `from`. */
export function rangeOf(from: number, region: string): LineRange {
    return { from, to: from + linesOf(region).length - 1 };
}

/**
 * Where the lines of `range` in `before` are in `after`, when the two differ
 * in one run of lines (what matches at both ends is kept): moved by the lines
 * added or taken away above them, or null when the run touches them.
 */
export function mapRange(before: string, after: string, range: LineRange): LineRange | null {
    if (before === after) return range;
    const a = linesOf(before);
    const b = linesOf(after);
    const shorter = Math.min(a.length, b.length);
    let start = 0;
    while (start < shorter && a[start] === b[start]) start++;
    let end = 0;
    while (end < shorter - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    // The run is lines [start, changed) of `before` (empty for an insertion).
    const changed = a.length - end;
    const first = range.from - 1;
    const last = range.to - 1;
    if (changed <= first) {
        const delta = b.length - a.length;
        return { from: range.from + delta, to: range.to + delta };
    }
    if (start > last) return range;
    return null;
}

/**
 * Where `region`'s lines are in `text`: the run of lines equal to them that
 * starts nearest line `near`, or null when there is none (or the region is
 * only blank lines, which are anywhere).
 */
export function findRegion(text: string, region: string, near: number): LineRange | null {
    const lines = linesOf(text);
    const want = linesOf(region);
    if (!want.some((line) => line.trim())) return null;
    let best = -1;
    for (let i = 0; i + want.length <= lines.length; i++) {
        let j = 0;
        while (j < want.length && lines[i + j] === want[j]) j++;
        if (j === want.length && (best < 0 || Math.abs(i + 1 - near) < Math.abs(best + 1 - near))) best = i;
    }
    return best < 0 ? null : { from: best + 1, to: best + want.length };
}

/**
 * Where the lines `range` names in `before` went in `after`: moved by an
 * edit above or below them, or, when edits on both sides make that
 * ambiguous, found by their text nearest where they were. Null when the
 * lines themselves changed.
 */
export function followRange(before: string, after: string, range: LineRange): LineRange | null {
    return mapRange(before, after, range) ?? findRegion(after, sliceLines(before, range), range.from);
}
