import { VfsInterface } from "../types";
import MiniSearch, { Options, SearchResult } from 'minisearch';
import { Vfs } from "./fs";
import { basename, dirname, extname } from "path-browserify";

export const validFields = ['path', 'basename', 'dirname', 'extension'] as const;
export type IndexFields = typeof validFields[number][];
export const defaultFields: IndexFields = ['path', 'basename'];
export const defaultFilter = (path: string) => !path.endsWith('.crswap');

export type SearchIndexOptions = Options & {
    filter?: (path: string) => boolean
}

export type SearchHighlights = {
    fields: Record<string, [number, number][]>;
};
export type HighlightedSearch = SearchResult & { highlights: SearchHighlights };

function parseQuery(query: string): { type: "path" | "extension" | "fuzzy", query: string } {
    if (query.startsWith("./") || query.startsWith("../") || query.endsWith("/")) {
        return { type: "path", query };
    }
    if (query.startsWith(".")) {
        return { type: "extension", query: query.slice(1) };
    }
    return { type: "fuzzy", query };
}

export class SearchIndex {
    private dirMap: Map<string, string[]>; // dirname -> children

    constructor(public index: MiniSearch, dirMap?: Map<string, string[]>) {
        this.dirMap = dirMap ?? new Map();
    }

    search(rawQuery: string): HighlightedSearch[] {
        const parsed = parseQuery(rawQuery);

        switch (parsed.type) {
            case "path":
                return this.directoryListing(parsed.query);
            case "extension":
                return this.searchExtension(parsed.query);
            case "fuzzy":
            default:
                return this.fuzzySearch(parsed.query);
        }
    }

    private fuzzySearch(query: string): HighlightedSearch[] {
        const results = this.index.search(query, { prefix: true }) as (SearchResult & { path?: string })[];
        const highlights = this.highlight(results);

        const withHighlights: HighlightedSearch[] = results.map((r, i) => ({
            ...r,
            highlights: highlights[i]
        }));

        // Custom ranking heuristics
        return withHighlights.sort((a, b) => {
            const aPath = a.path ?? a.id;
            const bPath = b.path ?? b.id;

            if (typeof aPath === "string" && typeof bPath === "string") {
                if (aPath.length !== bPath.length) return aPath.length - bPath.length;
                const aBase = basename(aPath);
                const bBase = basename(bPath);
                const aMatch = aBase.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
                const bMatch = bBase.toLowerCase().includes(query.toLowerCase()) ? 1 : 0;
                return bMatch - aMatch;
            }
            return 0;
        });
    }

    private directoryListing(query: string): HighlightedSearch[] {
        const normalized = query.endsWith("/") ? query.slice(0, -1) : query;
        const entries = this.dirMap.get(normalized) ?? [];

        return entries.map(path => ({
            id: path,
            path,
            score: 1,
            terms: [],
            queryTerms: [],
            match: {},
            highlights: { fields: {} }
        }));
    }

    private searchExtension(ext: string): HighlightedSearch[] {
        const results = this.index.search(ext, { fields: ["extension"] }) as (SearchResult & { path?: string })[];
        return results.map(r => ({
            ...r,
            highlights: { fields: {} }
        }));
    }

    /**
     * Compute highlights (stub for now, can be expanded)
     */
    private highlight(results: (SearchResult & { path?: string })[]): SearchHighlights[] {
        return results.map(() => ({ fields: {} }));
    }

    async save(fs: VfsInterface, path: string) {
        try {
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) await fs.mkdir(dir, { recursive: true });

            await fs.writeFile(path, JSON.stringify({
                index: this.index.toJSON(),
                dirMap: Array.from(this.dirMap.entries()),
            }));
        } catch (error) {
            console.error('Failed to save search index:', error);
        } finally {
            return this;
        }
    }

    /**
     * Add a single file path to the index + directory map
     */
    addPath(filePath: string) {
        const cleanPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
        if (this.index.has(cleanPath)) return;

        const doc = {
            id: cleanPath,
            path: cleanPath,
            basename: basename(cleanPath),
            dirname: dirname(cleanPath),
            extension: extname(cleanPath),
        };

        this.index.add(doc);

        // Update directory map
        const parent = doc.dirname === '.' ? '' : doc.dirname;
        if (!this.dirMap.has(parent)) this.dirMap.set(parent, []);
        this.dirMap.get(parent)!.push(cleanPath);
    }

    /**
     * Remove a single file path from the index + directory map
     */
    removePath(filePath: string) {
        const cleanPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
        if (!this.index.has(cleanPath)) return;

        this.index.discard(cleanPath);

        // Update directory map
        const parent = dirname(cleanPath) === '.' ? '' : dirname(cleanPath);
        const children = this.dirMap.get(parent);
        if (children) {
            this.dirMap.set(parent, children.filter(c => c !== cleanPath));
            if (this.dirMap.get(parent)!.length === 0) {
                this.dirMap.delete(parent); // prune empty dirs
            }
        }
    }

    static from(json: string, fields: IndexFields) {
        const { index, dirMap } = JSON.parse(json);
        const mini = MiniSearch.loadJS(index, { fields, idField: 'path' });
        return new SearchIndex(mini, new Map(dirMap));
    }

    static async get(fs: VfsInterface, path: string, fields: IndexFields = defaultFields): Promise<SearchIndex> {
        const index = await fs.exists(path) ? await fs.readFile(path) : null;
        return index ?
            SearchIndex.from(index, fields) :
            SearchIndex.build(fs, { fields, idField: 'path' }).then(idx => idx.save(fs, path));
    }

    static async build(fs: VfsInterface, { filter = defaultFilter, ...rest }: SearchIndexOptions) {
        const index = new MiniSearch({ ...rest });
        const dirMap = new Map<string, string[]>();
        const result = new SearchIndex(index, dirMap);

        for await (const path of Vfs.walk(fs, '/')) {
            if (!filter(path)) continue;
            result.addPath(path);
        }

        return result;
    }
}
