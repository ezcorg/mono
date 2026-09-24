export * from './vfs.js'
export * from './path.js'
export { memoryVfs } from './memory.js'
export * from './links/types.js'
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
} from './links/syntax.js'
export {
    Catalog,
    resolveLink,
    resolveWikilink,
    resolveMarkdownLink,
    newNotePath,
    wikilinkTextFor,
    markdownDestinationFor,
} from './links/resolve.js'
export { LinkGraph } from './links/graph.js'
export { SearchIndex, snippetOf, titleOf, type FileSearch, type SearchHit, type SearchOptions } from './search.js'
export { fileOperations, type FileOperations, type CreateOptions } from './files.js'
export { Vault, type VaultOptions, type VaultLinks } from './vault.js'
export { newNoteId, frontMatterOf, noteIdOf } from './id.js'
export { serveVfs, remoteVfs, vfsPort, DISCONNECTED, type RemoteVfs, type PortLike } from './remote.js'
export { takeSnapshot, restoreSnapshot, type SnapshotNode, type TakeSnapshotOptions } from './snapshot.js'
