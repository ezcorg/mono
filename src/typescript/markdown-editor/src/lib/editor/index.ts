import { Editor, EditorOptions, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import { TableKit } from '@tiptap/extension-table'
import { Markdown, MarkdownStorage } from 'tiptap-markdown';
import { ExtendedCodeblock } from './extensions/codeblock';
import { ExtendedTaskItem } from './extensions/taskitem';
import { FileSystem, FileSystemOptions } from './extensions/filesystem';
import { styleModule } from './styles';

import { ExtendedLink } from './extensions/link';
import { LinkMenu } from './extensions/link-menu';
import { SlashCommands } from './extensions/slash-commands';
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
import { StyleModule } from 'style-mod';

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

export type MarkdownEditorOptions = Partial<EditorOptions> & {
    extensions?: Extension[];
    fs?: FileSystemOptions;
    toolbar?: ToolbarOptions;
    /** Auto-generated document outline/sidebar (mounts left of the editor by default). */
    sidebar?: SidebarOptions;
    /** Block-action indicator placement (e.g. a dedicated column via `mount`). */
    blockActions?: BlockActionsOptions;
    /** Defaults for embedded codeblocks (e.g. `{ settings: { lineWrap: false } }`). */
    codeblock?: { settings?: Record<string, unknown> };
}

export type MarkdownEditor = Editor & {
    storage: {
        markdown: MarkdownStorage;
    } & Record<string, any>;
}

/**
 * Create a Markdown-ready Tiptap Editor with default extensions and options.
 * 
 * @param options Optional overrides for the Tiptap Editor options.
 * @returns An instance of Tiptap Editor.
 */
export function createEditor(options: MarkdownEditorOptions = {}): MarkdownEditor {
    const userEl = options.element as HTMLElement | undefined

    // `.ezco-mde` is now a PARENT wrapper that owns the editor's default layout:
    // a (stationary) toolbar slot above a content row of [navbar | block-action
    // gutter | editable]. Chrome defaults into these slots, but any piece can be
    // relocated via its own `mount` option. Built up front so the extensions
    // can mount into the slots during editor creation. (No element → headless;
    // we skip the wrapper and keep `.ezco-mde` on the editable itself.)
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
        gutter = make('ezco-mde-gutter')
        bodyHost = make('ezco-mde-body-host')
        content.append(navHost, gutter, bodyHost)
        wrapper.append(toolbarSlot, content)
        userEl.appendChild(wrapper)
    }
    /** A default `mount` for a piece of chrome → its slot (only when we built
     *  the wrapper). */
    const slotMount = (el: HTMLElement | undefined) => (el ? () => el : undefined)

    // `element` and `extensions` are handled explicitly below, so keep them out
    // of the spread that applies the consumer's remaining options.
    const { element: _ignoredElement, extensions: _extraExtensions, ...restOptions } = options

    const editor = new Editor({
        extensions: [
            FileSystem.configure(options.fs || {}),
            ExtendedLink.configure({}),
            StarterKit.configure({
                codeBlock: false,
                // Disable StarterKit's bulletList so we can swap in our own
                // (extensions/lists.ts) with disambiguated dash input — a
                // lone "- " stays plain text until it's clear it isn't the
                // start of a task ("- [ ]"), so dash lists, star lists, and
                // task lists can all be typed from the keyboard.
                bulletList: false,
                // Swap StarterKit's paragraph for ours (extensions/paragraph.ts)
                // so runs of empty paragraphs (deliberate vertical spacing)
                // survive a Markdown save+reload instead of collapsing.
                paragraph: false,
                // StarterKit v3 bundles Link; disable it so our ExtendedLink
                // (custom click-to-follow + inline editor) is the only link
                // extension (avoids the "Duplicate extension names" warning).
                link: false,
            }),
            Paragraph,
            BulletList,
            OrderedListStart,
            DashListKeymap,
            // Real header anchors: each heading gets a slug `id` (DOM-only, via
            // decorations — never serialized), so the outline links to `#id`.
            HeadingAnchors,
            InlineCodeExit,
            // Wrap a non-empty selection on ` (inline code) / [ (brackets)
            // instead of replacing it.
            WrapSelection,
            // Must come before `Markdown` so our higher-priority
            // clipboardTextParser runs first and handles block-level
            // paste content (bulleted "* test", headings, etc.) that
            // tiptap-markdown's hardcoded `inline: true` parser drops.
            MarkdownBlockPaste,
            Markdown.configure({
                html: false,
                tightLists: true,
                tightListClass: 'tight',
                bulletListMarker: '*',
                linkify: true,
                breaks: true,
                transformPastedText: true,
                transformCopiedText: true,
            }),
            // Embedded codeblocks soft-wrap by default; a consumer can flip
            // this (or any codeblock setting) via `options.codeblock.settings`.
            ExtendedCodeblock.configure({ settings: options.codeblock?.settings ?? {} }),
            TaskList,
            ExtendedTaskItem.configure({
                nested: true,
            }),
            TableKit.configure({
                table: { resizable: true, allowTableNodeSelection: true },
            }),
            SlashCommands.configure({
                commands: defaultSlashCommands,
            }),
            // The toolbar reads its fs/filepath from `options.toolbar` when
            // given, otherwise falls back to the editor's filesystem so a
            // consumer can configure just `mount`/`className` and still get
            // a working file search.
            Toolbar.configure({
                fs: options.toolbar?.fs ?? options.fs?.fs,
                index: options.toolbar?.index,
                filepath: options.toolbar?.filepath ?? options.fs?.filepath,
                // Defaults into the wrapper's (stationary) toolbar slot.
                mount: options.toolbar?.mount ?? slotMount(toolbarSlot),
                className: options.toolbar?.className,
                // Static (always-visible) by default; opt into the auto-hiding
                // pill with `toolbar.autoHide: true`.
                autoHide: options.toolbar?.autoHide ?? false,
            }),
            // The block-action indicator gets its own gutter column by default
            // (always present); `blockActions.mount` relocates it.
            BlockActions.configure({ mount: options.blockActions?.mount ?? slotMount(gutter) }),
            SelectionMenu,
            LinkMenu,
            // The outline is opt-in (generated only when `sidebar` is set). It
            // defaults into the wrapper's nav column (left of the gutter);
            // `sidebar.mount` relocates it elsewhere.
            ...(options.sidebar
                ? [Sidebar.configure({
                    mount: options.sidebar.mount ?? slotMount(navHost),
                    className: options.sidebar.className,
                    title: options.sidebar.title,
                })]
                : []),
            ...(_extraExtensions || []),
        ],
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

    if (typeof document !== 'undefined') {
        StyleModule.mount(document, styleModule);
        injectCaretBlink();
    }
    return editor as MarkdownEditor;
}

// Re-export the toolbar so consumers can add/configure it themselves (e.g.
// to control where it mounts or restyle it) instead of relying on the
// `options.toolbar` convenience wiring.
export { Toolbar } from './extensions/toolbar';
export type { ToolbarOptions, ToolbarMount } from './extensions/toolbar';

// Re-export the sidebar/outline so consumers can configure where it mounts or
// restyle it instead of relying on the `options.sidebar` convenience wiring.
export { Sidebar } from './extensions/sidebar';
export type { SidebarOptions, SidebarMount } from './extensions/sidebar';

// Re-export block-actions so consumers can mount the indicator into a dedicated
// column instead of overlaying it in the editor's left gutter.
export { BlockActions } from './extensions/block-actions';
export type { BlockActionsOptions, BlockActionsMount } from './extensions/block-actions';
