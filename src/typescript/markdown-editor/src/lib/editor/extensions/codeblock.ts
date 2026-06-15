import { Selection, TextSelection } from '@tiptap/pm/state';
import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import type { NodeType } from '@tiptap/pm/model';
import { basicSetup, codeblock, CodeblockFS, currentFileField, ExtensionOrLanguage, extOrLanguageToLanguageId, SearchIndex, setThemeEffect } from '@joinezco/codeblock'
import { EditorView, ViewUpdate, KeyBinding, keymap } from '@codemirror/view';
import { EditorState } from "@codemirror/state";
import { exitCode } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history"
import { MarkdownNodeSpec } from 'tiptap-markdown';

// Function to reassign z-index values to all codeblocks in DOM order
function reassignZIndexes() {
    const editors = document.querySelectorAll('.cm-editor');
    editors.forEach((editor, index) => {
        // Assign z-index from highest (n) to lowest (0) based on DOM order
        // This ensures later codeblocks (lower in document) have higher z-index
        (editor as HTMLElement).style.zIndex = (editors.length - index).toString();
    });
}

// Global registry for codeblock instances
class CodeblockRegistry {
    private static instance: CodeblockRegistry;
    private codeblocks: Set<EditorView> = new Set();

    static getInstance(): CodeblockRegistry {
        if (!CodeblockRegistry.instance) {
            CodeblockRegistry.instance = new CodeblockRegistry();
        }
        return CodeblockRegistry.instance;
    }

    register(view: EditorView): void {
        this.codeblocks.add(view);
    }

    unregister(view: EditorView): void {
        this.codeblocks.delete(view);
    }

    setTheme(options: { dark: boolean }): void {
        this.codeblocks.forEach(view => {
            view.dispatch({
                effects: setThemeEffect.of(options)
            })
        });
    }

    getCount(): number {
        return this.codeblocks.size;
    }
}

export const codeblockRegistry = CodeblockRegistry.getInstance();

let fsWorkerPromise: Promise<any> | null = null;

function getFileSystemWorker() {
    if (!fsWorkerPromise) {
        fsWorkerPromise = CodeblockFS.worker();
    }
    return fsWorkerPromise;
}

