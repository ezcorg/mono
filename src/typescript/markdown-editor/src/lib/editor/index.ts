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
import { defaultSlashCommands } from './commands';
import { StyleModule } from 'style-mod';

export type MarkdownEditorOptions = Partial<EditorOptions> & {
    extensions?: Extension[];
    fs?: FileSystemOptions;
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

    editor.view.dom.classList.add('ezdev-mde');

    if (typeof document !== 'undefined') {
        StyleModule.mount(document, styleModule);
    }

    return editor as MarkdownEditor;
}
