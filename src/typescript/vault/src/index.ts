export { Vault, type VaultOptions, type VaultLinks } from './vault.js'
export * from './links/types.js'
export {
    parseWikilink,
    formatWikilink,
    matchWikilinkAt,
    isExternalTarget,
    decodeDestination,
    encodeDestination,
    type Wikilink,
    type ScannedLink,
    type LinkKind,
} from './links/syntax.js'
export { parseNote, scanLinks, rewriteLinks, type ParsedNote, type Heading, type LineRange } from './parse.js'
export { newNotePath } from './links/resolve.js'
export { NOTE_EXTENSIONS, isNote, newNoteId, frontMatterOf, noteIdOf } from './note.js'
export { titleOf } from './search.js'
export { referencesIn, referencesOf, formatReference, spliceReference, type Reference, type CommentIndex, type CommentRef } from './comments.js'
export { referenceKey, type Reaction, type ReactionTarget, type Reactions } from './reactions.js'
export { findTextFragment, formatTextFragment, parseTextFragment, textFragmentFor, type TextFragment, type TextMatch } from './quote.js'
