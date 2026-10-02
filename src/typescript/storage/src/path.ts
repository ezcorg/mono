/**
 * Vault paths: `/`-separated, relative to the vault root, with no leading
 * slash (`notes/plan.md`). The VFS accepts a leading `/` as the root too;
 * everything this package returns is in the bare form.
 */

/** `path` with `.`, `..`, empty segments and any leading `/` or `./` removed.
 *  A `..` that would climb above the root is dropped. */
export function normalizePath(path: string): string {
    const out: string[] = []
    for (const seg of path.split('/')) {
        if (seg === '' || seg === '.') continue
        if (seg === '..') {
            out.pop()
            continue
        }
        out.push(seg)
    }
    return out.join('/')
}

/** The directory part of `path` (`''` for a file at the root). */
export function dirname(path: string): string {
    const clean = normalizePath(path)
    const i = clean.lastIndexOf('/')
    return i < 0 ? '' : clean.slice(0, i)
}

/** The last segment of `path`. */
export function basename(path: string): string {
    const clean = normalizePath(path)
    return clean.slice(clean.lastIndexOf('/') + 1)
}

/** The extension of `path`'s last segment, lower-cased, without the dot
 *  (`''` when there is none; a leading dot is a hidden file, not an extension). */
export function extname(path: string): string {
    const base = basename(path)
    const i = base.lastIndexOf('.')
    return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/** `base` joined with `rest`, normalized. */
export function joinPath(base: string, ...rest: string[]): string {
    return normalizePath([base, ...rest].join('/'))
}

/**
 * `target` as a path relative to the directory `fromDir` (`../b/c.md`).
 * Both are vault paths.
 */
export function relativePath(fromDir: string, target: string): string {
    const base = normalizePath(fromDir).split('/').filter(Boolean)
    const tgt = normalizePath(target).split('/').filter(Boolean)
    let common = 0
    while (common < base.length && common < tgt.length && base[common] === tgt[common]) common++
    return [...Array(base.length - common).fill('..'), ...tgt.slice(common)].join('/')
}

/** True for paths inside a dot-directory or naming a dot-file (vault state
 *  such as `.vault/`, `.git/`, `.obsidian/`), which no index looks into. */
export function isHidden(path: string): boolean {
    return normalizePath(path).split('/').some((seg) => seg.startsWith('.'))
}
