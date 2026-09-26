/**
 * The syntax every editor built here shares, and the lean setup made of it:
 * the note's editor (`markdownSetup`) adds its chrome on top, a comment's
 * composer takes it as it is. Kept apart from the entry point so a piece of
 * chrome can build a small editor without importing the whole.
 */
import { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Document from '@tiptap/extension-document';
import TaskList from '@tiptap/extension-task-list';
import { TableKit } from '@tiptap/extension-table'
import { MarkdownTable } from './extensions/table'
import { Markdown } from 'tiptap-markdown';
import { ExtendedLink } from './extensions/link';
import { InlineCodeExit } from './extensions/inline-code';
import { WrapSelection } from './extensions/wrap-selection';
import { MarkdownBlockPaste } from './extensions/markdown-paste';
import { BulletList, OrderedListStart, DashListKeymap } from './extensions/lists';
import { Paragraph } from './extensions/paragraph';
import { HeadingAnchors } from './extensions/heading-anchors';
import { Wikilink, WikilinkOptions } from './extensions/wikilink';
import { FrontMatter, FrontMatterDocument, FrontMatterOptions } from './extensions/front-matter';
import { Mathematics, MathOptions } from './extensions/math';
import { FootnoteReference, FootnoteDefinition } from './extensions/footnote';
import { Callout, CalloutTitle } from './extensions/callout';
import { SourceView } from './extensions/source-view';
import { Image, ImageOptions } from './extensions/image';
import { Embed } from './extensions/embed';
import { ExtendedTaskItem } from './extensions/taskitem';
import { MarkdownText } from './extensions/text';
import { Span } from './extensions/span';
import { CommentThread } from './extensions/comments';
import { MARKDOWN_OPTIONS } from './extensions/markdown-options';

/** The syntax options both setups take. */
export interface SyntaxOptions {
    links?: Pick<WikilinkOptions, 'resolver' | 'open'>;
    frontMatter?: FrontMatterOptions | false;
    math?: Partial<MathOptions> | false;
    footnotes?: boolean;
    callouts?: boolean;
    images?: Partial<ImageOptions>;
}

/** The document and its syntax beyond CommonMark: the nodes both setups share. */
export function syntaxExtensions(options: SyntaxOptions): AnyExtension[] {
    return [
        // The document admits front matter before its blocks; the text node
        // escapes what would otherwise read back as syntax.
        options.frontMatter !== false ? FrontMatterDocument : Document,
        MarkdownText,
        Wikilink.configure({ resolver: options.links?.resolver, open: options.links?.open }),
        Embed,
        Image.configure(options.images ?? {}),
        ...(options.frontMatter !== false ? [FrontMatter.configure(options.frontMatter ?? {})] : []),
        ...(options.math !== false ? [Mathematics.configure(options.math ?? {})] : []),
        ...(options.footnotes !== false ? [FootnoteReference, FootnoteDefinition] : []),
        ...(options.callouts !== false ? [CalloutTitle, Callout] : []),
        // Bracketed spans (a comment's pin) and comment threads round-trip in
        // every editor, whether or not it shows comments.
        Span,
        CommentThread,
        // Front matter and math show rendered until the caret is in them.
        SourceView,
    ];
}

/**
 * A lean, text-only extension set: the markdown document model + I/O, basic
 * marks, links, lists, tasks, and tables — but none of the heavier chrome (no
 * CodeMirror code blocks, file search, outline, slash/emoji/selection menus, or
 * block actions). Code fences fall back to StarterKit's lightweight code block.
 * The CodeMirror-`minimalSetup` analog; add features back by importing the
 * individual extensions you want.
 */
export function minimalSetup(
    options: { extensions?: AnyExtension[] } & SyntaxOptions = {},
): AnyExtension[] {
    return [
        ExtendedLink.configure({}),
        ...syntaxExtensions(options),
        StarterKit.configure({
            // Keep StarterKit's lightweight code block here (no CodeMirror).
            bulletList: false,
            paragraph: false,
            link: false,
            document: false,
            text: false,
        }),
        Paragraph,
        BulletList,
        OrderedListStart,
        DashListKeymap,
        HeadingAnchors,
        InlineCodeExit,
        WrapSelection,
        MarkdownBlockPaste,
        Markdown.configure(MARKDOWN_OPTIONS),
        TaskList,
        ExtendedTaskItem.configure({ nested: true }),
        TableKit.configure({ table: false }),
        MarkdownTable.configure({ resizable: true, allowTableNodeSelection: true }),
        ...(options.extensions || []),
    ];
}

