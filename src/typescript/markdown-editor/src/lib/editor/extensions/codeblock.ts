import { Selection, TextSelection } from '@tiptap/pm/state';
import { Node, mergeAttributes, textblockTypeInputRule } from '@tiptap/core';
import { basicSetup, codeblock, CodeblockFS, extToLanguageMap, SearchIndex } from '@ezdevlol/codeblock'
import { EditorView, ViewUpdate, KeyBinding, keymap } from '@codemirror/view';
import { EditorState } from "@codemirror/state";
import { exitCode } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history"
import { MarkdownNodeSpec } from 'tiptap-markdown';

// TODO: configure a filesystem worker which is used by both the editor and the codeblock extension
// Initialize filesystem worker lazily to avoid top-level await
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
                        return extToLanguageMap[ext] || 'markdown';
                    }

                    return extracted;
                },
                // Render language back to HTML structure
                renderHTML: attributes => {

                    console.log('renderHTML attributes', { attributes });

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
        return [
            textblockTypeInputRule({
                find: /^```([^\s`]+)?\s$/,
                type: this.type,
                getAttributes: match => {
                    const input = match[1]?.trim();
                    console.log('input', { input });

                    if (!input) return { language: 'markdown' };

                    // If input contains a dot, treat it as a filename
                    if (input.includes('.')) {
                        const ext = input.split('.').pop()?.toLowerCase() || '';
                        const lang = extToLanguageMap[ext] || 'markdown'
                        return {
                            file: input,
                            language: lang,
                        };
                    }

                    // Otherwise, check if it's a language name
                    const matchingLanguage = Object.entries(extToLanguageMap).find(([ext, lang]) => {
                        return lang.includes(input) || ext === input;
                    })

                    if (matchingLanguage) {
                        return {
                            language: matchingLanguage[1],
                            file: null,
                        };
                    }

                    // If no language match found, default to markdown
                    return { language: 'markdown' };
                },
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
                // @ts-ignore
                let targetPos = getPos() + (dir < 0 ? 0 : node.nodeSize)
                let selection = Selection.near(view.state.doc.resolve(targetPos), dir)
                let tr = view.state.tr.setSelection(selection).scrollIntoView()
                view.dispatch(tr)
                view.focus()
                return true;
            }

            const maybeExit = () => {
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

            console.log('getting fs worker')

            // Initialize filesystem worker and update extensions asynchronously
            getFileSystemWorker().then(fs => {
                fsWorker = fs;
                console.log('fs worker initialized', fsWorker);
                SearchIndex.get(fsWorker, '.codeblock/index.json').then(index => {
                    console.log('creating extended codeblock', { node, index });
                    // Reconfigure with codeblock extension once fs is ready
                    cm.setState(EditorState.create({
                        doc: node.textContent || '',
                        extensions: [
                            keymap.of(codemirrorKeymap()),
                            basicSetup,
                            EditorView.updateListener.of((update) => forwardUpdate(cm, update)),
                            codeblock({
                                content: node.textContent,
                                fs: fsWorker,
                                language: node.attrs.language,
                                file: node.attrs.file,
                                toolbar: !!node.attrs.file,
                                cwd: '/',
                                index,
                            }),
                        ]
                    }));
                })
            }).catch(error => {
                console.error('Failed to initialize filesystem worker:', error);
            });

            return {
                dom,
                setSelection(anchor, head) {
                    cm.focus()
                    updating = true
                    cm.dispatch({ selection: { anchor, head } })
                    updating = false
                },
                destroy() {
                    cm.destroy();
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
});