export const ExtendedCodeblock = Node.create({
    name: 'ezcodeBlock', // Unique name for your node
    group: 'block', // Belongs to the 'block' group (like paragraph, heading)
    content: 'text*', // Can contain text content
    marks: '', // No marks (like bold, italic) allowed inside
    defining: true, // A defining node encapsulates its content
    code: true, // Indicates this node represents code
    isolating: true, // Content inside is isolated from outside editing actions

    addAttributes() {
        return {
            language: {
                default: 'markdown', // Default language
                // Parse language from HTML structure if available
                parseHTML: element => {
                    const className = element.querySelector('code')?.getAttribute('class');
                    const extracted = className?.replace('language-', '');

                    // If the extracted value looks like a filename (contains a dot),
                    // we'll handle this in the file attribute parseHTML instead
                    if (extracted && extracted.includes('.')) {
                        const ext = extracted.split('.').pop()?.toLowerCase() || '';
                        return extOrLanguageToLanguageId[ext as ExtensionOrLanguage] || 'markdown';
                    }

                    return extracted;
                },
                // Render language back to HTML structure
                renderHTML: attributes => {

                    if (!attributes.language || attributes.language === 'plaintext') {
                        return {}; // No class needed for plaintext
                    }
                    return {
                        // Add class="language-js" (or ts, py etc) to the inner <code> tag
                        class: `language-${attributes.language}`,
                    }
                },
            },
            file: {
                default: null,
                // Parse filename from HTML class if it looks like a filename
                parseHTML: element => {
                    const className = element.querySelector('code')?.getAttribute('class');
                    const extracted = className?.replace('language-', '');

                    // If the extracted value contains a dot, treat it as a filename
                    if (extracted && extracted.includes('.')) {
                        return extracted;
                    }

                    return null;
                },
            },
        };
    },


    addStorage() {
        return {
            markdown: {
                serialize(state, node) {

                    if (node.attrs.file) {
                        state.write(`\`\`\`${node.attrs.file}\n`);
                    } else {
                        state.write("```" + (node.attrs.language || "") + "\n");
                    }
                    state.text(node.textContent, false);
                    state.ensureNewLine();
                    state.write("```");
                    state.closeBlock(node);
                },
                parse: {
                    setup(markdownit) {
                        markdownit.set({
                            langPrefix: this.options.languageClassPrefix ?? 'language-',
                        });
                    },
                    updateDOM(element) {
                        element.innerHTML = element.innerHTML.replace(/\n<\/code><\/pre>/g, '</code></pre>')
                    },
                },
            } as MarkdownNodeSpec
        }
    },

    // How to parse this node from HTML
    parseHTML() {
        return [
            {
                tag: 'pre', // Matches <pre> elements
                // Optional: preserveWhitespace: 'full', // Keep all whitespace
                // Ensure it has a <code> tag directly inside for specificity
                contentElement: 'code', // Tell tiptap content is inside the code tag
            },
        ];
    },

    // How to render this node back to HTML
    renderHTML({ HTMLAttributes }) {
        // mergeAttributes correctly handles the language attribute rendering defined above
        // It renders a <pre> tag, and inside it a <code> tag with the language class
        return ['pre', ['code', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]];
        // The '0' is a "hole" where the content (text) will be rendered
    },

    // Register input rules (e.g., ``` or ~~~ at the start of a line)
    addInputRules() {
        const parseLanguageAttributes = (input: string | undefined) => {
            if (!input) return { language: 'markdown' };

            // If input contains a dot, treat it as a filename
            if (input.includes('.')) {
                const ext = input.split('.').pop()?.toLowerCase() || '';
                const lang = extOrLanguageToLanguageId[ext as ExtensionOrLanguage] || 'markdown'
                return { file: input, language: lang };
            }

            // Otherwise, check if it's a language name
            const matchingLanguage = Object.entries(extOrLanguageToLanguageId).find(([ext, lang]) => {
                return lang.includes(input) || ext === input;
            })

            if (matchingLanguage) {
                return { language: matchingLanguage[1], file: null };
            }

            return { language: 'markdown' };
        };

        // Turn the matched "```"/"```lang" trigger into a codeblock.
        //
        // The default `textblockTypeInputRule` only converts the current
        // textblock in place. That fails inside a list item, whose schema
        // (`paragraph block*`) requires a *leading paragraph* — you can't
        // replace that required paragraph with a codeblock. So when an
        // in-place conversion isn't valid but we're inside a list item,
        // insert the codeblock as the next block *within* the item. It
        // then renders indented to the item's level (an "indented
        // codeblock") and round-trips to markdown as a fenced block nested
        // under the list item.
        const codeblockType = this.type;
        const applyCodeblock = (
            state: any,
            range: { from: number; to: number },
            attrs: Record<string, unknown>,
        ): null | void => {
            const { tr } = state;
            const $start = state.doc.resolve(range.from);
            const type = codeblockType as NodeType;

            const canReplaceInPlace = $start
                .node(-1)
                .canReplaceWith($start.index(-1), $start.indexAfter(-1), type);

            if (canReplaceInPlace) {
                tr.delete(range.from, range.to).setBlockType(range.from, range.from, type, attrs);
                return;
            }

            const containerName = $start.node(-1)?.type.name;
            if (containerName !== 'listItem' && containerName !== 'taskItem') {
                // Nowhere valid to put a codeblock here — leave the text as
                // typed rather than silently swallowing it.
                return null;
            }

            // Drop the trigger text, then insert the codeblock as the
            // sibling block right after the (now possibly empty) paragraph.
            tr.delete(range.from, range.to);
            const $pos = tr.doc.resolve(tr.mapping.map(range.from));
            const insertAt = $pos.after($pos.depth);
            const node = type.createAndFill(attrs);
            if (!node) return null;
            tr.insert(insertAt, node);
            // Park the selection inside the new codeblock so its NodeView
            // takes focus (empty codeblocks open their language toolbar).
            tr.setSelection(TextSelection.near(tr.doc.resolve(insertAt + 1)));
        };

        return [
            // ```language + space — more specific, checked first
            new InputRule({
                find: /^```([^\s`]+)\s$/,
                handler: ({ state, range, match }) =>
                    applyCodeblock(state, range, parseLanguageAttributes(match[1]?.trim())),
            }),
            // ``` alone — triggers immediately on the third backtick
            new InputRule({
                find: /^```$/,
                handler: ({ state, range }) =>
                    applyCodeblock(state, range, { language: '' }),
            }),
        ];
    },

    addNodeView() {
        return ({ editor, node, getPos }: any) => {
            const { view, schema } = editor;
            let updating = false;
            let cm: EditorView;
            let fsWorker: any = null;

            const forwardUpdate = (cmView: EditorView, update: ViewUpdate) => {
                if (updating) return
                // Allow forwarding updates even when not focused during initial file loading
                // This ensures that asynchronously loaded file content gets propagated to ProseMirror
                const pos = getPos()
                if (pos === undefined) return

                let offset = pos + 1, { main } = update.state.selection
                let selFrom = offset + main.from, selTo = offset + main.to
                let pmSel = view.state.selection

                if (update.docChanged || pmSel.from != selFrom || pmSel.to != selTo) {
                    let tr = view.state.tr

                    // Ensure we're working within valid document bounds
                    const docLength = tr.doc.length

                    update.changes.iterChanges((fromA, toA, fromB, toB, text) => {
                        const replaceFrom = offset + fromA
                        const replaceTo = offset + toA

                        // Validate positions are within bounds
                        if (replaceFrom < 0 || replaceTo > docLength || replaceFrom > replaceTo) {
                            console.warn('Invalid position range, skipping change:', { replaceFrom, replaceTo, docLength })
                            return
                        }

                        if (text.length)
                            tr.replaceWith(replaceFrom, replaceTo, schema.text(text.toString()))
                        else
                            tr.delete(replaceFrom, replaceTo)
                        offset += (toB - fromB) - (toA - fromA)
                    })

                    // Only set selection if the editor has focus or if this is a document change without focus
                    // (which happens during initial file loading)
                    if (cmView.hasFocus || update.docChanged) {
                        const finalDocLength = tr.doc.length
                        const clampedSelFrom = Math.max(0, Math.min(selFrom, finalDocLength))
                        const clampedSelTo = Math.max(0, Math.min(selTo, finalDocLength))

                        if (clampedSelFrom <= finalDocLength && clampedSelTo <= finalDocLength) {
                            tr.setSelection(TextSelection.create(tr.doc, clampedSelFrom, clampedSelTo))
                        }
                    }

                    view.dispatch(tr)
                }
            }

            const maybeEscape = (unit: any, dir: any) => {
                let { state } = cm, { main }: any = state.selection
                if (!main.empty) return false
                if (unit == "line") main = state.doc.lineAt(main.head)
                if (dir < 0 ? main.from > 0 : main.to < state.doc.length) return false

                // ArrowUp from first line: focus toolbar instead of escaping to ProseMirror
                if (dir < 0) {
                    const toolbarInput = cm.dom.querySelector<HTMLInputElement>('.cm-toolbar-input');
                    if (toolbarInput) {
                        toolbarInput.focus();
                        return true;
                    }
                }

                // @ts-ignore
                let targetPos = getPos() + (dir < 0 ? 0 : node.nodeSize)
                let selection = Selection.near(view.state.doc.resolve(targetPos), dir)
                let tr = view.state.tr.setSelection(selection).scrollIntoView()
                view.dispatch(tr)
                view.focus()
                return true;
            }

            const maybeExit = () => {
                // When the codeblock lives inside a list item, "exiting" it
                // should continue the list — add a new sibling list item
                // after the current one and drop the cursor into it. This is
                // the intuitive counterpart to pressing Enter in a list.
                // (The default `exitCode` only adds a paragraph *inside* the
                // current item, and won't fire at all when there's no block
                // after the codeblock — so Shift-Enter felt like it did
                // nothing for indented codeblocks.)
                const pos = getPos();
                if (pos !== undefined) {
                    const $pos = view.state.doc.resolve(pos);
                    let liDepth = -1;
                    for (let d = $pos.depth; d > 0; d--) {
                        const name = $pos.node(d).type.name;
                        if (name === 'listItem' || name === 'taskItem') { liDepth = d; break; }
                    }
                    if (liDepth >= 0) {
                        const itemType = $pos.node(liDepth).type;
                        const attrs = itemType.name === 'taskItem' ? { checked: false } : null;
                        const newItem = itemType.createAndFill(attrs);
                        if (newItem) {
                            const insertAt = $pos.after(liDepth);
                            const tr = view.state.tr.insert(insertAt, newItem);
                            tr.setSelection(Selection.near(tr.doc.resolve(insertAt + 1)));
                            view.dispatch(tr.scrollIntoView());
                            view.focus();
                            return true;
                        }
                    }
                }

                if (!exitCode(view.state, view.dispatch)) return false;
                view.focus();
                return true;
            }

            const maybeDelete = () => {
                // if the codeblock is empty, delete it and move our cursor to the previous position
                if (node.textContent.length == 0) {
                    const pos = getPos();

                    if (pos !== undefined) {
                        let selection = Selection.near(view.state.doc.resolve(pos), -1)
                        let tr = view.state.tr.setSelection(selection).scrollIntoView()
                        tr.delete(pos, pos + node.nodeSize)
                        view.dispatch(tr)
                        view.focus()
                        return true;
                    }
                }
                return false;
            }

            const codemirrorKeymap = () => {
                return [
                    { key: "Backspace", run: maybeDelete },
                    { key: "ArrowUp", run: () => maybeEscape("line", -1) },
                    { key: "ArrowLeft", run: () => maybeEscape("char", -1) },
                    { key: "ArrowDown", run: () => maybeEscape("line", 1) },
                    { key: "ArrowRight", run: () => maybeEscape("char", 1) },
                    { key: "Shift-Enter", run: maybeExit },
                    { key: "Ctrl-Enter", run: maybeExit },
                    {
                        key: "Ctrl-z", mac: "Cmd-z",
                        run: () => undo(view.state, view.dispatch)
                    },
                    {
                        key: "Shift-Ctrl-z", mac: "Shift-Cmd-z",
                        run: () => redo(view.state, view.dispatch)
                    },
                    {
                        key: "Ctrl-y", mac: "Cmd-y",
                        run: () => redo(view.state, view.dispatch)
                    }
                ] as KeyBinding[]
            }

            // Keep the ProseMirror node's `file`/`language` attributes in
            // sync with the codeblock's live state. The filename can change
            // *inside* CodeMirror — when the user picks/creates a file via
            // the codeblock toolbar it updates `currentFileField` but not
            // the PM node. Without this sync the node attr stays stale, so
            // (a) the file is dropped from serialized markdown and (b) if
            // the NodeView is ever recreated (e.g. an edit to a sibling
            // list item reflows the list) it reloads from the stale attr
            // and loses the filename + syntax/semantic highlighting.
            const syncFileAttrs = (update: ViewUpdate) => {
                if (updating) return;
                const next = update.state.field(currentFileField, false);
                if (!next || next.loading) return;
                const prev = update.startState.field(currentFileField, false);
                if (prev && prev.path === next.path && prev.language === next.language) return;

                const pos = getPos();
                if (pos === undefined) return;
                const current = view.state.doc.nodeAt(pos);
                if (!current || current.type !== node.type) return;

                const newFile = next.path ?? null;
                const newLang = next.language ?? current.attrs.language ?? 'markdown';
                if (current.attrs.file === newFile && current.attrs.language === newLang) return;

                updating = true;
                try {
                    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, {
                        ...current.attrs,
                        file: newFile,
                        language: newLang,
                    }));
                } finally {
                    updating = false;
                }
            };

            // Create initial state without codeblock extension
            const initialState = EditorState.create({
                doc: node.textContent || '',
                extensions: [
                    keymap.of(codemirrorKeymap()),
                    basicSetup,
                    EditorView.updateListener.of((update) => { forwardUpdate(cm, update) }),
                ]
            });

            cm = new EditorView({ state: initialState });
            const dom = cm.dom;

            // Reassign z-indexes for all codeblocks whenever a new one is created
            // This ensures proper stacking order based on DOM position
            reassignZIndexes();

            // Handle ArrowUp from toolbar to escape to ProseMirror above
            dom.addEventListener('keydown', (e) => {
                const target = e.target as HTMLElement;
                if (target.classList.contains('cm-toolbar-input') && e.key === 'ArrowUp') {
                    // Check if the dropdown is open — if so, let toolbar handle it
                    const dropdown = dom.querySelector('.cm-search-results');
                    if (dropdown && dropdown.children.length > 0) return;

                    e.preventDefault();
                    e.stopPropagation();
                    // @ts-ignore
                    const pos = getPos();
                    if (pos !== undefined) {
                        let selection = Selection.near(view.state.doc.resolve(pos), -1);
                        let tr = view.state.tr.setSelection(selection).scrollIntoView();
                        view.dispatch(tr);
                        view.focus();
                    }
                }
            }, true);

            // Track whether this codeblock was created empty (e.g. via ``` input rule)
            const wasCreatedEmpty = !node.textContent && !node.attrs.file;

            // Use the editor's filesystem if available (so codeblocks can resolve
            // file references seeded into the same filesystem), otherwise fall back
            // to a standalone worker.
            const editorFs = editor.storage.persistence?.options?.fs;
            const fsPromise = editorFs ? Promise.resolve(editorFs) : getFileSystemWorker();
            fsPromise.then(fs => {
                fsWorker = fs;
                SearchIndex.get(fsWorker, '.codeblock/index.json').then(index => {
                    // Reconfigure with codeblock extension once fs is ready
                    cm.setState(EditorState.create({
                        doc: node.textContent || '',
                        extensions: [
                            keymap.of(codemirrorKeymap()),
                            basicSetup,
                            EditorView.updateListener.of((update) => forwardUpdate(cm, update)),
                            EditorView.updateListener.of(syncFileAttrs),
                            codeblock({
                                content: node.textContent,
                                fs: fsWorker,
                                language: node.attrs.language,
                                filepath: node.attrs.file,
                                index,
                                dark: true,
                            }),
                        ]
                    }));

                    // If created via input rule (empty), focus toolbar and open dropdown
                    if (wasCreatedEmpty) {
                        requestAnimationFrame(() => {
                            const toolbarInput = cm.dom.querySelector<HTMLInputElement>('.cm-toolbar-input');
                            if (toolbarInput) {
                                toolbarInput.focus();
                                toolbarInput.click();
                            }
                        });
                    }
                })
            }).catch(error => {
                console.error('Failed to initialize filesystem worker:', error);
            });

            // Register the codeblock instance
            codeblockRegistry.register(cm);

            return {
                dom,
                setSelection(anchor, head) {
                    // If the codeblock wasn't focused (entering from outside),
                    // direct to the toolbar input for keyboard navigation
                    if (!cm.hasFocus) {
                        const toolbarInput = cm.dom.querySelector<HTMLInputElement>('.cm-toolbar-input');
                        if (toolbarInput) {
                            toolbarInput.focus();
                            return;
                        }
                    }
                    cm.focus()
                    updating = true
                    cm.dispatch({ selection: { anchor, head } })
                    updating = false
                },
                destroy() {
                    // Unregister before destroying
                    codeblockRegistry.unregister(cm);
                    cm.destroy();
                    requestAnimationFrame(reassignZIndexes);
                },
                selectNode() { cm.focus() },
                stopEvent() { return true },
                update(updated) {
                    if (updated.type != node.type) return false
                    node = updated
                    if (updating) return true

                    let newText = updated.textContent, curText = cm.state.doc.toString()
                    if (newText != curText) {
                        let start = 0, curEnd = curText.length, newEnd = newText.length
                        while (start < curEnd &&
                            curText.charCodeAt(start) == newText.charCodeAt(start)) {
                            ++start
                        }
                        while (curEnd > start && newEnd > start &&
                            curText.charCodeAt(curEnd - 1) == newText.charCodeAt(newEnd - 1)) {
                            curEnd--
                            newEnd--
                        }
                        updating = true
                        cm.dispatch({
                            changes: {
                                from: start, to: curEnd,
                                insert: newText.slice(start, newEnd)
                            }
                        })
                        updating = false
                    }
                    return true
                }
            };
        }
    },

    addCommands() {
        return {
            setCodeblockTheme: (options) => () => {
                codeblockRegistry.setTheme(options);
                return true;
            },
        };
    },
});

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        ezcodeBlock: {
            /**
             * Set the codeblock theme to dark or light mode.
             * @param options - An object with a `dark` boolean property.
             * @example editor.commands.setCodeblockTheme({ dark: true })
             */
            setCodeblockTheme: (options: { dark: boolean }) => ReturnType
        }
    }
}
