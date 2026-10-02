import { AnyExtension, Editor, EditorOptions, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import { TableKit } from '@tiptap/extension-table'
import { MarkdownTable } from './extensions/table'
import { Markdown, MarkdownStorage } from 'tiptap-markdown';
import { StyleModule } from 'style-mod';

import { ExtendedCodeblock } from './extensions/codeblock';
import { ExtendedTaskItem } from './extensions/taskitem';
import { FileSystem, FileSystemOptions, type FileSystemStorage } from './extensions/filesystem';
import { ConflictNotice } from './extensions/conflict-notice';
import { ProseAI } from './extensions/prose-ai';
import type { FileVersions } from '@joinezco/codeblock';
import { styleModule } from './styles';
import { ExtendedLink } from './extensions/link';
import { LinkMenu } from './extensions/link-menu';
import { SlashCommands, SlashCommand } from './extensions/slash-commands';
import { EmojiPicker } from './extensions/emoji-picker';
import { Toolbar, ToolbarOptions } from './extensions/toolbar';
import { InlineCodeExit } from './extensions/inline-code';
import { WrapSelection } from './extensions/wrap-selection';
import { MarkdownBlockPaste } from './extensions/markdown-paste';
import { BlockActions, BlockActionsOptions } from './extensions/block-actions';
import { SelectionMenu } from './extensions/selection-menu';
import { Sidebar, SidebarOptions } from './extensions/sidebar';
import { BulletList, OrderedListStart, DashListKeymap } from './extensions/lists';
import { Paragraph } from './extensions/paragraph';
import { HeadingAnchors } from './extensions/heading-anchors';
import type { WikilinkOptions } from './extensions/wikilink';
import { LinksPanel, LinksPanelOptions } from './extensions/links-panel';
import type { FrontMatterOptions } from './extensions/front-matter';
import type { MathOptions } from './extensions/math';
import type { ImageOptions } from './extensions/image';
import { FileTree, FileTreeOptions } from './extensions/file-tree';
import { Comments } from './extensions/comments';
import { CommentMargin } from './extensions/comment-margin';
import { fileOperations, type FileOperations, type FileSearch, type VfsInterface } from '@joinezco/storage';
import { Vault, type CommentIndex, type LinkIndex, type LinkResolver, type Reactions } from '@joinezco/vault';
import type { Inference } from './inference';
import { defaultSlashCommands } from './commands';

// Override native caret blink speed on browsers that support caret-animation (Firefox 130+/Zen)
let caretBlinkInjected = false;
function injectCaretBlink() {
    if (caretBlinkInjected) return;
    caretBlinkInjected = true;
    const style = document.createElement('style');
    style.textContent = `
@supports (caret-animation: manual) {
    .ezco-mde-body {
        caret-animation: manual;
    }
    .ezco-mde-body:focus {
        animation: ezco-mde-caret-blink 530ms step-end infinite;
    }
    @keyframes ezco-mde-caret-blink {
        from, 50% { caret-color: currentColor; }
        50.1%, to { caret-color: transparent; }
    }
}`;
    document.head.appendChild(style);
}

/**
 * Mount the editor's stylesheet (the `.ezco-mde*` chrome/content styles, theme
 * variables, and the caret-blink enhancement).
 *
 * `createEditor` calls this for you. Call it yourself when you compose an editor
 * from the individually-exported extensions via `new Editor({ extensions: [...] })`,
 * so the styles + theme vars are present. Idempotent — style-mod dedupes, and the
 * caret rule is injected once. Pass a `ShadowRoot` to mount the styles inside a
 * shadow tree. No-op during SSR (no `document`).
 */
export function mountStyles(target?: Document | ShadowRoot): void {
    if (typeof document === 'undefined') return;
    StyleModule.mount(target ?? document, styleModule);
    injectCaretBlink();
}

// Shared Markdown (de)serialization config, identical across setups so a document
// round-trips the same regardless of which bundle built the editor.
import { MARKDOWN_OPTIONS } from './extensions/markdown-options';
import { syntaxExtensions } from './minimal';
export { minimalSetup } from './minimal';

/** Feature options shared by `markdownSetup` and `createEditor`. */
export type MarkdownSetupOptions = {
    /** Extra extensions appended after the defaults. */
    extensions?: AnyExtension[];
    /** Virtual-filesystem integration (file open/save, autosave). */
    fs?: FileSystemOptions;
    /** File-search toolbar. Pass options to configure, or `false` to omit it. */
    toolbar?: ToolbarOptions | false;
    /** Auto-generated document outline/sidebar — opt-in: built only when set. */
    sidebar?: SidebarOptions;
    /** Block-action indicator. Pass options to configure, or `false` to omit it. */
    blockActions?: BlockActionsOptions | false;
    /** Embedded CodeMirror code blocks. Pass `{ settings }`, or `false` to omit
     *  the (heavy, multi-hundred-KB) extension entirely — code fences then fall
     *  back to whatever code-block node is otherwise registered. */
    codeblock?: {
        settings?: Record<string, unknown>;
        /** Give an unnamed fence of a language with services (`ts`, `py`,
         *  `rs`, `go`) a hidden stand-in file beside the note, so completions
         *  and diagnostics work: a file the editor writes into the host's
         *  filesystem, so off unless the host asks. */
        standIns?: boolean;
    } | false;
    /** Slash-command menu. Pass a custom command list, or `false` to omit it. */
    slashCommands?: SlashCommand[] | false;
    /** `:`-triggered emoji picker (dataset lazy-loaded on first use). `false` omits it. */
    emoji?: boolean;
    /** Text-selection formatting menu. `false` omits it. */
    selectionMenu?: boolean;
    /** Link hover/edit popover. `false` omits it. */
    linkMenu?: boolean;
    /** Links between notes. The editor parses and renders wikilinks on its
     *  own; what they point at comes from the host's `resolver`, and the
     *  backlinks panel from its `index` (a `Vault`'s `links` from
     *  `@joinezco/vault` is both). */
    links?: LinksOptions;
    /** Front matter (a note's YAML properties). Pass `{ assignId }` to give
     *  notes opened without an `id:` one; `false` leaves front matter as text. */
    frontMatter?: FrontMatterOptions | false;
    /** `$…$` and `$$…$$` math. Pass `{ renderer }` to typeset with something
     *  other than KaTeX; `false` leaves dollars as text. */
    math?: Partial<MathOptions> | false;
    /** `[^1]` footnotes. `false` leaves them as text. */
    footnotes?: boolean;
    /** `> [!note]` callouts. `false` leaves them as plain quotes. */
    callouts?: boolean;
    /** Images. `attachments` is the vault folder pasted and dropped images are
     *  stored in (default `attachments`); `false` leaves pasting to the browser. */
    images?: Partial<ImageOptions>;
    /** Finds files by name and notes by their text, for the toolbar (the
     *  command palette) and embedded codeblocks. */
    search?: FileSearch;
    /** Creates, moves and deletes files for the toolbar and codeblocks. */
    files?: FileOperations;
    /** A model, for prose actions (rewrite, summarize, continue, an
     *  instruction): icanhaz's `inference` capability, a provider's API, a
     *  local model. Without it none is offered. */
    inference?: Inference;
    /** Every file's version log (a vault's `versions`): loads and saves go
     *  through it, a save naming the version it was made on; one made on a
     *  stale version is kept as a conflict copy. Without it, files are read
     *  and written as they are. */
    versions?: FileVersions;
    /** The vault as a tree of folders and files — opt-in: built only when set. */
    fileTree?: Omit<FileTreeOptions, 'files' | 'subscribe'>;
    /** Comment threads (the comments RFC). A note's threads are read and
     *  shown whatever is given here; `false` leaves them in the note unshown. */
    comments?: CommentsSetupOptions | false;
}

export interface CommentsSetupOptions {
    /** The handle comments are written as. Without it threads are shown,
     *  not written. */
    author?: string;
    /** Comments about the note, wherever they live (a vault's `comments`);
     *  the editor's own vault's when it made one. */
    index?: CommentIndex;
    /** Reactions and resolution, per identity (a vault's `reactions`); the
     *  editor's own vault's, as `author`, when it made one. */
    reactions?: Reactions;
    /** How threads are shown, or `false` for not at all (a host showing
     *  them its own way reads them from `editor.storage.comments`).
     *  `layout: 'float'` (the default) shows nothing beside the note: the
     *  thread whose text is clicked opens over the note's edge, by its text.
     *  `layout: 'column'` keeps every open thread in a column beside the
     *  note, level with its text (`createEditor` makes the column; `mount`
     *  puts it elsewhere). */
    margin?: { mount?: SidebarOptions['mount']; layout?: 'float' | 'column' } | false;
}

export type LinksOptions = Pick<WikilinkOptions, 'resolver' | 'open'> & {
    /** The vault's link index: backlinks, dangling links, link-keeping renames. */
    index?: LinkIndex;
    /** The links panel (shown when there is an `index`). `false` omits it. */
    panel?: Omit<LinksPanelOptions, 'index'> | false;
};

export type MarkdownEditorOptions = Partial<EditorOptions> & MarkdownSetupOptions;

export type MarkdownEditor = Editor & {
    storage: {
        markdown: MarkdownStorage;
    } & Record<string, any>;
}

/** What the editor reaches the vault through. */
interface VaultServices {
    fs?: VfsInterface;
    search?: FileSearch;
    files?: FileOperations;
    resolver?: LinkResolver;
    versions?: FileVersions;
    comments?: CommentIndex;
    reactions?: Reactions;
    /** Be told when the vault changed. */
    subscribe?: (listener: () => void) => () => void;
    /** A vault the editor made for itself, to close with the editor. */
    owned?: Vault;
}

/**
 * The host's vault services, and, for any it left out while giving a
 * filesystem, a `Vault` of the editor's own over that filesystem. The editor
 * then writes through the vault's observed filesystem, so its index follows
 * every save, and the vault follows the store's own changes too (a move made
 * by the host's link index, a file written by another program), where the
 * store can report them. A rename keeps links as the host's link index means
 * them when there is one (the vault's own rewrite would follow different rules).
 */
function vaultServices(options: MarkdownSetupOptions): VaultServices {
    const hostSubscribe = options.links?.index?.subscribe ?? options.links?.resolver?.subscribe;
    const given: VaultServices = {
        fs: options.fs?.fs,
        search: options.search,
        files: options.files,
        resolver: options.links?.resolver,
        versions: options.versions,
        comments: options.comments ? options.comments.index : undefined,
        reactions: options.comments ? options.comments.reactions : undefined,
        subscribe: hostSubscribe,
    };
    if (!given.fs || (given.search && given.files && given.resolver)) return given;
    const vault = new Vault(given.fs, { identity: options.comments ? options.comments.author : undefined });
    const index: LinkIndex | undefined = options.links?.index;
    const files = options.files ?? (index ? { ...fileOperations(vault.fs), rename: (a: string, b: string) => index.rename(a, b) } : vault.files);
    return {
        fs: vault.fs,
        search: given.search ?? vault.search,
        files,
        resolver: given.resolver ?? vault.links,
        // Versions only when the host asks: a folder given as `fs` alone gets
        // no `.vault/` of records it did not ask for.
        versions: given.versions,
        comments: given.comments ?? vault.comments,
        reactions: given.reactions ?? vault.reactions,
        subscribe: hostSubscribe ?? ((listener) => vault.subscribe(listener)),
        owned: vault,
    };
}

/** Closes the vault the editor made for itself when the editor goes. */
const ownedVault = (vault: Vault) =>
    Extension.create({
        name: 'ownedVault',
        onDestroy() {
            vault.close();
        },
    });

/** Slash commands for prose actions, offered when there is a model. */
const proseSlashCommands: SlashCommand[] = [
    {
        title: 'Ask AI',
        description: 'Tell a model what to write here',
        icon: '✦',
        command: ({ editor, range }) => editor.chain().focus().deleteRange(range).runProseAction('ask').run(),
    },
    {
        title: 'Continue writing',
        description: 'A model writes on from here',
        icon: '✦',
        command: ({ editor, range }) => editor.chain().focus().deleteRange(range).runProseAction('continue').run(),
    },
    {
        title: 'Summarize note',
        description: 'A model sums the note up here',
        icon: '✦',
        command: ({ editor, range }) => editor.chain().focus().deleteRange(range).runProseAction('summarize').run(),
    },
]

/**
 * `files` whose renames keep the open note consistent: its unsaved edits are
 * written before links are rewritten (so the rewrite reads them), and it is
 * re-read afterwards if the rename changed it, so the next save does not put
 * the old links back. The file tree, the palette and code blocks all rename
 * through this.
 */
function keepingOpenNote(files: FileOperations | undefined, open: () => FileSystemStorage | undefined): FileOperations | undefined {
    if (!files) return files;
    return {
        create: (path, content, options) => files.create(path, content, options),
        mkdir: (path) => files.mkdir(path),
        remove: (path) => files.remove(path),
        async rename(oldPath, newPath) {
            await open()?.save();
            const count = await files.rename(oldPath, newPath);
            await open()?.refresh();
            return count;
        },
    };
}

/**
 * The default extension set — every feature the editor ships with, each a
 * standalone Tiptap unit. This is the CodeMirror-`basicSetup` analog: spread it
 * into `new Editor({ extensions: markdownSetup(opts) })` for the full experience,
 * toggle pieces off (e.g. `{ codeblock: false, emoji: false }`), or ignore it
 * entirely and compose your own from the individually-exported extensions.
 * `createEditor` is a thin wrapper over this that also builds the default layout.
 *
 * The order matches Tiptap's extension-priority expectations (e.g.
 * `MarkdownBlockPaste` must precede `Markdown`); preserve it when customizing.
 */
export function markdownSetup(options: MarkdownSetupOptions = {}): AnyExtension[] {
    const { toolbar, blockActions, sidebar } = options;
    let persistence: FileSystemStorage | undefined;
    const given = vaultServices(options);
    const services = { ...given, files: keepingOpenNote(given.files, () => persistence) };
    const base = Array.isArray(options.slashCommands) ? options.slashCommands : defaultSlashCommands;
    const commands = [
        ...base,
        ...(options.inference ? proseSlashCommands : []),
    ];
    return [
        ...(given.owned ? [ownedVault(given.owned)] : []),
        ProseAI.configure({ inference: options.inference }),
        ConflictNotice,
        FileSystem.configure({
            ...options.fs,
            fs: services.fs,
            versions: services.versions,
            follow: services.subscribe,
            bind: (storage) => (persistence = storage),
        }),
        ExtendedLink.configure({}),
        ...syntaxExtensions({ ...options, links: { ...options.links, resolver: services.resolver } }),
        StarterKit.configure({
            // Our own code block (extensions/codeblock.ts), bullet list
            // (extensions/lists.ts, disambiguated dash input), paragraph
            // (survives blank-line runs across a Markdown round-trip), link
            // (extensions/link.ts, click-to-follow + inline editor), document
            // (room for front matter) and text (escaping) replace StarterKit's —
            // disable those so there are no duplicate-name clashes.
            codeBlock: false,
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
        // Real header anchors: each heading gets a slug `id` (DOM-only, via
        // decorations — never serialized), so an outline can link to `#id`.
        HeadingAnchors,
        InlineCodeExit,
        // Wrap a non-empty selection on ` (inline code) / [ (brackets).
        WrapSelection,
        // Must come before `Markdown` so our higher-priority clipboardTextParser
        // handles block-level paste content tiptap-markdown's inline parser drops.
        MarkdownBlockPaste,
        Markdown.configure(MARKDOWN_OPTIONS),
        // Embedded codeblocks soft-wrap by default; opt out (or drop the heavy
        // CodeMirror extension entirely) via `options.codeblock`.
        ...(options.codeblock !== false
            ? [ExtendedCodeblock.configure({
                settings: options.codeblock?.settings ?? {},
                standIns: options.codeblock?.standIns ?? false,
                search: services.search,
                files: services.files,
            })]
            : []),
        TaskList,
        ExtendedTaskItem.configure({ nested: true }),
        TableKit.configure({ table: false }),
        MarkdownTable.configure({ resizable: true, allowTableNodeSelection: true }),
        ...(options.slashCommands !== false
            ? [SlashCommands.configure({ commands })]
            : []),
        // Emoji picker: `:` + 2+ chars opens a searchable grid; its ~550KB dataset
        // is dynamically imported on first use (not at editor load).
        ...(options.emoji !== false ? [EmojiPicker] : []),
        // The toolbar (also the command palette) reads its fs/filepath from
        // `options.toolbar` when given, otherwise the editor's filesystem, so a
        // consumer can configure just `mount`/`className` and still get file
        // search, file management and the editor's commands.
        ...(toolbar !== false
            ? [Toolbar.configure({
                fs: toolbar?.fs ?? services.fs,
                search: toolbar?.search ?? services.search,
                files: toolbar?.files ?? services.files,
                commands: toolbar?.commands ?? (options.slashCommands !== false ? commands : []),
                filepath: toolbar?.filepath ?? options.fs?.filepath,
                mount: toolbar?.mount,
                className: toolbar?.className,
                autoHide: toolbar?.autoHide ?? false,
            })]
            : []),
        ...(blockActions !== false
            ? [BlockActions.configure({ mount: blockActions?.mount })]
            : []),
        ...(options.selectionMenu !== false ? [SelectionMenu] : []),
        ...(options.linkMenu !== false ? [LinkMenu] : []),
        // The links panel: whenever the host supplies a link index.
        ...(options.links?.index && options.links.panel !== false
            ? [LinksPanel.configure({ ...options.links.panel, index: options.links.index })]
            : []),
        // The file tree is opt-in (built only when `fileTree` is set).
        ...(options.fileTree
            ? [FileTree.configure({ ...options.fileTree, files: services.files, subscribe: services.subscribe })]
            : []),
        // Comments: the note's threads (and those written elsewhere) found and
        // highlighted, and a margin to read and write them in.
        ...(options.comments !== false
            ? [
                Comments.configure({ author: options.comments?.author, index: services.comments, reactions: services.reactions }),
                ...(options.comments?.margin !== false
                    ? [
                        CommentMargin.configure({
                            mount: options.comments?.margin?.mount,
                            layout: options.comments?.margin?.layout ?? 'float',
                            // A comment is written in this editor, in small: the
                            // same syntax and code blocks over the same files,
                            // without the chrome around the note.
                            composer: () =>
                                markdownSetup({
                                    fs: services.fs ? { fs: services.fs, autoSave: false } : undefined,
                                    search: services.search,
                                    files: services.files,
                                    links: { resolver: services.resolver, open: options.links?.open },
                                    codeblock: options.codeblock,
                                    inference: options.inference,
                                    frontMatter: false,
                                    footnotes: false,
                                    callouts: false,
                                    toolbar: false,
                                    blockActions: false,
                                    comments: false,
                                    fileTree: undefined,
                                    sidebar: undefined,
                                }),
                        }),
                    ]
                    : []),
            ]
            : []),
        // The outline is opt-in (generated only when `sidebar` is set).
        ...(sidebar
            ? [Sidebar.configure({
                mount: sidebar.mount,
                className: sidebar.className,
                title: sidebar.title,
            })]
            : []),
        ...(options.extensions || []),
    ];
}

/**
 * Create a Markdown-ready Tiptap Editor with the default extensions, the default
 * layout (a `.ezco-mde` wrapper of toolbar slot + [navbar | block-action gutter |
 * editable]), and the stylesheet mounted.
 *
 * A thin convenience wrapper over `markdownSetup` — for full control, build the
 * editor yourself: `new Editor({ extensions: markdownSetup(opts) })` (then call
 * `mountStyles()`), or compose from the individually-exported extensions.
 *
 * @param options Feature options plus any Tiptap `EditorOptions` overrides.
 * @returns An instance of Tiptap Editor.
 */
export function createEditor(options: MarkdownEditorOptions = {}): MarkdownEditor {
    const userEl = options.element as HTMLElement | undefined

    // `.ezco-mde` is a PARENT wrapper that owns the editor's default layout: a
    // (stationary) toolbar slot above a content row of [navbar | block-action
    // gutter | editable]. Chrome defaults into these slots, but any piece can be
    // relocated via its own `mount` option. Built up front so the extensions can
    // mount into the slots during editor creation. (No element → headless; we
    // skip the wrapper and keep `.ezco-mde` on the editable itself.)
    let toolbarSlot: HTMLElement | undefined
    let navHost: HTMLElement | undefined
    let gutter: HTMLElement | undefined
    let bodyHost: HTMLElement | undefined
    let commentsHost: HTMLElement | undefined
    if (userEl && typeof document !== 'undefined') {
        const make = (cls: string) => {
            const el = document.createElement('div')
            el.className = cls
            return el
        }
        const wrapper = make('ezco-mde')
        toolbarSlot = make('ezco-mde-toolbar-slot')
        const content = make('ezco-mde-content')
        navHost = make('ezco-mde-nav')
        // The gutter exists only to hold the block-action indicator: with block
        // actions off there is nothing to hold, so the column isn't built at all
        // (a built one keeps its 48px even when empty).
        if (options.blockActions !== false) gutter = make('ezco-mde-gutter')
        bodyHost = make('ezco-mde-body-host')
        // A column for comments, right of the note, when asked for: by
        // default threads float over the note's edge and take no room.
        if (options.comments !== false && options.comments?.margin !== false && options.comments?.margin?.layout === 'column') {
            commentsHost = make('ezco-mde-comments')
        }
        content.append(...[navHost, gutter, bodyHost, commentsHost].filter((el): el is HTMLElement => !!el))
        wrapper.append(toolbarSlot, content)
        userEl.appendChild(wrapper)
    }
    /** A default `mount` for a piece of chrome → its slot (only when we built
     *  the wrapper). */
    const slotMount = (el: HTMLElement | undefined) => (el ? () => el : undefined)

    // Default the chrome into the wrapper's slots (unless the consumer passed its
    // own `mount`, or opted the piece out with `false`), then build the default
    // extension set from the merged options.
    const setupOptions: MarkdownSetupOptions = {
        ...options,
        toolbar: options.toolbar === false
            ? false
            : { ...options.toolbar, mount: options.toolbar?.mount ?? slotMount(toolbarSlot) },
        blockActions: options.blockActions === false
            ? false
            : { ...options.blockActions, mount: options.blockActions?.mount ?? slotMount(gutter) },
        sidebar: options.sidebar
            ? { ...options.sidebar, mount: options.sidebar.mount ?? slotMount(navHost) }
            : undefined,
        fileTree: options.fileTree
            ? { ...options.fileTree, mount: options.fileTree.mount ?? slotMount(navHost) }
            : undefined,
        comments: options.comments === false
            ? false
            : {
                ...options.comments,
                margin: options.comments?.margin === false
                    ? false
                    : { ...options.comments?.margin, mount: options.comments?.margin?.mount ?? slotMount(commentsHost) },
            },
    }

    // `element` and `extensions` are handled explicitly (extras are folded into
    // `setupOptions` for `markdownSetup`), so keep them out of the spread that
    // applies the consumer's remaining Tiptap options.
    const { element: _ignoredElement, extensions: _extraExtensions, ...restOptions } = options

    const editor = new Editor({
        extensions: markdownSetup(setupOptions),
        editorProps: {
            attributes: options.editorProps?.attributes || {},
            ...(options.editorProps || {}),
        },
        content: options.content || '',
        onUpdate: options.onUpdate || (() => { }),
        autofocus: options.autofocus,
        editable: options.editable,
        injectCSS: options.injectCSS,
        ...restOptions,
        // Mount ProseMirror into the wrapper's body host (or the consumer's
        // element if no wrapper was built). With neither (headless), leave
        // `element` UNSET so Tiptap creates its own detached view — explicitly
        // passing `element: undefined` would instead leave the view unmounted.
        ...((bodyHost ?? userEl) ? { element: bodyHost ?? userEl } : {}),
    });
    // The editable carries `.ezco-mde-body` (the content styles). With no
    // wrapper (headless), it also keeps `.ezco-mde` so the theme vars resolve.
    editor.view.dom.classList.add('ezco-mde-body');
    if (!bodyHost) editor.view.dom.classList.add('ezco-mde');

    mountStyles();
    return editor as MarkdownEditor;
}

// ── Individual extensions ───────────────────────────────────────────────────
// Every feature is a standalone Tiptap extension/node/mark. Export them so a
// consumer can compose a custom editor (`new Editor({ extensions: [...] })`)
// instead of taking the whole `markdownSetup`/`createEditor` bundle — import only
// what you use and the rest tree-shakes away (`sideEffects: false`). The setup
// functions above use these same units.
export { FileSystem } from './extensions/filesystem';
export { ConflictNotice } from './extensions/conflict-notice';
export { ProseAI, type ProseAIOptions } from './extensions/prose-ai';
export { openDocuments, type OpenDocuments, type OpenDocument, type TextEdit, type TextRange, type TextPosition, type EditResult } from './extensions/edits';
export type { FileSystemOptions, FileSystemStorage, FileEvent, LoadOptions } from './extensions/filesystem';
export { ExtendedLink } from './extensions/link';
export { Wikilink, wikilinkLabel } from './extensions/wikilink';
export { LinksPanel } from './extensions/links-panel';
export { FrontMatter, FrontMatterDocument, documentId } from './extensions/front-matter';
export type { FrontMatterOptions } from './extensions/front-matter';
export { Mathematics, MathInline, MathBlock, katexRenderer } from './extensions/math';
export type { MathOptions, MathRenderer } from './extensions/math';
export { FootnoteReference, FootnoteDefinition } from './extensions/footnote';
export { Span, parseSpanAttributes, formatSpanAttributes, type SpanAttributes } from './extensions/span';
export { Comments, commentsKey, commentAt, authorOf, commentFileName, commentsFolderFor, RESOLVED, DELETED_BODY } from './extensions/comments';
export type { CommentsOptions, CommentsStorage, CommentTarget, CommentInfo, WebAnnotation } from './extensions/comments';
export { CommentMargin, type CommentMarginOptions } from './extensions/comment-margin';
export { Callout, CalloutTitle, calloutType } from './extensions/callout';
export { SourceView } from './extensions/source-view';
export { MarkdownText } from './extensions/text';
export { Image, attachImages } from './extensions/image';
export type { ImageOptions } from './extensions/image';
export { Embed } from './extensions/embed';
export { FileTree } from './extensions/file-tree';
export type { FileTreeOptions } from './extensions/file-tree';
export type { LinksPanelOptions } from './extensions/links-panel';
export type { WikilinkOptions, WikilinkStorage } from './extensions/wikilink';
export { findFragment, revealFragment } from './extensions/fragment';
export { ExtendedCodeblock, codeblockRegistry } from './extensions/codeblock';
export type { ExtendedCodeblockOptions } from './extensions/codeblock';
export { ExtendedTaskItem } from './extensions/taskitem';
export type { ExtendedTaskItemOptions } from './extensions/taskitem';
export { Paragraph } from './extensions/paragraph';
export { BulletList, OrderedListStart, DashListKeymap } from './extensions/lists';
export { HeadingAnchors } from './extensions/heading-anchors';
export { InlineCodeExit } from './extensions/inline-code';
export { WrapSelection } from './extensions/wrap-selection';
export { MarkdownBlockPaste } from './extensions/markdown-paste';
export { SlashCommands } from './extensions/slash-commands';
export type { SlashCommand, SlashCommandsOptions } from './extensions/slash-commands';
export { EmojiPicker, prefetchEmojiData } from './extensions/emoji-picker';
export type { EmojiPickerOptions } from './extensions/emoji-picker';
export { SelectionMenu } from './extensions/selection-menu';
export { LinkMenu } from './extensions/link-menu';
export { Toolbar } from './extensions/toolbar';
export type { ToolbarOptions, ToolbarMount } from './extensions/toolbar';
export { Sidebar } from './extensions/sidebar';
export type { SidebarOptions, SidebarMount } from './extensions/sidebar';
export { BlockActions } from './extensions/block-actions';
export type { BlockActionsOptions, BlockActionsMount } from './extensions/block-actions';
export { defaultSlashCommands } from './commands';
export { slugify, computeHeadingSlugs } from './extensions/slug-utils';
export type { HeadingSlug } from './extensions/slug-utils';
