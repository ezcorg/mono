import { Compartment, EditorState, Extension, Facet, StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, keymap, KeyBinding, showPanel, tooltips, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from "@codemirror/view";
import { debounce } from "lodash";
import { codeblockTheme } from "./theme";
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { detectIndentationUnit } from "./utils";
import { completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { Fs } from "./types";
import { ExtensionOrLanguage, extOrLanguageToLanguageId, getLanguageSupport } from "./lsps";
import { documentUri, languageId } from '@marimo-team/codemirror-languageserver';
import { lintKeymap } from "@codemirror/lint";
import { highlightCode } from "@lezer/highlight";
import { SearchIndex } from "./utils/search";
import { LSP, LSPClientExtension } from "./utils/lsp";
import { toolbarPanel, searchResultsField } from "./panels/toolbar";
export type { CommandResult } from "./panels/toolbar";

export type CodeblockConfig = {
    fs: Fs;
    cwd: string;
    filepath?: string;
    content?: string;
    toolbar?: boolean;
    index?: SearchIndex;
    language?: ExtensionOrLanguage;
};
export const CodeblockFacet = Facet.define<CodeblockConfig, CodeblockConfig>({
    combine: (values) => values[0]
});

// Compartments for dynamically reconfiguring extensions
export const configCompartment = new Compartment();
export const languageSupportCompartment = new Compartment();
export const languageServerCompartment = new Compartment();
export const indentationCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();

// Effects + Fields for async file handling
export const openFileEffect = StateEffect.define<{ path: string }>();
export const fileLoadedEffect = StateEffect.define<{ path: string; content: string; language: ExtensionOrLanguage | null }>();

// Holds the current file lifecycle
export const currentFileField = StateField.define<{
    path: string | null;
    content: string;
    language: ExtensionOrLanguage | null;
    loading: boolean;
}>({
    create(state) {
        const cfg = state.facet(CodeblockFacet);
        if (cfg.filepath) {
            // Seed an initial load; the plugin will react after init without dispatching during construction
            return { path: cfg.filepath, content: "", language: null, loading: true };
        }
        // No initial file; start with provided content
        return { path: null, content: cfg.content || "", language: cfg.language || null, loading: false };
    },
    update(value, tr) {
        for (let e of tr.effects) {
            if (e.is(openFileEffect)) {
                return { path: e.value.path, content: "", language: null, loading: true };
            }
            if (e.is(fileLoadedEffect)) {
                return { path: e.value.path, content: e.value.content, language: e.value.language, loading: false };
            }
        }
        return value;
    }
});

// A safe dispatcher to avoid nested-update errors from UI events during CM updates
function safeDispatch(view: EditorView, spec: TransactionSpec) {
    // Always queue to a microtask so we never dispatch within an ongoing update cycle
    queueMicrotask(() => {
        try { view.dispatch(spec); } catch (e) { console.error(e); }
    });
}


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
    let result = document.createElement("pre");
    function emit(text, classes) {
        let node: Node = document.createTextNode(text);
        if (classes) {
            let span = document.createElement("span");
            span.appendChild(node);
            span.className = classes;
            node = span;
        }
        result.appendChild(node);
    }
    function emitBreak() { result.appendChild(document.createTextNode("\n")); }
    highlightCode(code, parser.parse(code), highlighter, emit, emitBreak);
    return result.getHTML();
};

// Main codeblock factory
export const codeblock = ({ content, fs, cwd, filepath, language, toolbar = true, index }: CodeblockConfig) => [
    configCompartment.of(CodeblockFacet.of({ content, fs, filepath, cwd, language, toolbar, index })),
    currentFileField,
    languageSupportCompartment.of([]),
    languageServerCompartment.of([]),
    indentationCompartment.of(indentUnit.of("    ")),
    readOnlyCompartment.of(EditorState.readOnly.of(false)),
    tooltips({ position: "fixed" }),
    showPanel.of(toolbar ? toolbarPanel : null),
    codeblockTheme,
    codeblockView,
    keymap.of(navigationKeymap.concat([indentWithTab])),
    vscodeDark,
    searchResultsField
];

// ViewPlugin reacts to field state & effects, with microtask scheduling to avoid nested updates
const codeblockView = ViewPlugin.define((view) => {
    let { fs } = view.state.facet(CodeblockFacet);

    // Debounced save
    const save = debounce(async () => {
        const fileState = view.state.field(currentFileField);
        if (fileState.path) await fs.writeFile(fileState.path, view.state.doc.toString()).catch(console.error);
    }, 500);

    // Guard to prevent duplicate opens for same path while loading
    let opening: string | null = null;

    async function setLanguageSupport(language: ExtensionOrLanguage) {
        if (!language) return;
        const langSupport = await getLanguageSupport(extOrLanguageToLanguageId[language]);
        console.log('got language: ', { language, langSupport })
        safeDispatch(view, {
            effects: [
                languageSupportCompartment.reconfigure(langSupport || []),
            ]
        });
    }

    async function handleOpen(path: string) {
        if (!path) return;
        if (opening === path) return;
        opening = path;
        try {
            const ext = path.split('.').pop()?.toLowerCase();
            const lang = (ext ? (extOrLanguageToLanguageId)[ext] ?? null : null) || language;
            let langSupport = lang ? await getLanguageSupport(lang as any) : null;

            safeDispatch(view, {
                effects: [
                    languageSupportCompartment.reconfigure(langSupport || []),
                ]
            });

            const exists = await fs.exists(path);
            const content = exists ? await fs.readFile(path) : "";
            const unit = detectIndentationUnit(content) || "    ";

            let lsp: LSPClientExtension | null = lang ? await LSP.client({ view, language: lang as any, path, fs }) : null;

            safeDispatch(view, {
                changes: { from: 0, to: view.state.doc.length, insert: content },
                effects: [
                    indentationCompartment.reconfigure(indentUnit.of(unit)),
                    fileLoadedEffect.of({ path, content, language: lang }),
                    languageServerCompartment.reconfigure([
                        documentUri.of(`file:///${path}`),
                        languageId.of((lang as string) || ""),
                        ...(lsp ? [lsp] : [])
                    ]),
                ]
            });
        } catch (e) {
            console.error("Failed to open file", e);
        } finally {
            opening = null;
        }
    }

    // On initial mount, if field indicates a pending load, kick it off *after* construction
    const { path, loading, language } = view.state.field(currentFileField);

    if (!path && language) {
        setLanguageSupport(language);
    }

    if (path && loading) {
        handleOpen(path);
    }

    return {
        update(u: ViewUpdate) {
            // React to explicit openFileEffect requests
            for (let e of u.transactions.flatMap(t => t.effects)) {
                if (e.is(openFileEffect)) queueMicrotask(() => handleOpen(e.value.path));
            }

            // Keep read-only in sync with loading state without dispatching new transactions
            const prev = u.startState.field(currentFileField);
            const next = u.state.field(currentFileField);
            if (prev.loading !== next.loading) {
                // Reconfigure readOnly via compartment inside the same update when possible
                safeDispatch(view, { effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(next.loading)) });
            }

            if (u.docChanged) save();

            // If fs changed via facet reconfig, refresh handle references
            const newFs = u.state.facet(CodeblockFacet).fs;
            if (fs !== newFs) fs = newFs;
        }
    };
});

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
])();

export type CreateCodeblockArgs = {
    parent: HTMLElement;
    fs: Fs;
    filepath?: string;
    content?: string;
    cwd?: string;
    toolbar?: boolean;
    index?: SearchIndex;
    language?: ExtensionOrLanguage;
};

export function createCodeblock({ parent, fs, filepath, language, content = '', cwd = '/', toolbar = true, index }: CreateCodeblockArgs) {
    const state = EditorState.create({
        doc: content,
        extensions: [basicSetup, codeblock({ content, fs, filepath, cwd, language, toolbar, index })]
    });
    return new EditorView({ state, parent });
}