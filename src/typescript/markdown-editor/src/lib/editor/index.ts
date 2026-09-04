import { AnyExtension, Editor, EditorOptions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import { TableKit } from '@tiptap/extension-table'
import { Markdown, MarkdownStorage } from 'tiptap-markdown';
import { StyleModule } from 'style-mod';

import { ExtendedCodeblock } from './extensions/codeblock';
import { ExtendedTaskItem } from './extensions/taskitem';
import { FileSystem, FileSystemOptions } from './extensions/filesystem';
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
const MARKDOWN_OPTIONS = {
    html: false,
    tightLists: true,
    tightListClass: 'tight',
    bulletListMarker: '*',
    linkify: true,
    breaks: true,
    transformPastedText: true,
    transformCopiedText: true,
} as const;

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
    codeblock?: { settings?: Record<string, unknown> } | false;
    /** Slash-command menu. Pass a custom command list, or `false` to omit it. */
    slashCommands?: SlashCommand[] | false;
    /** `:`-triggered emoji picker (dataset lazy-loaded on first use). `false` omits it. */
    emoji?: boolean;
    /** Text-selection formatting menu. `false` omits it. */
    selectionMenu?: boolean;
    /** Link hover/edit popover. `false` omits it. */
    linkMenu?: boolean;
}

export type MarkdownEditorOptions = Partial<EditorOptions> & MarkdownSetupOptions;

export type MarkdownEditor = Editor & {
    storage: {
        markdown: MarkdownStorage;
    } & Record<string, any>;
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
    return [
        FileSystem.configure(options.fs || {}),
        ExtendedLink.configure({}),
        StarterKit.configure({
            // Our own code block (extensions/codeblock.ts), bullet list
            // (extensions/lists.ts, disambiguated dash input), paragraph
            // (survives blank-line runs across a Markdown round-trip), and link
            // (extensions/link.ts, click-to-follow + inline editor) replace
            // StarterKit's — disable those so there are no duplicate-name clashes.
            codeBlock: false,
            bulletList: false,
            paragraph: false,
            link: false,
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
            ? [ExtendedCodeblock.configure({ settings: options.codeblock?.settings ?? {} })]
            : []),
        TaskList,
        ExtendedTaskItem.configure({ nested: true }),
        TableKit.configure({
            table: { resizable: true, allowTableNodeSelection: true },
        }),
        ...(options.slashCommands !== false
            ? [SlashCommands.configure({
                commands: Array.isArray(options.slashCommands) ? options.slashCommands : defaultSlashCommands,
            })]
            : []),
        // Emoji picker: `:` + 2+ chars opens a searchable grid; its ~550KB dataset
        // is dynamically imported on first use (not at editor load).
        ...(options.emoji !== false ? [EmojiPicker] : []),
        // The toolbar reads its fs/filepath from `options.toolbar` when given,
        // otherwise falls back to the editor's filesystem so a consumer can
        // configure just `mount`/`className` and still get a working file search.
        ...(toolbar !== false
            ? [Toolbar.configure({
                fs: toolbar?.fs ?? options.fs?.fs,
                index: toolbar?.index,
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
 * A lean, text-only extension set: the markdown document model + I/O, basic
 * marks, links, lists, tasks, and tables — but none of the heavier chrome (no
 * CodeMirror code blocks, file search, outline, slash/emoji/selection menus, or
 * block actions). Code fences fall back to StarterKit's lightweight code block.
 * The CodeMirror-`minimalSetup` analog; add features back by importing the
 * individual extensions you want.
 */
export function minimalSetup(options: { extensions?: AnyExtension[] } = {}): AnyExtension[] {
    return [
        ExtendedLink.configure({}),
        StarterKit.configure({
            // Keep StarterKit's lightweight code block here (no CodeMirror).
            bulletList: false,
            paragraph: false,
            link: false,
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
        TableKit.configure({
            table: { resizable: true, allowTableNodeSelection: true },
        }),
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
        content.append(...[navHost, gutter, bodyHost].filter((el): el is HTMLElement => !!el))
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
export type { FileSystemOptions } from './extensions/filesystem';
export { ExtendedLink } from './extensions/link';
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
