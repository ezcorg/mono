import { VfsInterface } from "../types";
import MiniSearch, { Options, SearchResult } from 'minisearch';
import { Vfs } from "./fs";

export const validFields = ['path', 'basename', 'dirname', 'extension'] as const
export type IndexFields = typeof validFields[number][]
export const defaultFields = ['path', 'basename', 'dirname', 'extension'] as IndexFields
/** Directory (relative to the VFS root) where the index and other editor state live. */
export const INDEX_DIR = '.codeblock'
export const defaultFilter = (path: string) => {
    if (path.endsWith('.crswap')) return false
    // Never index our own storage (the index file itself, etc.).
    const rel = path.startsWith('/') ? path.slice(1) : path
    return rel !== INDEX_DIR && !rel.startsWith(INDEX_DIR + '/')
}
export type SearchIndexOptions = Options & {
    filter?: (path: string) => boolean
}

export type SearchHighlights = {
    fields: Record<string, [number, number][]>
}
export type HighlightedSearch = SearchResult & { highlights: SearchHighlights }

export class SearchIndex {

    /// The VFS path this index was loaded from / saved to, if known.
    savePath?: string;

    constructor(public index: MiniSearch) { }

    add(path: string) {
        if (!this.index.has(path)) {
            this.index.add({ path });
        }
    }

    search(...params: Parameters<MiniSearch['search']>): HighlightedSearch[] {
        const results = this.index.search(...params);
        const highlights = this.highlight(results)

        return results.map((result, i) => ({
            ...result,
            highlights: highlights[i]
        }))
    }

    /**
     *
     * @param results
     * @returns ranges of found term matched by each field
     */
    highlight(_results: SearchResult[]): SearchHighlights[] {
        // TODO: implement
        return [];
    }

    async save(fs: VfsInterface, path: string) {
        try {
            // Extract directory from the file path and create it
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) {
                await fs.mkdir(dir, { recursive: true });
            }
            await fs.writeFile(path, JSON.stringify(this.index));
        }
        catch (error) {
            console.error('Failed to save search index:', error);
        }
        finally {
            return this;
        }
    }

    static from(data: string, options: Options) {
        const index = MiniSearch.loadJSON(data, options)
        return new SearchIndex(index)
    }

    /**
     * Load the index stored at `path`, or build (and persist) a fresh one from
     * the filesystem. Never rejects: a missing, unreadable, or corrupt index
     * file falls back to a rebuild, and a failed rebuild falls back to an empty
     * in-memory index — either way the caller gets something it can search and
     * add to, and `savePath` is set so later edits are persisted (overwriting a
     * corrupt file).
     */
    static async get(fs: VfsInterface, path: string, fields: IndexFields = defaultFields): Promise<SearchIndex> {
        const opts: Options = { fields, idField: 'path' };

        // 1. Existing index on disk?
        let data: string | null = null
        try {
            data = await fs.exists(path) ? await fs.readFile(path) : null
        } catch (err) {
            console.warn(`Search index at ${path} is unreadable, rebuilding:`, err)
        }
        if (data) {
            try {
                const index = SearchIndex.from(data, opts)
                index.savePath = path
                return index
            } catch (err) {
                console.warn(`Search index at ${path} is corrupt, rebuilding:`, err)
            }
        }

        // 2. Build from the filesystem and persist (save() swallows its own errors).
        try {
            const index = await SearchIndex.build(fs, opts)
            index.savePath = path
            return index.save(fs, path)
        } catch (err) {
            console.warn('Search index build failed, starting empty:', err);
            const index = new SearchIndex(new MiniSearch(opts));
            index.savePath = path;
            return index;
        }
    }

    static async build(fs: VfsInterface, { filter = defaultFilter, ...rest }: SearchIndexOptions) {
        const index = new MiniSearch({ ...rest })

        for await (const path of Vfs.walk(fs, '/')) {
            if (!filter(path)) {
                continue;
            }

            if (!index.has(path.slice(1))) {
                index.add({ path: path.slice(1) })
            }
        }
        return new SearchIndex(index)
    }
}
