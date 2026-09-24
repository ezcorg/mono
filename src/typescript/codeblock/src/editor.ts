import { Compartment, EditorState, Extension, Facet, StateEffect, StateField, Transaction, TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate, keymap, KeyBinding, showPanel, tooltips, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from "@codemirror/view";
import { debounce } from "lodash";
import { codeblockTheme } from "./themes/index";
import { vscodeLightDark, vscodeStyleMod } from "./themes/vscode";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { detectIndentationUnit } from "./utils";
import { completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { conflictCopyPath, type FileOperations, type FileSearch, type VersionLog, type VfsInterface } from "@joinezco/storage";

/** What a code block needs of a version log (a vault's `versions`). */
export type FileVersions = Pick<VersionLog, 'head' | 'put' | 'read'>;
import { ExtensionOrLanguage, extOrLanguageToLanguageId, getLanguageSupport } from "./lsps";
import { lintKeymap, setDiagnostics } from "@codemirror/lint";
import { highlightCode } from "@lezer/highlight";
import { LSP, FileChangeType } from "./utils/lsp";
import { prefillTypescriptDefaults, getCachedLibFiles, TypescriptDefaultsConfig } from "./utils/typescript-defaults";
import { toolbarPanel, searchResultsField, registerFileAction } from "./panels/toolbar";
import { copyButtonExtension } from "./panels/copy-button";
import { settingsField, updateSettingsEffect, resolveThemeDark, InitialSettingsFacet } from "./panels/settings";
import type { EditorSettings } from "./panels/settings";
import { createAiExtension, reconfigureAi } from "./ai/extension";
import { contextMenu } from "./context-menu";
import { navigationHistory } from "./navigation";
import { StyleModule } from "style-mod";
import { dirname } from "path-browserify";
import { clampRange, findRegion, followRange, lineCount, rangeOf, sliceLines, spliceLines, type LineRange } from "./utils/region";
export type { CommandResult, BrowseEntry } from "./panels/toolbar";

// --- File change notification bus for multi-view sync ---
type FileChangeListener = {
    view: EditorView;
    /** The file's new text, and the version it is when saved through a log. */
    callback: (content: string, version?: string) => void;
};

class FileChangeBus {
    private listeners: Map<string, Set<FileChangeListener>> = new Map();

    subscribe(path: string, view: EditorView, callback: (content: string, version?: string) => void): () => void {
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
    notify(path: string, content: string, sourceView: EditorView, version?: string) {
        const set = this.listeners.get(path);
        if (!set) return;
        for (const listener of set) {
            if (listener.view !== sourceView) {
                listener.callback(content, version);
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
    /** How the toolbar lays out its icon column. `gutter` (default) sizes the search glyph and the result icons to the
     *  editor's line-number gutter so they line up with the code (the look inside the markdown-editor); `compact` keeps
     *  them tight to the text, for a toolbar hosted away from the editor — a window's title bar, say. */
    toolbarLayout?: 'gutter' | 'compact';
    /** Finds files for the toolbar (a vault's search). */
    search?: FileSearch;
    /** Creates, moves and deletes files for the toolbar (a vault's keep links working). */
    files?: FileOperations;
    /** Loads and saves go through this log when given: a save names the
     *  version it was made on, and one made on a stale version becomes a
     *  conflict copy beside the file (see `FileEvent`'s `conflict`). */
    versions?: FileVersions;
    /** Show and edit only these lines of `filepath` (a region, as a note's
     *  ```` ```src/lib.rs#L40-L80 ```` fence is). The file is the source of
     *  truth: the lines are read from it (found again by `content`, the
     *  region's text as last seen, when they have moved), and an edit is
     *  put back where they are when it is saved. `regionField` has where
     *  they are now. */
    range?: LineRange;
    language?: ExtensionOrLanguage;
    dark?: boolean;
    settings?: Partial<EditorSettings>;
    typescript?: TypescriptDefaultsConfig & {
        /** Resolves a TypeScript lib name (e.g. "es5") to its `.d.ts` file content */
        resolveLib: (name: string) => Promise<string>;
    };
    /** Show a hover-revealed copy-to-clipboard button in the top-right
     *  of the editor. Particularly useful for short shell snippets where
     *  the editor acts as a "code to run" rather than a workspace.
     *  When unset, defaults to `true` for `.sh` files and `false`
     *  otherwise. */
    copyButton?: boolean;
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
export const lineWrappingCompartment = new Compartment();
export const lineNumbersCompartment = new Compartment();
export const foldGutterCompartment = new Compartment();

// Effects + Fields for async file handling
export const openFileEffect = StateEffect.define<{ path: string; skipSave?: boolean }>();
/** A file's contents arrived. `preview` marks a file shown rather than
 *  edited (an image, or bytes that are not text): read-only, never written. */
export const fileLoadedEffect = StateEffect.define<{ path: string; content: string; language: ExtensionOrLanguage | null; preview?: boolean }>();
/** Put the open file down without writing its unsaved edits (it is being
 *  deleted): the view is left empty, showing no file. */
export const closeFileEffect = StateEffect.define<void>();

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
    /** Shown rather than edited (an image, or bytes that are not text):
     *  read-only, never written. */
    preview: boolean;
}>({
    create(state) {
        const cfg = state.facet(CodeblockFacet);
        if (cfg.filepath) {
            // Seed an initial load; the plugin will react after init without dispatching during construction
            return { path: cfg.filepath, content: "", language: null, loading: true, preview: false };
        }
        // No initial file; start with provided content
        return { path: null, content: cfg.content || "", language: cfg.language || null, loading: false, preview: false };
    },
    update(value, tr) {
        for (let e of tr.effects) {
            if (e.is(openFileEffect)) {
                return { path: e.value.path, content: "", language: null, loading: true, preview: false };
            }
            if (e.is(fileLoadedEffect)) {
                return { path: e.value.path, content: e.value.content, language: e.value.language, loading: false, preview: !!e.value.preview };
            }
            if (e.is(closeFileEffect)) {
                return { path: null, content: "", language: value.language, loading: false, preview: false };
            }
        }
        return value;
    }
});

/** Which lines of the file the view shows, as they are numbered in the file
 *  now (a region: `CodeblockConfig.range`), or null for the whole file. */
export const setRegionEffect = StateEffect.define<LineRange | null>();
export const regionField = StateField.define<LineRange | null>({
    create(state) {
        const cfg = state.facet(CodeblockFacet);
        return cfg.filepath && cfg.range ? cfg.range : null;
    },
    update(value, tr) {
        for (const e of tr.effects) {
            if (e.is(setRegionEffect)) value = e.value;
            // Another file is opened whole; a region belongs to its file.
            else if (e.is(openFileEffect) && e.value.path !== tr.startState.field(currentFileField).path) value = null;
            else if (e.is(closeFileEffect)) value = null;
        }
        return value;
    },
});

/** The line-number gutter, which numbers a region's lines as the file does. */
export function numberedLines(): Extension {
    return [
        lineNumbers({ formatNumber: (n, state) => String(n + (state.field(regionField, false)?.from ?? 1) - 1) }),
        highlightActiveLineGutter(),
    ];
}

/** Nothing can be typed into a file that is still loading, or one only shown. */
const fileReadOnly = EditorState.readOnly.compute([currentFileField], (state) => {
    const file = state.field(currentFileField);
    return file.loading || file.preview;
});

/** `bytes` as UTF-8 text, or null when they are not text (a NUL early on,
 *  or a sequence that is not UTF-8): such a file is shown, not edited, since
 *  decoding it would change it and saving would write the change back. */
export function textOf(bytes: Uint8Array): string | null {
    if (bytes.subarray(0, 8192).includes(0)) return null;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

const persisters = new WeakMap<EditorView, () => Promise<void>>();

/** What happens to the file a code block shows: `load`, its contents are in
 *  the view (editable, unless it is only shown); `save`, a write of its
 *  edits has landed; `close`, it was put down unsaved (`closeFile`);
 *  `error`, it could not be opened or a save failed (the edits stay
 *  unsaved). */
export type FileEvent =
    | { type: 'load' | 'save' | 'close'; path: string }
    /** A save was refused (the file changed since it was loaded): the edits
     *  are at `copy`, and the view now shows the file as it is. */
    | { type: 'conflict'; path: string; copy: string }
    | { type: 'error'; path: string; error: unknown };

const fileListeners = new WeakMap<EditorView, Set<(event: FileEvent) => void>>();

function emitFileEvent(view: EditorView, event: FileEvent) {
    for (const listener of fileListeners.get(view) ?? []) listener(event);
}

/** Be told when `view` loads or saves a file. Returns an unsubscribe. */
export function onFileEvent(view: EditorView, listener: (event: FileEvent) => void): () => void {
    let listeners = fileListeners.get(view);
    if (!listeners) fileListeners.set(view, (listeners = new Set()));
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Put down the file open in `view` without writing its unsaved edits
 *  (it is being deleted): the view is left empty, showing no file. */
export function closeFile(view: EditorView): void {
    const clearDiag = setDiagnostics(view.state, []);
    view.dispatch({
        ...clearDiag,
        changes: { from: 0, to: view.state.doc.length, insert: '' },
        effects: [
            ...(clearDiag.effects ? [clearDiag.effects].flat() : []),
            closeFileEffect.of(undefined),
            languageServerCompartment.reconfigure([]),
        ],
        annotations: Transaction.addToHistory.of(false),
    });
}

/** Resolves once `view` shows `path` loaded (at once when it already does);
 *  without a path, once it shows any file. Rejects if opening it fails. */
export function whenFileLoaded(view: EditorView, path?: string): Promise<void> {
    const shows = (file: { path: string | null; loading: boolean }) => !!file.path && !file.loading && (!path || file.path === path);
    if (shows(view.state.field(currentFileField))) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const stop = onFileEvent(view, (event) => {
            if (event.type !== 'load' && event.type !== 'error') return;
            if (path && event.path !== path) return;
            stop();
            if (event.type === 'error') reject(event.error);
            else resolve();
        });
    });
}

/** Write the file open in `view` now if it has unsaved edits (autosave on or
 *  off), and resolve once every write of it already started has landed. */
export function persistFile(view: EditorView): Promise<void> {
    return persisters.get(view)?.() ?? Promise.resolve();
}

/** Whether a transaction is the user's (or a command's) edit, as opposed to
 *  a file's contents arriving or another view's save being mirrored. */
const isLoad = (tr: Transaction) => tr.effects.some((e) => e.is(fileLoadedEffect) || e.is(closeFileEffect));

// A safe dispatcher to avoid nested-update errors from UI events during CM updates.
// A spec that depends on the document (a range to replace) is given as a
// function, so it is computed against the state it is applied to: other
// dispatches may land before the microtask runs.
export function safeDispatch(view: EditorView, spec: TransactionSpec | (() => TransactionSpec)) {
    // Always queue to a microtask so we never dispatch within an ongoing update cycle
    queueMicrotask(() => {
        try { view.dispatch(typeof spec === 'function' ? spec() : spec); } catch (e) { console.error(e); }
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
export const codeblock = ({ content, fs, cwd, filepath, range, language, toolbar = true, toolbarLayout, search, files, versions, dark, settings, typescript, copyButton }: CodeblockConfig) => {
    // Merge dark flag into initial settings for backward compat
    const resolvedSettings: Partial<EditorSettings> = { ...settings };
    if (dark !== undefined && !('theme' in resolvedSettings)) {
        resolvedSettings.theme = dark ? 'dark' : 'light';
    }
    const showLineNums = resolvedSettings.showLineNumbers !== false; // default true
    const showFold = resolvedSettings.showFoldGutter !== false; // default true
    const wrapLines = resolvedSettings.lineWrap === true; // default false
    // Default-on for .sh; opt-in for everything else.
    const wantsCopyButton = copyButton ?? /\.sh$/i.test(filepath ?? '');

    return [
        configCompartment.of(CodeblockFacet.of({ content, fs, filepath, range, cwd, language, toolbar, toolbarLayout, search, files, versions, dark, settings, typescript })),
        InitialSettingsFacet.of(resolvedSettings),
        currentFileField,
        regionField,
        languageSupportCompartment.of([]),
        languageServerCompartment.of([]),
        indentationCompartment.of(indentUnit.of("    ")),
        fileReadOnly,
        // Honour the initial `lineWrap` setting (consistent with
        // showLineNumbers/showFoldGutter above); the settings panel later
        // reconfigures this same compartment to toggle it.
        lineWrappingCompartment.of(wrapLines ? EditorView.lineWrapping : []),
        lineNumbersCompartment.of(showLineNums ? numberedLines() : []),
        foldGutterCompartment.of(showFold ? [foldGutter()] : []),
        tooltips({ position: "fixed" }),
        showPanel.of(toolbar ? toolbarPanel : null),
        settingsField,
        createAiExtension({ agentUrl: resolvedSettings.agentUrl || '', model: resolvedSettings.aiModel || 'sonnet' }),
        codeblockTheme,
        codeblockView,
        contextMenu(),
        navigationHistory(),
        keymap.of(navigationKeymap.concat([indentWithTab])),
        vscodeLightDark,
        searchResultsField,
        ...(wantsCopyButton ? [copyButtonExtension] : []),
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

    let { fs, versions } = view.state.facet(CodeblockFacet);
    // The version the open file's text was loaded or last saved as, when
    // saves go through a version log.
    let version: string | null = null;

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
                effects.push(lineNumbersCompartment.reconfigure(partial.showLineNumbers ? numberedLines() : []));
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

    // Edits not yet written to the open file. Set by the user's edits, never
    // by a file's contents arriving, so opening and leaving a file (an image,
    // a file with CRLFs) writes nothing.
    let dirty = false;

    // Writes of the open file, one after another (a later save never lands
    // before an earlier one), awaitable as a whole by `persistFile`.
    let writing: Promise<void> = Promise.resolve();

    // For a region: the whole file as it was last loaded or saved, and where
    // the region's lines are in it. The region field mirrors `region`.
    let shown: string | null = null;
    let region: LineRange | null = null;

    /** The file's text now and its version (with a log), or null for a
     *  file that is gone or is not text. */
    async function current(path: string): Promise<{ text: string | null; version: string | null }> {
        if (versions) {
            const head = await versions.head(path);
            return { text: head ? textOf(await versions.read(head)) : null, version: head?.id ?? null };
        }
        return { text: await fs.readFile(path).catch(() => null), version: null };
    }

    /** Write `text`, the view's document, as `path`: the whole file, or for
     *  a region, the file with the region's lines put where they are now. */
    async function store(path: string, text: string, leaving = false): Promise<void> {
        const parent = dirname(path);
        if (parent && parent !== '.') {
            await fs.mkdir(parent, { recursive: true }).catch(console.error);
        }
        let content = text;
        let base = version;
        // The whole file a region's latest lines would make (a conflict
        // copy's contents), and where the region is once written.
        let whole = (lines: string) => lines;
        let placed: LineRange | null = null;
        let lost = false;
        try {
            if (region && shown !== null) {
                // When the file has changed since it was shown, the edit goes
                // where the region's lines are now; when those lines are what
                // changed, it is a conflict.
                let into = shown;
                let at = region;
                const now = await current(path);
                if (now.text === shown) base = versions ? now.version : base;
                else if (now.text !== null || versions) {
                    const moved = now.text === null ? null : followRange(shown, now.text, region);
                    if (moved) {
                        into = now.text!;
                        at = moved;
                        base = now.version;
                    } else lost = true;
                }
                whole = (lines) => spliceLines(into, at, lines);
                content = whole(text);
                placed = rangeOf(at.from, text);
            }
            if (versions) {
                const result = await versions.put(path, base, content);
                if (result.ok === false) return conflicted(path, text, result.conflict.path, whole);
                version = result.version.id;
            } else if (lost) {
                const copy = await conflictCopyPath(fs, path);
                await fs.writeFile(copy, content);
                return conflicted(path, text, copy, whole);
            } else {
                await fs.writeFile(path, content);
            }
        } catch (error) {
            console.error(`Failed to save ${path}`, error);
            // Still unsaved: the next edit, switch or persist tries again.
            if (view.state.field(currentFileField).path === path) dirty = true;
            emitFileEvent(view, { type: 'error', path, error });
            return;
        }
        if (placed) {
            shown = content;
            region = placed;
            const file = view.state.field(currentFileField);
            if (file.path === path && !file.loading) safeDispatch(view, { effects: setRegionEffect.of(placed) });
        }
        if (leaving) LSP.notifyFileChanged(path, FileChangeType.Changed);
        // The OPEN document is now persisted → send textDocument/didSave. This is what
        // triggers on-save analysis (rust-analyzer's cargo-check/flycheck: unresolved-name,
        // borrow, and other errors that don't run off the live edit buffer, and which
        // otherwise never update until reload). We write the disk BEFORE didSave so flycheck
        // reads current content. (didChangeWatchedFiles is for OTHER files — see below.)
        else LSP.notifyFileSaved(path, content);

        // Notify other views of the same file
        fileChangeBus.notify(path, content, view, version ?? undefined);
        emitFileEvent(view, { type: 'save', path });
    }

    /** Write the open file's unsaved edits now, if it has any. */
    const writeNow = (): Promise<void> => {
        save.cancel();
        const fileState = view.state.field(currentFileField);
        if (!fileState.path || fileState.loading || fileState.preview || !dirty) return writing;
        dirty = false;
        const path = fileState.path;
        const content = view.state.doc.toString();
        writing = writing.then(() => store(path, content));
        return writing;
    };

    /** A save of `path` was refused: the file changed since it was loaded.
     *  The edits are at `copy` (the latest of them, if typing went on; for a
     *  region, the file with them in it), and the view takes the file as it
     *  is now. */
    async function conflicted(path: string, saved: string, copy: string, whole: (lines: string) => string = (lines) => lines) {
        const open = view.state.field(currentFileField).path === path;
        const latest = view.state.doc.toString();
        if (open && latest !== saved) await fs.writeFile(copy, whole(latest)).catch(console.error);
        emitFileEvent(view, { type: 'conflict', path, copy });
        if (!open) return;
        dirty = false;
        void handleOpen(path, true);
    }

    // Debounced save
    const save = debounce(() => void writeNow(), 500);
    persisters.set(view, writeNow);

    // Subscribe to external file changes for the given path
    function subscribeToFileChanges(path: string) {
        // Unsubscribe from previous file
        if (unsubscribeFileChanges) {
            unsubscribeFileChanges();
            unsubscribeFileChanges = null;
        }
        unsubscribeFileChanges = fileChangeBus.subscribe(path, view, (newContent, newVersion) => {
            // Saved elsewhere: this view's next save is made on that version.
            if (newVersion !== undefined) version = newVersion;
            let text = newContent;
            let moved: LineRange | null = null;
            if (region && shown !== null) {
                // A region follows its lines; when they are what changed, it
                // shows the lines at its place.
                moved = followRange(shown, newContent, region) ?? clampRange(region, lineCount(newContent));
                shown = newContent;
                region = moved;
                text = sliceLines(newContent, moved);
            }
            const currentContent = view.state.doc.toString();
            const was = view.state.field(regionField);
            if (text === currentContent && (!moved || (was?.from === moved.from && was.to === moved.to))) return; // No change
            receivingExternalUpdate = true;
            try {
                view.dispatch({
                    changes: text === currentContent ? [] : { from: 0, to: view.state.doc.length, insert: text },
                    effects: moved ? setRegionEffect.of(moved) : [],
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

    let previewUrl: string | null = null;

    function removePreview() {
        if (previewEl) {
            previewEl.remove();
            previewEl = null;
        }
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
            previewUrl = null;
        }
        svgViewMode = 'preview';
        showScroller();
    }

    /** Show an image from its URL (an object URL over the file's bytes, or a
     *  data URL an older import stored as text); null when unreadable. */
    function showImagePreview(content: string | null) {
        removePreview();
        previewEl = document.createElement('div');
        previewEl.className = 'cm-image-preview';
        previewEl.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:16px;min-height:200px;overflow:auto;background:var(--cm-background, #1e1e1e);';

        const img = document.createElement('img');
        if (content && (content.startsWith('data:') || content.startsWith('http') || content.startsWith('blob:'))) {
            img.src = content;
            if (content.startsWith('blob:')) previewUrl = content;
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

    /** Say what a file that is not text is, in place of its contents. */
    function showBinaryPreview(path: string, size: number) {
        removePreview();
        previewEl = document.createElement('div');
        previewEl.className = 'cm-binary-preview';
        previewEl.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:16px;min-height:120px;color:var(--cm-toolbar-color, #ccc);';
        const name = path.split('/').pop() || path;
        const kb = size < 1024 ? `${size} bytes` : `${Math.round(size / 1024)} KB`;
        previewEl.textContent = `${name} is not text (${kb}).`;
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

    /** Start (or reuse) the language server for `path` and attach it, if
     *  the file is still the one open when it is ready. */
    async function attachLanguageServer(path: string, lang: string, ext: string | undefined, ticket: number) {
        // Lazily pre-fill TypeScript lib definitions when a TS/JS file is first opened
        const tsExtensions = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'];
        const { typescript } = view.state.facet(CodeblockFacet);
        let lsp: Extension | null = null;
        try {
            const libFiles = typescript?.resolveLib && ext && tsExtensions.includes(ext)
                ? await prefillTypescriptDefaults(fs, typescript.resolveLib, typescript)
                : getCachedLibFiles();
            lsp = await LSP.client({ language: lang as any, path, fs, libFiles });
        } catch (lspErr) {
            // Gracefully degrade when LSP is unavailable (e.g. missing worker, test environment)
            console.warn("LSP unavailable for this view:", lspErr);
        }
        if (!lsp || ticket !== latestOpen) return;
        safeDispatch(view, { effects: languageServerCompartment.reconfigure([lsp]) });
    }

    // Each open is numbered; only the latest may put its file in the view,
    // so when opens overlap the last one asked for wins, whichever read ends first.
    let latestOpen = 0;

    /** Open `path`; `again` reloads the open file (after a conflict). */
    async function handleOpen(path: string, again = false) {
        if (!path) return;
        if (opening === path && !again) return;
        opening = path;
        const ticket = ++latestOpen;
        // Cancel the debounced save and manually flush the current file.
        // We can't use save.flush() because openFileEffect has already updated
        // currentFileField.path to the NEW path, but the document still holds
        // the OLD file's content. Using activePath ensures we write to the
        // correct location.
        save.cancel();
        // Only edits are written back: an image, or a file opened and left
        // untouched, is not.
        if (activePath && dirty && view.state.field(settingsField).autosave) {
            dirty = false;
            const oldPath = activePath;
            const oldContent = view.state.doc.toString();
            writing = writing.then(() => store(oldPath, oldContent, true));
            await writing;
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

            const isRasterImage = ext ? IMAGE_EXTENSIONS.has(ext) : false;
            // Read as bytes: an image is previewed from them, and a file that
            // is not text is shown as such, never decoded into the editor.
            // Through the log, the bytes and the version they are come together.
            let bytes: Uint8Array | null;
            let opened: string | null = null;
            if (versions) {
                const head = await versions.head(path);
                bytes = head ? await versions.read(head) : null;
                opened = head?.id ?? null;
            } else {
                bytes = (await fs.exists(path)) ? await fs.readBytes(path) : null;
            }
            const exists = bytes !== null;
            let imageUrl: string | null = null;
            if (isRasterImage && bytes) {
                const head = new TextDecoder().decode(bytes.subarray(0, 5));
                imageUrl = head === 'data:' ? new TextDecoder().decode(bytes)
                    : URL.createObjectURL(new Blob([bytes as BlobPart], { type: `image/${ext === 'jpg' ? 'jpeg' : ext === 'ico' ? 'x-icon' : ext}` }));
            }
            const text = bytes && !isRasterImage ? textOf(bytes) : '';
            const isBinary = text === null;
            const content = text ?? '';

            // Ensure the file exists on VFS before LSP initialization.
            // The LSP uses readDirectory to find source files and match them
            // against tsconfig. If the file doesn't exist yet, Volar falls
            // back to an inferred project that lacks lib file configuration.
            if (!exists) {
                await fs.mkdir(dirname(path), { recursive: true }).catch(() => {});
                if (versions) {
                    const created = await versions.put(path, null, content);
                    opened = created.ok === true ? created.version.id : created.head?.id ?? null;
                } else {
                    await fs.writeFile(path, content);
                }
                LSP.notifyFileChanged(path, FileChangeType.Created);
                // Give the LSP server a moment to process the file-created
                // notification before we send didOpen — otherwise the server
                // hasn't added the file to its project graph yet.
                await new Promise(r => setTimeout(r, 50));
            }

            const unit = detectIndentationUnit(content) || "    ";

            if (ticket !== latestOpen) return;

            // A region: its lines, where they are in the file now. Reopened
            // (after a conflict), they are followed from the file as it was
            // shown; opened first, found by the text the host last saw them
            // with (a note's fence body) if they have moved; otherwise they
            // are the lines the range names.
            const wanted = isRasterImage || isBinary ? null : view.state.field(regionField);
            let placed: LineRange | null = null;
            if (wanted) {
                const clamped = clampRange(wanted, lineCount(content));
                const cfg = view.state.facet(CodeblockFacet);
                const seen = activePath === null && path === cfg.filepath ? cfg.content : undefined;
                placed = (activePath === path && shown !== null ? followRange(shown, content, wanted) : null)
                    ?? (seen && sliceLines(content, clamped) !== seen ? findRegion(content, seen, wanted.from) : null)
                    ?? clamped;
            }
            const lines = placed ? sliceLines(content, placed) : content;

            activePath = path;
            version = opened;
            shown = placed ? content : null;
            region = placed;

            // Check for image/SVG files
            const isSvg = ext === SVG_EXTENSION;

            if (isRasterImage || isBinary) {
                // An image, or a file that is not text: shown, not edited
                // Clear diagnostics + change content in one dispatch to avoid
                // stale decoration positions from the previous file.
                safeDispatch(view, () => {
                    const clearDiag = setDiagnostics(view.state, []);
                    return {
                        ...clearDiag,
                        changes: { from: 0, to: view.state.doc.length, insert: content },
                        effects: [
                            ...(clearDiag.effects ? [clearDiag.effects].flat() : []),
                            fileLoadedEffect.of({ path, content, language: null, preview: true }),
                            setRegionEffect.of(null),
                        ],
                        annotations: Transaction.addToHistory.of(false),
                    };
                });
                if (isBinary) showBinaryPreview(path, bytes?.length ?? 0);
                else showImagePreview(imageUrl);
            } else {
                // Remove any existing preview
                removePreview();

                // The file's text, with the last file's diagnostics and
                // language server gone, in one transaction computed when it
                // is applied (another open may have changed the document
                // since this one began). Kept out of the undo history, so undo
                // cannot bring the last file's text into this one.
                safeDispatch(view, () => {
                    const clearDiag = setDiagnostics(view.state, []);
                    return {
                        ...clearDiag,
                        changes: { from: 0, to: view.state.doc.length, insert: lines },
                        effects: [
                            ...(clearDiag.effects ? [clearDiag.effects].flat() : []),
                            indentationCompartment.reconfigure(indentUnit.of(unit)),
                            fileLoadedEffect.of({ path, content: lines, language: lang }),
                            setRegionEffect.of(placed),
                            languageServerCompartment.reconfigure([]),
                        ],
                        annotations: Transaction.addToHistory.of(false),
                    };
                });

                // SVG: show live preview below the editor
                if (isSvg) {
                    showSvgView(content, 'preview');
                }

                // The file is editable now; its language server joins when
                // it is ready (a TypeScript worker takes seconds to start).
                // Not for a region: the server would take its lines for the
                // whole file.
                if (lang && !placed) void attachLanguageServer(path, lang, ext, ticket);
            }

            // Subscribe to changes from other views of the same file
            subscribeToFileChanges(path);
        } catch (e) {
            console.error("Failed to open file", e);
            if (ticket === latestOpen) emitFileEvent(view, { type: 'error', path, error: e });
        } finally {
            if (opening === path) opening = null;
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

            // A file arriving replaces whatever was unsaved (written, or
            // given up with autosave off, when it was opened).
            if (u.transactions.some(isLoad)) dirty = false;
            const edited = !receivingExternalUpdate && u.transactions.some((tr) => tr.docChanged && !isLoad(tr));
            const file = u.state.field(currentFileField);
            if (u.transactions.some((tr) => tr.effects.some((e) => e.is(closeFileEffect)))) {
                // Nothing of the file's is written from here: not its pending
                // save, nor an open still reading.
                save.cancel();
                dirty = false;
                activePath = null;
                shown = null;
                region = null;
                latestOpen++;
                removePreview();
                unsubscribeFileChanges?.();
                unsubscribeFileChanges = null;
                const closed = u.startState.field(currentFileField).path;
                if (closed) queueMicrotask(() => emitFileEvent(view, { type: 'close', path: closed }));
            }
            // A region that moved in its file is numbered from its new first
            // line (the gutter redraws its numbers only when its own
            // configuration changes, or the document does).
            const startedAt = u.startState.field(regionField)?.from ?? 1;
            if ((u.state.field(regionField)?.from ?? 1) !== startedAt && u.state.field(settingsField).showLineNumbers) {
                safeDispatch(view, { effects: lineNumbersCompartment.reconfigure(numberedLines()) });
            }
            // Told after the update, so a listener may dispatch.
            if (file.path && !file.loading && u.transactions.some(isLoad)) {
                const path = file.path;
                queueMicrotask(() => emitFileEvent(view, { type: 'load', path }));
            }
            if (edited && file.path && !file.loading && !file.preview) {
                dirty = true;
                if (u.state.field(settingsField).autosave) save();
            }

            // Live SVG preview update
            if (u.docChanged && previewEl?.classList.contains('cm-svg-preview')) {
                updateSvgPreview();
            }

            // Reconfigure AI extension when agentUrl or aiModel changes
            const prevSettings = u.startState.field(settingsField);
            const nextSettings = u.state.field(settingsField);
            if (prevSettings.agentUrl !== nextSettings.agentUrl || prevSettings.aiModel !== nextSettings.aiModel) {
                reconfigureAi(view, nextSettings.agentUrl, nextSettings.aiModel);
            }

            // Broadcast settings changes to other editors (unless we received them externally)
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
            versions = u.state.facet(CodeblockFacet).versions;
        },
        destroy() {
            if (unsubscribeFileChanges) {
                unsubscribeFileChanges();
                unsubscribeFileChanges = null;
            }
            unsubscribeSettings();
            removePreview();
            save.cancel();
            persisters.delete(view);
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

export function createCodeblock({ parent, fs, filepath, range, language, content = '', cwd = '/', toolbar = true, toolbarLayout, search, files, versions, dark, settings, typescript }: CreateCodeblockArgs) {
    const state = EditorState.create({
        doc: content,
        extensions: [basicSetup, codeblock({ content, fs, filepath, range, cwd, language, toolbar, toolbarLayout, search, files, versions, dark, settings, typescript })]
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