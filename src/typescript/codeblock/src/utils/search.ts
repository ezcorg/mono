import { Fs } from "../types";
import MiniSearch, { Options, SearchResult } from 'minisearch';
import { CodeblockFS } from "./fs";

export const validFields = ['path'] as const
export type IndexFields = typeof validFields[number][]
export const defaultFields = ['path'] as IndexFields
export const defaultFilter = (path: string) => {
    return !path.endsWith('.crswap')
}
export type SearchIndexOptions = Options & {
    filter?: (path: string) => boolean
}

export type SearchHighlights = {
    fields: Record<string, [number, number][]>
}
export type HighlightedSearch = SearchResult & { highlights: SearchHighlights }

export class SearchIndex {

    constructor(public index: MiniSearch) { }

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
    highlight(results: SearchResult[]): SearchHighlights {
        const highlights: SearchHighlights = { fields: {} };

        for (const result of results) {
            for (const term of result.terms) {
                const regexp = new RegExp(term, 'gi');

                if (!result.match[term]) continue;

                for (const field of result.match[term]) {
                    const value = result[field];
                    if (typeof value !== 'string') continue;

                    let match;
                    while ((match = regexp.exec(value)) !== null) {
                        if (!highlights.fields[field]) {
                            highlights.fields[field] = [];
                        }
                        highlights.fields[field].push([match.index, match.index + match[0].length]);
                    }
                }
            }
        }

        return highlights;
    }

    async save(fs: Fs, path: string) {
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

    static from(fs: string, fields: IndexFields) {
        const index = MiniSearch.loadJSON(fs, { fields, idField: 'path' })
        return new SearchIndex(index)
    }

    static async get(fs: Fs, path: string, fields: IndexFields = defaultFields): Promise<SearchIndex> {
        const index = await fs.exists(path) ? await fs.readFile(path) : null
        // const index = null;
        return index ?
            SearchIndex.from(index, fields) :
            SearchIndex.build(fs, { fields, idField: 'path' }).then(index => index.save(fs, path))
    }

    static async build(fs: Fs, { filter = defaultFilter, ...rest }: SearchIndexOptions) {
        const index = new MiniSearch({ ...rest })

        for await (const path of CodeblockFS.walk(fs, '/')) {
            console.log('building search index: ', path);
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