import { Compartment, EditorState, Extension, Facet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, keymap, KeyBinding, Panel, showPanel, tooltips, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from "@codemirror/view";
import { debounce } from "lodash";
import { codeblockTheme } from "./theme";
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { detectIndentationUnit } from "./utils";
import { completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete"
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search"
import { Fs } from "./types";
import { extToLanguageMap } from "./constants";
import { getLanguageSupport } from "./servers";
// import { LanguageServerClientImpl, languageServerWithTransport } from '@ezcodelol/codemirror-languageserver';
import { documentUri, languageId } from '@marimo-team/codemirror-languageserver';
import { lintKeymap } from "@codemirror/lint";
import { highlightCode } from "@lezer/highlight";
// import { MarkupContent } from "vscode-languageserver";
// import markdownit from 'markdown-it'
import { HighlightedSearch, SearchIndex } from "./utils/search";
import { LSP, LSPClientExtension } from "./utils/lsp";

export type CodeblockConfig = {
    fs: Fs;
    cwd: string,
    file?: string,
    content?: string,
    toolbar?: boolean,
    index?: SearchIndex,
    language?: keyof typeof extToLanguageMap
};
export const CodeblockFacet = Facet.define<CodeblockConfig, CodeblockConfig>({
    combine: (values) => values[0]
});

// Compartments for dynamically reconfiguring extensions
export const configCompartment = new Compartment();
export const languageSupportCompartment = new Compartment();
export const languageServerCompartment = new Compartment();
export const indentationCompartment = new Compartment();

// Effect to update search results
const setSearchResults = StateEffect.define<HighlightedSearch[]>();
// StateField to store search results
const searchResultsField = StateField.define<HighlightedSearch[]>({
    create() {
        return [];
    },
    update(value, transaction) {
        for (let effect of transaction.effects) {
            if (effect.is(setSearchResults)) return effect.value;
        }
        return value;
    }
});

const mod = (n: number, m: number) => ((n % m) + m) % m

// Create a custom panel for the toolbar
const toolbarPanel = (view: EditorView): Panel => {
    let { file, index } = view.state.facet(CodeblockFacet);

    const dom = document.createElement("div");
    dom.className = "cm-toolbar-panel";

    const input = document.createElement("input");
    input.type = "text";
    input.value = file;
    input.className = "cm-toolbar-input";
    dom.appendChild(input)

    // Dropdown for search results
    const resultsList = document.createElement("ul");
    resultsList.className = "cm-search-results";
    dom.appendChild(resultsList);

    let selectedIndex = 0;

    // Handle input changes
    input.addEventListener("input", async (event) => {
        const query = (event.target as HTMLInputElement).value;
        selectedIndex = 0;

        // Perform search
        const results = (index?.search(query, { fuzzy: true, prefix: true }) || []).slice(0, 1000);

        // Dispatch update to searchResultsField
        view.dispatch({ effects: setSearchResults.of(results) });
    });

    // Handle keyboard navigation
    input.addEventListener("keydown", (event) => {
        let results = view.state.field(searchResultsField);

        if (event.key === "ArrowDown") {
            event.preventDefault();
            selectedIndex = mod(selectedIndex + 1, results.length)
            updateDropdown();
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            console.log('here', selectedIndex, mod(selectedIndex - 1, results.length))
            selectedIndex = mod(selectedIndex - 1, results.length)
            updateDropdown();
        } else if (event.key === "Enter" && selectedIndex >= 0) {
            event.preventDefault();
            selectResult(results[selectedIndex]);
        }
    });

    function updateDropdown() {
        let results = view.state.field(searchResultsField);

        const children = results.map((result, i) => {
            const li = document.createElement("li");
            li.textContent = result.id;
            li.className = "cm-search-result";
            if (i === selectedIndex) li.classList.add("selected");
            li.addEventListener("click", () => selectResult(result));
            return li
        })
        resultsList.replaceChildren(...children)
    }

    function selectResult(result: HighlightedSearch) {
        input.value = result.id;
        view.dispatch({
            effects: setSearchResults.of([]) // Clear search results
        });

        // Update the facet with the selected file
        view.dispatch({
            effects: configCompartment.reconfigure(CodeblockFacet.of({
                ...view.state.facet(CodeblockFacet),
                file: result.id
            }))
        });
    }

    return {
        dom,
        top: true,
        update(update) {
            if (update.docChanged || update.selectionSet || update.transactions.length > 0) {
                updateDropdown();
            }
        }
    };
};

const navigationKeymap: KeyBinding[] = [{
    key: "ArrowUp",
    run: (view: EditorView) => {
        const cursor = view.state.selection.main;
        const line = view.state.doc.lineAt(cursor.head);
        const toolbarInput = view.dom.querySelector<HTMLElement>('.cm-toolbar-input');

        if (line.number === 1 && toolbarInput) {
            toolbarInput.focus();
            return true;
        }
        return false;
    }
}];

export const renderMarkdownCode = (code: any, parser: any, highlighter: HighlightStyle) => {
    let result = document.createElement("pre")

    function emit(text, classes) {
        let node = document.createTextNode(text)
        if (classes) {
            let span = document.createElement("span")
            span.appendChild(node)
            span.className = classes
            // @ts-ignore
            node = span
        }
        result.appendChild(node)
    }

    function emitBreak() {
        result.appendChild(document.createTextNode("\n"))
    }

    highlightCode(code, parser.parse(code), highlighter,
        emit, emitBreak)
    return result.getHTML()
}

// Main codeblock plugin creation function
export const codeblock = ({ content, fs, cwd, file, language, toolbar = true, index }: CodeblockConfig) => {
    return [
        configCompartment.of(CodeblockFacet.of({ language, content, fs, cwd, file, toolbar, index })),
        languageSupportCompartment.of([]),
        languageServerCompartment.of([]),
        indentationCompartment.of(indentUnit.of("    ")),
        tooltips({
            position: "fixed",
        }),
        showPanel.of(toolbar ? toolbarPanel : null),
        codeblockTheme,
        codeblockView,
        keymap.of(navigationKeymap.concat([indentWithTab])),
        vscodeDark,
        searchResultsField
    ];
};
// The main view plugin that handles reactive updates and file syncing
const codeblockView = ViewPlugin.define((view: EditorView) => {
    let { fs, file, content, language } = view.state.facet(CodeblockFacet);
    let abortController = new AbortController();

    console.debug('codeblock view plugin', { fs, file, content, language });

    // Save file changes to disk
    const save = debounce(async () => {
        console.debug('save called');
        await fs.writeFile(file, view.state.doc.toString()).catch(console.error);
    }, 500);

    // Function to setup file watching
    const startWatching = () => {
        abortController.abort(); // Cancel any existing watcher
        abortController = new AbortController();
        const { signal } = abortController;

        (async () => {
            try {
                for await (const _ of fs.watch(file, { signal })) {
                    try {
                        const content = await fs.readFile(file);
                        const doc = view.state.doc.toString();
                        console.debug('watch event', { content, doc, equal: content === doc });

                        if (content === view.state.doc.toString()) continue;
                        view.dispatch({
                            changes: { from: 0, to: view.state.doc.length, insert: content },
                        });
                    } catch (err: any) {
                        if (err.toString().indexOf('No data available') > -1) {
                            continue;
                        }
                        console.error("Failed to sync file changes", err);
                    }
                }
            } catch (err: any) {
                if (err.name === 'AbortError') return;
                throw err;
            }
        })();
    };
    console.debug({ startWatching })

    const languageFromExt = (ext: string) => {
        return extToLanguageMap[ext] || null;
    }

    // Detect indentation based on file content
    const getIndentationUnit = (content: string) => {
        return detectIndentationUnit(content) || '    ';
    };

    const openFile = async (path: string) => {

        if (!path || path.length === 0) return;

        console.debug('opening: ', path);

        try {
            const content = await fs.readFile(path);
            console.debug('file content', { content });
            const ext = path.split('.').pop()?.toLowerCase();
            const languageOrFromExt = language || languageFromExt(ext || '');
            const uri = `file:///${path}`

            let languageSupport = null;
            let lspExtension: LSPClientExtension = null;
            if (languageOrFromExt) {
                languageSupport = await getLanguageSupport(languageOrFromExt);
                lspExtension = await LSP.client(languageOrFromExt, path, fs);
            }

            const unit = getIndentationUnit(content);
            // Step 3: Compose all changes into a single transaction
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: content },
                effects: [
                    languageSupportCompartment.reconfigure(languageSupport || []),
                    languageServerCompartment.reconfigure([lspExtension, documentUri.of(uri), languageId.of(languageOrFromExt)]),
                    indentationCompartment.reconfigure(indentUnit.of(unit)),
                ]
            });

            console.log('applied all initial settings');

            // Start watching for file changes after the state is set up
            // TODO: fix this
            // startWatching();
            console.log('after watch call');
        } catch (error) {
            console.error("Failed to initialize codeblock:", error);
        }
    }

    if (file) {
        openFile(file);
    } else if (language) {
        getLanguageSupport(language).then((languageSupport) => {
            if (languageSupport) {
                view.dispatch({
                    effects: languageSupportCompartment.reconfigure(languageSupport)
                });
            }
        })
    }

    return {
        update(update: ViewUpdate) {
            const oldConfig = update.startState.facet(CodeblockFacet);
            const newConfig = update.state.facet(CodeblockFacet);
            // TODO: properly notify language server of file change

            // Handle path changes
            if (oldConfig.file !== newConfig.file) {
                ({ fs, file } = newConfig);
                openFile(file)
            }

            // Handle document changes for saving
            else if (update.docChanged && oldConfig.file === newConfig.file) {
                save();
            }
        },
        destroy() {
            console.log('Destroying codeblock view plugin');
            abortController.abort(); // Stop the watcher
        }
    };
});

export type CreateCodeblockArgs = {
    parent: HTMLElement;
    fs: Fs;
    file?: string;
    content?: string;
    cwd?: string;
    toolbar?: boolean;
    index?: SearchIndex;
    language?: keyof typeof extToLanguageMap
}

export const basicSetup: Extension = (() => [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap
    ])
])()

// Simplified API for creating a codeblock
export function createCodeblock({
    parent,
    fs,
    file,
    language = 'markdown',
    content = '',
    cwd = '/',
    toolbar = true,
    index }: CreateCodeblockArgs) {
    const state = EditorState.create({
        doc: content,
        extensions: [
            basicSetup,
            codeblock({ content, fs, file, cwd, language, toolbar, index })
        ]
    });

    return new EditorView({ state, parent });
}
