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
import { lintKeymap, setDiagnostics } from "@codemirror/lint";
import { highlightCode } from "@lezer/highlight";
import { SearchIndex } from "./utils/search";
import { LSP, FileChangeType } from "./utils/lsp";
import { prefillTypescriptDefaults, getCachedLibFiles, TypescriptDefaultsConfig } from "./utils/typescript-defaults";
import { toolbarPanel, searchResultsField, registerFileAction } from "./panels/toolbar";
import { settingsField, updateSettingsEffect, resolveThemeDark, InitialSettingsFacet } from "./panels/settings";
import type { EditorSettings } from "./panels/settings";
import { StyleModule } from "style-mod";
import { dirname } from "path-browserify";
export type { CommandResult, BrowseEntry } from "./panels/toolbar";

// --- File change notification bus for multi-view sync ---
type FileChangeListener = {
    view: EditorView;
    callback: (content: string) => void;
};

class FileChangeBus {
    private listeners: Map<string, Set<FileChangeListener>> = new Map();

    subscribe(path: string, view: EditorView, callback: (content: string) => void): () => void {
        let set = this.listeners.get(path);
        if (!set) {
            set = new Set();
            this.listeners.set(path, set);
        }
        const listener = { view, callback };
        set.add(listener);
        return () => {
            set!.delete(listener);
            if (set!.size === 0) this.listeners.delete(path);
        };
    }

    /** Notify all listeners for `path` except the source view. */
    notify(path: string, content: string, sourceView: EditorView) {
        const set = this.listeners.get(path);
        if (!set) return;
        for (const listener of set) {
            if (listener.view !== sourceView) {
                listener.callback(content);
            }
        }
    }
}

export const fileChangeBus = new FileChangeBus();

// --- Settings propagation across editors on the same page ---
type SettingsChangeCallback = (settings: Partial<import("./panels/settings").EditorSettings>) => void;

class SettingsChangeBus {
    private listeners = new Set<{ view: EditorView; callback: SettingsChangeCallback }>();

    subscribe(view: EditorView, callback: SettingsChangeCallback): () => void {
        const entry = { view, callback };
        this.listeners.add(entry);
        return () => this.listeners.delete(entry);
    }

    notify(settings: Partial<import("./panels/settings").EditorSettings>, sourceView: EditorView) {
        for (const entry of this.listeners) {
            if (entry.view !== sourceView) {
                entry.callback(settings);
            }
        }
    }
}

export const settingsChangeBus = new SettingsChangeBus();

