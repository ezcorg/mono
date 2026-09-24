export * from './vfs'
export * from './path'
export { memoryVfs } from './memory'
export * from './links/types'
export {
    parseWikilink,
    formatWikilink,
    matchWikilinkAt,
    scanLinks,
    rewriteLinks,
    isExternalTarget,
    decodeDestination,
    encodeDestination,
    type Wikilink,
    type ScannedLink,
    type LinkKind,
} from './links/syntax'
export {
    Catalog,
    resolveLink,
    resolveWikilink,
    resolveMarkdownLink,
    newNotePath,
    wikilinkTextFor,
    markdownDestinationFor,
} from './links/resolve'
export { LinkGraph } from './links/graph'
export { SearchIndex, snippetOf, titleOf, type FileSearch, type SearchHit, type SearchOptions } from './search'
export { fileOperations, type FileOperations, type CreateOptions } from './files'
export { Vault, type VaultOptions, type VaultLinks } from './vault'
export { newNoteId, frontMatterOf, noteIdOf } from './id'
