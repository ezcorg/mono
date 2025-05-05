import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { Node, mergeAttributes, textblockTypeInputRule } from '@tiptap/core';
import { basicSetup, codeblock, CodeblockFS, extToLanguageMap } from '@ezcodelol/codeblock'
import { EditorView, ViewUpdate, KeyBinding, keymap } from '@codemirror/view';
import { EditorState } from "@codemirror/state";
import { configureSingle, promises as fs } from "@zenfs/core"
import { WebStorage } from '@zenfs/dom';
import { exitCode } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history"

await configureSingle({ backend: WebStorage })

export const CodeblockExtension = Node.create({
    name: 'ezCodeblock', // Unique name for your node
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
                parseHTML: element => element.querySelector('code')?.getAttribute('class')?.replace('language-', ''),
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
            }
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
                    if (!input) return { language: 'markdown' };

                    const matchingLanguage = Object.entries(extToLanguageMap).find(([ext, lang]) => {
                        return lang.includes(input) || ext === input;
                    })

                    if (!matchingLanguage) {
                        const ext = input.split('.').pop()?.toLowerCase() || '';
                        const lang = extToLanguageMap[ext] || 'markdown'
                        return {
                            file: input,
                            language: lang,
                        };
                    }

                    // Otherwise, treat as language name
                    return {
                        language: matchingLanguage[1],
                        file: null,
                    };
                },
            }),
        ];
    },

    // Register keyboard shortcuts (e.g., Tab for indentation - complex to get right)
    addKeyboardShortcuts() {
        return {
            // Example: Exit code block with Ctrl+Enter
            // 'Mod-Enter': () => this.editor.commands.exitCode(),
            // Example: Prevent leaving block with arrow keys if needed
            // 'ArrowUp': () => {/* custom logic */},
            // 'ArrowDown': () => {/* custom logic */}
        };
    },


    // Connect the React component
    addNodeView() {
        return ({ editor, node, getPos, HTMLAttributes: attr }: any) => {
            const { view, schema } = editor;
            let updating = false;

            console.log('adding node view', { nodeAttrs: node.attrs, attr, })

            const forwardUpdate = (cm: EditorView, update: ViewUpdate) => {
                if (updating || !cm.hasFocus) return
                let offset = getPos() + 1, { main } = update.state.selection
                let selFrom = offset + main.from, selTo = offset + main.to
                let pmSel = view.state.selection
                console.log('forward update', { offset, selFrom, selTo, pmSel, cm, update, hasFocus: cm.hasFocus, changed: update.docChanged, tr: view.state.tr })

                if (update.docChanged || pmSel.from != selFrom || pmSel.to != selTo) {
                    let tr = view.state.tr

                    update.changes.iterChanges((fromA, toA, fromB, toB, text) => {
                        if (text.length)
                            tr.replaceWith(offset + fromA, offset + toA,
                                schema.text(text.toString()))
                        else
                            tr.delete(offset + fromA, offset + toA)
                        offset += (toB - fromB) - (toA - fromA)
                    })
                    tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo))
                    view.dispatch(tr)
                }
            }

            const maybeEscape = (unit: any, dir: any) => {
                console.log('maybe escape', unit, dir)
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
                console.debug('delete?', { length: node.textContent.length, node })
                // if the codeblock is empty, delete it
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

            console.log({ basicSetup })

            const state = EditorState.create({
                doc: node.textContent || '',
                extensions: [
                    keymap.of(codemirrorKeymap()),
                    basicSetup,
                    codeblock({ content: node.textContent, fs: CodeblockFS.fromNodelike(fs), language: node.attrs.language, file: node.attrs.file, toolbar: !!node.attrs.file, cwd: '/' }),
                    EditorView.updateListener.of((update) => { forwardUpdate(cm, update) }),
                ]
            });

            const container = document.createElement('div')
            container.classList.add('codeblock-container')

            const cm = new EditorView({ state });
            const dom = cm.dom;

            return {
                dom,
                setSelection(anchor, head, root) {
                    console.log('setting selection', { anchor, head, root, updating })
                    cm.focus()
                    updating = true
                    cm.dispatch({ selection: { anchor, head } })
                    updating = false
                },
                destroy() {
                    console.log('destroying codeblock', { node, cm })
                    cm.destroy();
                },
                selectNode() { cm.focus() },
                stopEvent(e) { console.log('would be preventing e', e); return true },
                update(updated) {
                    console.log('updated', { updatedType: updated.type, nodeType: node.type, equal: updated.type == node.type, updating })
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
