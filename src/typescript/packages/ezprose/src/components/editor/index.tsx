import React, { useState, useEffect, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { Markdown } from 'tiptap-markdown'; // Import the Markdown extension

// Import your custom code block extension
// import { CustomCodeBlockExtension } from './CustomCodeBlockExtension'; // Adjust path

// Basic Editor Styling (add more in your CSS file)
import './styles.css'; // Create a styles.css file for editor styling

const TipTapMarkdownEditor = ({ initialContent = '', onChange }: any) => {
    const editor = useEditor({
        extensions: [
            // Use StarterKit but disable its default CodeBlock because we have a custom one
            StarterKit.configure({
                // Disable StarterKit's CodeBlock if you are replacing it entirely
                codeBlock: false,
                // Keep other StarterKit defaults like paragraph, bold, etc.
            }),
            // Add the Markdown extension BEFORE other nodes it needs to handle
            // (like tables, task lists, custom code block)
            Markdown.configure({
                html: false, // Output Markdown, not HTML
                tightLists: true, // No <p> inside <li> in compact lists
                tightListClass: 'tight', // Optional class for tight lists
                bulletListMarker: '*', // Or '-'
                linkify: true, // Autodetect links
                breaks: false, // Convert soft breaks to \n?
                // Ensure transformers handle the nodes you want to support
                transformPastedText: true, // Parses Markdown text on paste
                transformCopiedText: true, // Converts selected content to Markdown on copy
            }),
            // --- Custom Extensions ---
            // CustomCodeBlockExtension, // Add your custom code block node

            // --- Standard Extensions ---
            TaskList,
            TaskItem.configure({
                nested: true, // Allow nested task lists
            }),
            Table.configure({
                resizable: true, // Allow resizing table columns
            }),
            TableRow,
            TableHeader,
            TableCell,
            // Add other extensions here if needed (e.g., Link, Image, Highlight)
        ],
        content: initialContent, // Initialize with Markdown string
        editorProps: {
            attributes: {
                // Add Tailwind or regular CSS classes here
                class: 'prose prose-sm sm:prose lg:prose-lg xl:prose-2xl m-5 focus:outline-none',
            },
        },
        // Trigger the onChange callback when the editor content changes
        onUpdate: ({ editor }) => {
            // Get content as Markdown
            const markdown = editor.storage.markdown.getMarkdown();
            // console.log("Markdown Output:", markdown); // For debugging
            if (onChange) {
                onChange(markdown);
            }
        },
    });

    // Function to insert a table (Example)
    const addTable = useCallback(() => {
        if (editor) {
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        }
    }, [editor]);

    if (!editor) {
        return null;
    }

    return (
        <div>
            {/* Optional: Basic Toolbar */}
            <div style={{ borderBottom: '1px solid #ccc', padding: '5px' }}>
                <button onClick={addTable}>Insert Table</button>
                {/* Add buttons for Bold, Italic, Task List, Code Block etc. */}
                {/* Example: <button onClick={() => editor.chain().focus().toggleBold().run()} disabled={!editor.can().chain().focus().toggleBold().run()}>Bold</button> */}
                {/* Example: <button onClick={() => editor.chain().focus().toggleCodeBlock().run()} disabled={!editor.can().chain().focus().toggleCodeBlock().run()}>Code Block</button> */}
                {/* Note: For custom code block, use the name: editor.chain().focus().toggleNode('customCodeBlock', 'paragraph').run() */}
                <button
                // onClick={() => editor.chain().focus().toggleNode(CustomCodeBlockExtension.name, 'paragraph').run()}
                // disabled={!editor.can().toggleNode(CustomCodeBlockExtension.name, 'paragraph')}
                >
                    Custom Code Block
                </button>
            </div>

            <EditorContent editor={editor} />
        </div>
    );
};

export default TipTapMarkdownEditor;