export type CodeblockConfig = {
    fs: VfsInterface;
    cwd?: string;
    filepath?: string;
    content?: string;
    toolbar?: boolean;
    index?: SearchIndex;
    language?: ExtensionOrLanguage;
    dark?: boolean;
    settings?: Partial<EditorSettings>;
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
export const terminalCompartment = new Compartment();
export const lineNumbersCompartment = new Compartment();
export const foldGutterCompartment = new Compartment();

// Effects + Fields for async file handling
export const openFileEffect = StateEffect.define<{ path: string; skipSave?: boolean }>();
export const fileLoadedEffect = StateEffect.define<{ path: string; content: string; language: ExtensionOrLanguage | null }>();

// Light mode/dark mode theme toggle
export const setThemeEffect = StateEffect.define<{ dark: boolean }>();

// SVG preview toggle
export const toggleSvgPreviewEffect = StateEffect.define<void>();

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
export const codeblock = ({ content, fs, cwd, filepath, language, toolbar = true, index, dark, settings, typescript }: CodeblockConfig) => {
    // Merge dark flag into initial settings for backward compat
    const resolvedSettings: Partial<EditorSettings> = { ...settings };
    if (dark !== undefined && !('theme' in resolvedSettings)) {
        resolvedSettings.theme = dark ? 'dark' : 'light';
    }
    const showLineNums = resolvedSettings.showLineNumbers !== false; // default true
    const showFold = resolvedSettings.showFoldGutter !== false; // default true

    return [
        configCompartment.of(CodeblockFacet.of({ content, fs, filepath, cwd, language, toolbar, index, dark, settings, typescript })),
        InitialSettingsFacet.of(resolvedSettings),
        currentFileField,
        languageSupportCompartment.of([]),
        languageServerCompartment.of([]),
        indentationCompartment.of(indentUnit.of("    ")),
        readOnlyCompartment.of(EditorState.readOnly.of(false)),
        lineWrappingCompartment.of([]),
        terminalCompartment.of([]),
        lineNumbersCompartment.of(showLineNums ? [lineNumbers(), highlightActiveLineGutter()] : []),
        foldGutterCompartment.of(showFold ? [foldGutter()] : []),
        tooltips({ position: "fixed" }),
        showPanel.of(toolbar ? toolbarPanel : null),
        settingsField,
        codeblockTheme,
        codeblockView,
        keymap.of(navigationKeymap.concat([indentWithTab])),
        vscodeLightDark,
        searchResultsField,
    ];
};

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

    // Flag to suppress save when receiving external file updates
    let receivingExternalUpdate = false;
    // Flag to suppress re-broadcast when receiving settings from another editor
    let receivingExternalSettings = false;
    // Subscription cleanup for file change notifications
    let unsubscribeFileChanges: (() => void) | null = null;

    // Subscribe to settings changes from other editors
    const unsubscribeSettings = settingsChangeBus.subscribe(view, (partial) => {
        receivingExternalSettings = true;
        try {
            const effects: StateEffect<any>[] = [updateSettingsEffect.of(partial)];
            if ('theme' in partial && partial.theme) {
                effects.push(setThemeEffect.of({ dark: resolveThemeDark(partial.theme) }));
            }
            if ('lineWrap' in partial) {
                effects.push(lineWrappingCompartment.reconfigure(partial.lineWrap ? EditorView.lineWrapping : []));
            }
            if ('showLineNumbers' in partial) {
                effects.push(lineNumbersCompartment.reconfigure(partial.showLineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : []));
            }
            if ('showFoldGutter' in partial) {
                effects.push(foldGutterCompartment.reconfigure(partial.showFoldGutter ? [foldGutter()] : []));
            }
            // autoHideToolbar is handled by the toolbar panel's JS event handlers,
            // not CSS classes — the updateSettingsEffect propagation is sufficient.
            view.dispatch({ effects });
        } finally {
            receivingExternalSettings = false;
        }
    });

    // Debounced save
    const save = debounce(async () => {
        const fileState = view.state.field(currentFileField);
        if (fileState.path) {
            const content = view.state.doc.toString();
            // confirm parent exists
            const parent = dirname(fileState.path);

            if (parent) {
                await fs.mkdir(parent, { recursive: true }).catch(console.error);
            }
            await fs.writeFile(fileState.path, content).catch(console.error)
            LSP.notifyFileChanged(fileState.path, FileChangeType.Changed);

            // Notify other views of the same file
            fileChangeBus.notify(fileState.path, content, view);
        }
    }, 500);

    // Subscribe to external file changes for the given path
    function subscribeToFileChanges(path: string) {
        // Unsubscribe from previous file
        if (unsubscribeFileChanges) {
            unsubscribeFileChanges();
            unsubscribeFileChanges = null;
        }
        unsubscribeFileChanges = fileChangeBus.subscribe(path, view, (newContent) => {
            const currentContent = view.state.doc.toString();
            if (newContent === currentContent) return; // No change
            receivingExternalUpdate = true;
            try {
                view.dispatch({
                    changes: { from: 0, to: view.state.doc.length, insert: newContent }
                });
            } finally {
                receivingExternalUpdate = false;
            }
        });
    }

    // Guard to prevent duplicate opens for same path while loading
    let opening: string | null = null;
    // Track the path of the currently loaded file for correct save-on-switch.
    // Only set AFTER a file has actually been loaded (not during initial loading state).
    const initialFile = view.state.field(currentFileField);
    let activePath: string | null = (initialFile.loading) ? null : initialFile.path;
    // Preview element for images/SVGs
    let previewEl: HTMLElement | null = null;
    let svgViewMode: 'preview' | 'source' = 'preview';

    const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
    const SVG_EXTENSION = 'svg';

    function hideScroller() {
        const scroller = view.dom.querySelector('.cm-scroller') as HTMLElement;
        if (scroller) {
            // CodeMirror sets `display: flex !important` on .cm-scroller,
            // so we can't use display:none. Hide via collapse instead.
            scroller.style.visibility = 'hidden';
            scroller.style.height = '0';
            scroller.style.overflow = 'hidden';
            scroller.style.position = 'absolute';
        }
    }

    function showScroller() {
        const scroller = view.dom.querySelector('.cm-scroller') as HTMLElement;
        if (scroller) {
            scroller.style.visibility = '';
            scroller.style.height = '';
            scroller.style.overflow = '';
            scroller.style.position = '';
        }
    }

    function removePreview() {
        if (previewEl) {
            previewEl.remove();
            previewEl = null;
        }
        svgViewMode = 'preview';
        showScroller();
    }

    function showImagePreview(content: string) {
        removePreview();
        previewEl = document.createElement('div');
        previewEl.className = 'cm-image-preview';
        previewEl.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:16px;min-height:200px;overflow:auto;background:var(--cm-background, #1e1e1e);';

        const img = document.createElement('img');
        if (content.startsWith('data:') || content.startsWith('http') || content.startsWith('blob:')) {
            img.src = content;
        } else {
            const msg = document.createElement('div');
            msg.style.cssText = 'color:var(--cm-toolbar-color, #ccc);text-align:center;';
            msg.textContent = 'Image preview unavailable (import from disk to view)';
            previewEl.appendChild(msg);
            view.dom.appendChild(previewEl);
            return;
        }
        img.style.maxWidth = '100%';
        img.style.maxHeight = '400px';
        img.style.objectFit = 'contain';
        previewEl.appendChild(img);

        hideScroller();
        view.dom.appendChild(previewEl);
    }

    function renderSvgInto(container: HTMLElement, content: string) {
        container.innerHTML = '';
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(content, 'image/svg+xml');
            const svgEl = doc.documentElement;
            if (svgEl.tagName === 'svg') {
                svgEl.style.maxWidth = '100%';
                svgEl.style.maxHeight = '300px';
                svgEl.removeAttribute('width');
                svgEl.removeAttribute('height');
                container.appendChild(document.importNode(svgEl, true));
            } else {
                container.textContent = 'Invalid SVG';
                container.style.color = 'var(--cm-toolbar-color, #ccc)';
            }
        } catch {
            container.textContent = 'SVG parse error';
            container.style.color = 'var(--cm-toolbar-color, #ccc)';
        }
    }

    function showSvgView(content: string, mode: 'preview' | 'source') {
        removePreview();
        svgViewMode = mode;

        previewEl = document.createElement('div');
        previewEl.className = 'cm-svg-preview';

        if (mode === 'preview') {
            // Preview mode: hide editor, show rendered SVG
            hideScroller();
            previewEl.style.cssText = 'padding:16px;display:flex;align-items:center;justify-content:center;overflow:auto;background:var(--cm-background, #1e1e1e);min-height:200px;';
            renderSvgInto(previewEl, content);
        } else {
            // Source mode: show editor, hide preview
            showScroller();
            previewEl.style.display = 'none';
        }
        view.dom.appendChild(previewEl);
    }

    function updateSvgPreview() {
        if (!previewEl || !previewEl.classList.contains('cm-svg-preview') || previewEl.style.display === 'none') return;
        renderSvgInto(previewEl, view.state.doc.toString());
    }

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
            const tsExtensions = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];
            const { typescript } = view.state.facet(CodeblockFacet);
            let libFiles: Record<string, string> | undefined;
            if (typescript?.resolveLib && ext && tsExtensions.includes(ext)) {
                libFiles = await prefillTypescriptDefaults(fs, typescript.resolveLib, typescript);
            } else {
                libFiles = getCachedLibFiles();
            }

            let lsp: Extension | null = null;
            if (lang) {
                try {
                    lsp = await LSP.client({ language: lang as any, path, fs, libFiles });
                } catch (lspErr) {
                    // Gracefully degrade when LSP is unavailable (e.g. missing worker, test environment)
                    console.warn("LSP unavailable for this view:", lspErr);
                }
            }

            activePath = path;

            // Check for image/SVG files
            const isRasterImage = ext ? IMAGE_EXTENSIONS.has(ext) : false;
            const isSvg = ext === SVG_EXTENSION;

            // Clear stale diagnostics from previous file
            safeDispatch(view, setDiagnostics(view.state, []));

            if (isRasterImage) {
                // Raster image: show preview, hide editor content
                safeDispatch(view, {
                    changes: { from: 0, to: view.state.doc.length, insert: content },
                    effects: [
                        fileLoadedEffect.of({ path, content, language: null }),
                        readOnlyCompartment.reconfigure(EditorState.readOnly.of(true)),
                    ]
                });
                showImagePreview(content);
            } else {
                // Remove any existing preview
                removePreview();

                safeDispatch(view, {
                    changes: { from: 0, to: view.state.doc.length, insert: content },
                    effects: [
                        indentationCompartment.reconfigure(indentUnit.of(unit)),
                        fileLoadedEffect.of({ path, content, language: lang }),
                        languageServerCompartment.reconfigure(lsp ? [lsp] : []),
                    ]
                });

                // SVG: show live preview below the editor
                if (isSvg) {
                    showSvgView(content, 'preview');
                }
            }

            // Subscribe to changes from other views of the same file
            subscribeToFileChanges(path);
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
                if (e.is(openFileEffect)) {
                    // Cancel debounced save immediately to prevent it from writing
                    // the old document content to the wrong (new) file path
                    save.cancel();
                    if (e.value.skipSave) {
                        // Caller already handled file operations (e.g. rename) —
                        // clear activePath so handleOpen won't save-on-switch
                        activePath = null;
                    }
                    queueMicrotask(() => handleOpen(e.value.path));
                }
                if (e.is(setThemeEffect)) {
                    const dark = e.value.dark;
                    u.view.dom.setAttribute('data-theme', dark ? 'dark' : 'light');
                }
                if (e.is(toggleSvgPreviewEffect)) {
                    const newMode = svgViewMode === 'preview' ? 'source' : 'preview';
                    showSvgView(view.state.doc.toString(), newMode);
                }
            }

            // Keep read-only in sync with loading state without dispatching new transactions
            const prev = u.startState.field(currentFileField);
            const next = u.state.field(currentFileField);
            if (prev.loading !== next.loading) {
                // Reconfigure readOnly via compartment inside the same update when possible
                safeDispatch(view, { effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(next.loading)) });
            }

            if (u.docChanged && !receivingExternalUpdate && u.state.field(settingsField).autosave) save();

            // Live SVG preview update
            if (u.docChanged && previewEl?.classList.contains('cm-svg-preview')) {
                updateSvgPreview();
            }

            // Broadcast settings changes to other editors (unless we received them externally)
            const prevSettings = u.startState.field(settingsField);
            const nextSettings = u.state.field(settingsField);
            if (prevSettings !== nextSettings && !receivingExternalSettings) {
                // Compute the diff
                const diff: Record<string, any> = {};
                for (const key of Object.keys(nextSettings) as (keyof typeof nextSettings)[]) {
                    if (prevSettings[key] !== nextSettings[key]) {
                        diff[key] = nextSettings[key];
                    }
                }
                if (Object.keys(diff).length > 0) {
                    settingsChangeBus.notify(diff, view);
                }
            }

            // If fs changed via facet reconfig, refresh handle references
            const newFs = u.state.facet(CodeblockFacet).fs;
            if (fs !== newFs) fs = newFs;
        },
        destroy() {
            if (unsubscribeFileChanges) {
                unsubscribeFileChanges();
                unsubscribeFileChanges = null;
            }
            unsubscribeSettings();
            removePreview();
            save.cancel();
        }
    };
});

export const basicSetup: Extension = (() => [
    highlightSpecialChars(),
    history(),
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

export function createCodeblock({ parent, fs, filepath, language, content = '', cwd = '/', toolbar = true, index, dark, settings, typescript }: CreateCodeblockArgs) {
    const state = EditorState.create({
        doc: content,
        extensions: [basicSetup, codeblock({ content, fs, filepath, cwd, language, toolbar, index, dark, settings, typescript })]
    });
    const view = new EditorView({ state, parent });
    return view;
}

// --- File-extension-specific toolbar commands ---

registerFileAction({
    extensions: ['svg'],
    label: 'SVG > Toggle preview',
    icon: '\udb82\ude1b', // nf-md-image_outline (󰈛)
    action: (view) => view.dispatch({ effects: toggleSvgPreviewEffect.of(undefined) }),
});