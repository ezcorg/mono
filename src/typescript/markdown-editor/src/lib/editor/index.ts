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
import { SlashCommands } from './extensions/slash-commands';
import { Toolbar, ToolbarOptions } from './extensions/toolbar';
import { InlineCodeExit } from './extensions/inline-code';
import { MarkdownBlockPaste } from './extensions/markdown-paste';
import { BlockActions } from './extensions/block-actions';
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
    .ezco-mde .ProseMirror {
        caret-animation: manual;
    }
    .ezco-mde .ProseMirror:focus {
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
    const editor = new Editor({
        extensions: [
            FileSystem.configure(options.fs || {}),
            ExtendedLink.configure({}),
            StarterKit.configure({
                codeBlock: false,
                // bulletList: false, // As Markdown handles bullet lists and allows us to configure the marker to prevent task item conflicts
            }),
            InlineCodeExit,
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
            ExtendedCodeblock,
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
            Toolbar.configure(options.toolbar || {
                fs: options.fs?.fs,
                filepath: options.fs?.filepath,
            }),
            BlockActions,
            ...(options.extensions || []),
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
        ...options,
    });
    editor.view.dom.classList.add('ezco-mde');

    if (typeof document !== 'undefined') {
        StyleModule.mount(document, styleModule);
        injectCaretBlink();
    }
    return editor as MarkdownEditor;
}
