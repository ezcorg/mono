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
export { fileOperations, pathTaken, type FileOperations, type CreateOptions } from './files.js'
export { Vault, type VaultOptions, type VaultLinks } from './vault.js'
export { newNoteId, frontMatterOf, noteIdOf } from './id.js'
export { referencesIn, formatReference, spliceReference, type Reference, type CommentIndex, type CommentRef } from './comments.js'
export {
    ReactionStore,
    referenceKey,
    reactionTime,
    IDENTITY,
    type Reaction,
    type ReactionTarget,
    type Reactions,
    type ReactionsOptions,
} from './reactions.js'
export { findTextFragment, formatTextFragment, parseTextFragment, textFragmentFor, type TextFragment, type TextMatch } from './quote.js'
export { VersionLog, conflictCopyPath, type FileVersion, type PutResult, type Signer, type VersionLogOptions } from './versions.js'
export { serveVfs, remoteVfs, vfsPort, DISCONNECTED, type RemoteVfs, type PortLike } from './remote.js'
export { takeSnapshot, restoreSnapshot, type SnapshotNode, type TakeSnapshotOptions } from './snapshot.js'
export {
    PROSE_ACTIONS,
    proseAction,
    completeText,
    type Inference,
    type CompletionRequest,
    type CompletionEvent,
    type ChatMessage,
    type ProseAction,
    type ProseContext,
} from './ai.js'
