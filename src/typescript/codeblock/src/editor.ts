import { Compartment, EditorState, Extension, Facet, StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, keymap, KeyBinding, showPanel, tooltips, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from "@codemirror/view";
import { debounce } from "lodash";
import { codeblockTheme } from "./themes/index";
import { vscodeLightDark, vscodeStyleMod } from "./themes/vscode";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { detectIndentationUnit } from "./utils";
import { completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { VfsInterface } from "./types";
import { ExtensionOrLanguage, extOrLanguageToLanguageId, getLanguageSupport } from "./lsps";
import { lintKeymap } from "@codemirror/lint";
import { highlightCode } from "@lezer/highlight";
import { SearchIndex } from "./utils/search";
import { LSP, FileChangeType } from "./utils/lsp";
import { prefillTypescriptDefaults, getCachedLibFiles, TypescriptDefaultsConfig } from "./utils/typescript-defaults";
import { toolbarPanel, searchResultsField } from "./panels/toolbar";
import { settingsField } from "./panels/footer";
import { StyleModule } from "style-mod";
import { dirname } from "path-browserify";
export type { CommandResult } from "./panels/toolbar";

export type CodeblockConfig = {
    fs: VfsInterface;
    cwd?: string;
    filepath?: string;
    content?: string;
    toolbar?: boolean;
    index?: SearchIndex;
    language?: ExtensionOrLanguage;
    dark?: boolean;
    typescript?: TypescriptDefaultsConfig & {
        /** Resolves a TypeScript lib name (e.g. "es5") to its `.d.ts` file content */
        resolveLib: (name: string) => Promise<string>;
    };
};
export type CreateCodeblockArgs = CodeblockConfig & {
    parent: HTMLElement;
    content?: string;
}
export const CodeblockFacet = Facet.define<CodeblockConfig, CodeblockConfig>({
    combine: (values) => values[0]
});

// Compartments for dynamically reconfiguring extensions
export const configCompartment = new Compartment();
export const languageSupportCompartment = new Compartment();
export const languageServerCompartment = new Compartment();
export const indentationCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
export const lineWrappingCompartment = new Compartment();

// Effects + Fields for async file handling
export const openFileEffect = StateEffect.define<{ path: string }>();
export const fileLoadedEffect = StateEffect.define<{ path: string; content: string; language: ExtensionOrLanguage | null }>();

// Light mode/dark mode theme toggle
export const setThemeEffect = StateEffect.define<{ dark: boolean }>();

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
export const codeblock = ({ content, fs, cwd, filepath, language, toolbar = true, index, typescript }: CodeblockConfig) => [
    configCompartment.of(CodeblockFacet.of({ content, fs, filepath, cwd, language, toolbar, index, typescript })),
    currentFileField,
    languageSupportCompartment.of([]),
    languageServerCompartment.of([]),
    indentationCompartment.of(indentUnit.of("    ")),
    readOnlyCompartment.of(EditorState.readOnly.of(false)),
    lineWrappingCompartment.of([]),
    tooltips({ position: "fixed" }),
    showPanel.of(toolbar ? toolbarPanel : null),
    settingsField,
    codeblockTheme,
    codeblockView,
    keymap.of(navigationKeymap.concat([indentWithTab])),
    vscodeLightDark,
    searchResultsField,
];

// ViewPlugin reacts to field state & effects, with microtask scheduling to avoid nested updates
// Inject @font-face for Nerd Font icons (idempotent)
let nerdFontInjected = false;
function injectNerdFontFace() {
    if (nerdFontInjected) return;
    nerdFontInjected = true;
    const style = document.createElement('style');
    style.textContent = `@font-face {
  font-family: 'UbuntuMono NF';
  src: url('/fonts/UbuntuMonoNerdFont-Regular.ttf') format('truetype');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}`;
    document.head.appendChild(style);
}

const codeblockView = ViewPlugin.define((view) => {
    StyleModule.mount(document, vscodeStyleMod);
    injectNerdFontFace();

    let { fs } = view.state.facet(CodeblockFacet);

    // Debounced save
    const save = debounce(async () => {
        const fileState = view.state.field(currentFileField);
        if (fileState.path) {
            // confirm parent exists
            const parent = dirname(fileState.path);

            if (parent) {
                await fs.mkdir(parent, { recursive: true }).catch(console.error);
            }
            await fs.writeFile(fileState.path, view.state.doc.toString()).catch(console.error)
            LSP.notifyFileChanged(fileState.path, FileChangeType.Changed);
        }
    }, 500);

    // Guard to prevent duplicate opens for same path while loading
    let opening: string | null = null;
    // Track the path of the currently loaded file for correct save-on-switch
    let activePath: string | null = view.state.field(currentFileField).path;

    async function setLanguageSupport(language: ExtensionOrLanguage) {
        if (!language) return;
        const langSupport = await getLanguageSupport(extOrLanguageToLanguageId[language]).catch((e) => {
            console.error(`Failed to load language support for ${language}`, e);
            return null;
        });
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
        // Cancel the debounced save and manually flush the current file.
        // We can't use save.flush() because openFileEffect has already updated
        // currentFileField.path to the NEW path, but the document still holds
        // the OLD file's content. Using activePath ensures we write to the
        // correct location.
        save.cancel();
        if (activePath && view.state.field(settingsField).autosave) {
            const oldPath = activePath;
            const oldContent = view.state.doc.toString();
            const parent = dirname(oldPath);
            if (parent) await fs.mkdir(parent, { recursive: true }).catch(console.error);
            await fs.writeFile(oldPath, oldContent).catch(console.error);
            LSP.notifyFileChanged(oldPath, FileChangeType.Changed);
        }
        try {
            const ext = path.split('.').pop()?.toLowerCase();
            const lang = (ext ? (extOrLanguageToLanguageId)[ext] ?? null : language) || 'markdown';
            let langSupport = lang ? await getLanguageSupport(lang as any).catch((e) => {
                console.error(`Failed to load language support for ${lang}`, e);
                return null;
            }) : null;

            safeDispatch(view, {
                effects: [
                    languageSupportCompartment.reconfigure(langSupport || []),
                ]
            });

            const exists = await fs.exists(path);
            const content = exists ? await fs.readFile(path) : "";

            // Ensure the file exists on VFS before LSP initialization.
            // The LSP uses readDirectory to find source files and match them
            // against tsconfig. If the file doesn't exist yet, Volar falls
            // back to an inferred project that lacks lib file configuration.
            if (!exists) {
                await fs.mkdir(dirname(path), { recursive: true }).catch(() => {});
                await fs.writeFile(path, content);
                LSP.notifyFileChanged(path, FileChangeType.Created);
            }

            // Add new files to the search index so they appear in future searches
            const { index } = view.state.facet(CodeblockFacet);
            if (index) {
                index.add(path);
                if (index.savePath) index.save(fs, index.savePath);
            }
            const unit = detectIndentationUnit(content) || "    ";

            // Lazily pre-fill TypeScript lib definitions when a TS/JS file is first opened
            const tsExtensions = ['ts', 'tsx', 'js', 'jsx'];
            const { typescript } = view.state.facet(CodeblockFacet);
            let libFiles: Record<string, string> | undefined;
            if (typescript?.resolveLib && ext && tsExtensions.includes(ext)) {
                libFiles = await prefillTypescriptDefaults(fs, typescript.resolveLib, typescript);
            } else {
                libFiles = getCachedLibFiles();
            }

            let lsp: Extension | null = lang ? await LSP.client({ language: lang as any, path, fs, libFiles }) : null;

            activePath = path;
            safeDispatch(view, {
                changes: { from: 0, to: view.state.doc.length, insert: content },
                effects: [
                    indentationCompartment.reconfigure(indentUnit.of(unit)),
                    fileLoadedEffect.of({ path, content, language: lang }),
                    languageServerCompartment.reconfigure(lsp ? [lsp] : []),
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
                if (e.is(setThemeEffect)) {
                    const dark = e.value.dark;

                    u.view.dom.setAttribute('data-theme', dark ? 'dark' : 'light');
                }
            }

            // Keep read-only in sync with loading state without dispatching new transactions
            const prev = u.startState.field(currentFileField);
            const next = u.state.field(currentFileField);
            if (prev.loading !== next.loading) {
                // Reconfigure readOnly via compartment inside the same update when possible
                safeDispatch(view, { effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(next.loading)) });
            }

            if (u.docChanged && u.state.field(settingsField).autosave) save();

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

export function createCodeblock({ parent, fs, filepath, language, content = '', cwd = '/', toolbar = true, index, dark, typescript }: CreateCodeblockArgs) {
    const state = EditorState.create({
        doc: content,
        extensions: [basicSetup, codeblock({ content, fs, filepath, cwd, language, toolbar, index, dark, typescript })]
    });
    return new EditorView({ state, parent });
}