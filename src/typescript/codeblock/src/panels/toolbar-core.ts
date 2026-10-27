/**
 * Shared toolbar core — host-agnostic toolbar logic for file search, browse,
 * naming, delete/overwrite confirmation, settings, and import.
 *
 * Both the CodeMirror panel adapter (toolbar.ts) and the Tiptap/ProseMirror
 * adapter (markdown-editor toolbar.ts) instantiate ToolbarCore with
 * host-specific callbacks.
 */

import { extOrLanguageToLanguageId } from "../lsps";
import { Seti } from "@m234/nerd-fonts/fs";
import { fileOperations, pathTaken, type FileOperations, type FileSearch, type SearchHit, type VfsInterface } from "@joinezco/storage";
import { StyleModule } from "style-mod";
import { vscodeStyleMod } from "../themes/vscode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type NerdIcon = { value: string; hexCode: number; color?: string };

export interface CommandResult {
    id: string;
    type: 'create-file' | 'save-as' | 'rename-file' | 'delete-file' | 'import-local-files' | 'import-local-folder' | 'open-file' | 'settings' | 'file-action' | 'clear-filesystem' | 'host-command';
    icon: string;
    iconColor?: string;
    query: string;
    requiresInput?: boolean;
    action?: () => void;
}

export interface FileActionEntry {
    extensions: string[];
    label: string;
    icon: string;
    action: () => void;
}

export interface SettingsEntry {
    id: string;
    settingKey: string;
    type: 'settings-toggle' | 'settings-cycle' | 'settings-input' | 'settings-action';
    icon: string;
    currentValue: string;
}

export interface BrowseEntry {
    id: string;
    type: 'browse-directory' | 'browse-file' | 'browse-parent';
    icon: string;
    iconColor?: string;
    fullPath: string;
}

/** A file the search found; `id` is its path. */
export type FileResult = SearchHit & { id: string };

/** A command the host offers in the toolbar (the editor's, when the toolbar
 *  is its command palette). */
export interface HostCommand {
    id: string;
    icon?: string;
    /** Extra words it is found by. */
    keywords?: string[];
    run(): void;
}

export type SearchResult = FileResult | CommandResult | BrowseEntry | SettingsEntry;

/** A tab of the group the toolbar's block stands in (`ToolbarHost.tabs`).
 *  The active one is the field itself; the others are drawn beside it,
 *  each with its icon, its label and a close button, and "+" after the
 *  last. `id` is the host's own (an index in the group, say). */
export interface ToolbarTab {
    id: string;
    label: string;
    icon: string;
    iconColor?: string;
    active: boolean;
}

export interface NamingMode {
    active: boolean;
    type: 'create-file' | 'save-as' | 'rename-file';
    originalQuery: string;
    languageExtension?: string;
}

export interface BrowseMode {
    active: boolean;
    currentPath: string;
    filter: string;
}

export interface SettingsMode {
    active: boolean;
    filter: string;
    editing: string | null;
}

export interface DeleteMode {
    active: boolean;
    filePath: string;
}

export interface OverwriteMode {
    active: boolean;
    filePath: string;
    action: 'save-as' | 'create-file' | 'rename';
    oldPath?: string;
}

// ---------------------------------------------------------------------------
// Intent detection — determines result prioritization
// ---------------------------------------------------------------------------
export type ToolbarIntent =
    | 'file-search'    // Looking for a specific file
    | 'file-create'    // Wants to create a new file
    | 'file-action'    // Wants rename/save-as/delete
    | 'browse'         // Wants to browse the file system
    | 'settings'       // Wants to change settings
    | 'command'        // Wants a specific command (import)
    | 'language'       // Typed a language name
    | 'unknown';       // Can't determine intent

// ---------------------------------------------------------------------------
// Host interface — implemented by CM and Tiptap adapters
// ---------------------------------------------------------------------------
export interface ToolbarHost {
    fs: VfsInterface;
    /** Finds files by path and name (and notes by their text). Without it the
     *  toolbar offers commands and browsing only. */
    search?: FileSearch;
    /** Creates, moves and deletes files. Defaults to plain operations over
     *  `fs`; a vault's keeps links working through a rename. */
    files?: FileOperations;
    cwd?: string;
    filepath?: string;
    language?: string;

    /** Tell the host to open a file; `find` is text to reveal in it (a
     *  search hit in the file's content). */
    openFile(path: string, options?: { skipSave?: boolean; find?: string }): void;
    /** Get the current document content (for save-as). */
    getDocContent(): string;
    /** Move focus from toolbar to editor body. */
    focusEditor(): void;
    /** Notify that a file was created/changed/deleted on the VFS. */
    notifyFileChanged?(path: string, type: number): void;
    /** Write the open file's unsaved edits now, autosave or not, before the
     *  toolbar moves it. Only the host knows what the open document is (text
     *  or an image, which view holds it), so the toolbar never writes it. */
    persist(): Promise<void>;
    /** Put the open file down without writing its unsaved edits: it is about
     *  to be deleted. */
    closeFile(): void | Promise<void>;
    /** Make the unnamed block one of `language` (an extension, `yml`):
     *  "Create new file" for a language, with Enter on an empty name in
     *  place of a name. The block keeps no file; a host that gives unnamed
     *  blocks a stand-in file does so as it would for a fence of that
     *  language. Without this, a name is required. */
    setLanguage?(language: string): void;
    /** Commands the host offers, matched against the query. */
    commands?(query: string): HostCommand[];
    /** The tabs of the group the block stands in, in order, this block's
     *  `active`. Given, the field is drawn as a tab among them, with "+"
     *  after the last; the host calls `refreshTabs()` when they change. */
    tabs?(): ToolbarTab[];
    /** A tab pressed: the host shows that block in the field's place. */
    activateTab?(id: string): void;
    /** A tab's close button pressed. */
    closeTab?(id: string): void;
    /** "+" pressed: the host adds a block to the group and opens its field. */
    addTab?(): void;
    /** Get the current file path from host state (may differ from initial filepath). */
    getCurrentFilePath?(): string | null;
    /** Whether autosave is enabled. */
    isAutosaveEnabled?(): boolean;

    // Settings support (optional)
    buildSettingsEntries?(filter: string): SettingsEntry[];
    handleSettingsEntry?(entry: SettingsEntry): void;
    confirmSettingsEdit?(key: string, rawValue: string): void;

    // File actions (optional, e.g. SVG preview toggle)
    fileActions?: FileActionEntry[];

    /** Delete every file in the editor's filesystem (and nothing else: an
     *  origin's other vaults are not the editor's). */
    onClearFilesystem?(): Promise<void>;

    // Navigation history (optional)
    goBack?(): boolean;
    goForward?(): boolean;
    canGoBack?(): boolean;
    canGoForward?(): boolean;

    /**
     * Optional AI-powered intent classification. Called with a debounce
     * when heuristics can't confidently determine intent. Should return
     * a ToolbarIntent or null if AI is unavailable / declines to answer.
     */
    classifyIntent?(query: string, context: { currentFile: string | null }): Promise<ToolbarIntent | null>;
}

// ---------------------------------------------------------------------------
// Icon utilities
// ---------------------------------------------------------------------------
const FALLBACK_ICON: NerdIcon = { value: '\ue64e', hexCode: 0xe64e };

export function setiIconForPath(filePath: string): NerdIcon {
    const base = filePath.split('/').pop() || filePath;
    const byBase = Seti.byBaseSeti.get(base);
    if (byBase) return byBase;
    let dot = base.indexOf('.');
    if (dot < 0) return FALLBACK_ICON;
    let ext = base.slice(dot);
    for (;;) {
        const byExt = Seti.byExtensionSeti.get(ext);
        if (byExt) return byExt;
        dot = ext.indexOf('.', 1);
        if (dot === -1) break;
        ext = ext.slice(dot);
    }
    return FALLBACK_ICON;
}

export function getFileIcon(path: string): { glyph: string; color: string } {
    const result = setiIconForPath(path);
    return { glyph: result.value, color: result.color || '' };
}

function getLanguageIcon(query: string): { glyph: string; color: string } {
    return getFileIcon(`file.${query}`);
}

// ---------------------------------------------------------------------------
// Language utilities
// ---------------------------------------------------------------------------
function isValidProgrammingLanguage(query: string): boolean {
    const lowerQuery = query.toLowerCase();
    return Object.keys(extOrLanguageToLanguageId).some(key =>
        key.toLowerCase() === lowerQuery ||
        extOrLanguageToLanguageId[key].toLowerCase() === lowerQuery
    );
}

function languageToFileExtension(langOrExt: string): string {
    const nameToExt: Record<string, string> = {
        javascript: 'js', typescript: 'ts', python: 'py', ruby: 'rb',
        csharp: 'cs', kotlin: 'kt', rust: 'rs', haskell: 'hs',
        perl: 'pl', bash: 'sh', shell: 'sh', mysql: 'sql', markdown: 'md',
    };
    return nameToExt[langOrExt.toLowerCase()] || langOrExt.toLowerCase();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const SEARCH_ICON = '\uf002';
const ELLIPSIS_ICON = '\uf141';
export const DEFAULT_FILE_ICON = '\ue64e';
export const COG_ICON = '\uf013';
export const FOLDER_ICON = '\ue613';
// FontAwesome "folder-open" (U+F07C). The Seti open-folder glyph (U+E614)
// renders as a stray "#" in fonts that don't carry that private-use slot,
// whereas the FontAwesome range is reliably present -- and an open folder
// reads more idiomatically as "browse/open a file" than a hash ever did.
export const FOLDER_OPEN_ICON = '\uf07c';
const PARENT_DIR_ICON = '\uf112';

/** FontAwesome "trash" (U+F1F8): the delete command. */
const TRASH_ICON = String.fromCharCode(0xf1f8);

const FileChangeType = { Created: 1, Changed: 2, Deleted: 3 } as const;
const mod = (n: number, m: number) => ((n % m) + m) % m;

// Type guards
export function isCommandResult(result: SearchResult): result is CommandResult {
    return 'type' in result && (result as CommandResult).query !== undefined;
}
export function isBrowseEntry(result: SearchResult): result is BrowseEntry {
    return 'type' in result && ('fullPath' in result);
}
export function isSettingsEntry(result: SearchResult): result is SettingsEntry {
    return 'type' in result && ('settingKey' in result);
}
export function isFileResult(result: SearchResult): result is FileResult {
    return 'match' in result && 'path' in result;
}

// Nerd font injection (idempotent). The "Propo" build of the font: its
// icons' advance widths are their drawn widths, so an icon centred or
// right-aligned by its box lands where it looks. (The plain build keeps
// every icon to one text cell and lets the drawing overhang to the right
// by about another cell, which put every icon a few pixels right of where
// its box was.) Letters and digits stay monospace in both builds, so `ch`
// still measures a text cell.
let nerdFontInjected = false;
function injectNerdFontFace() {
    if (nerdFontInjected) return;
    nerdFontInjected = true;
    const style = document.createElement('style');
    style.textContent = `@font-face {
  font-family: 'UbuntuMono NF';
  src: url('/fonts/UbuntuMonoNerdFontPropo-Regular.ttf') format('truetype');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}`;
    document.head.appendChild(style);
}


// ---------------------------------------------------------------------------
// Standalone toolbar styles (not scoped to .cm-editor)
// ---------------------------------------------------------------------------
/** The toolbar's type: 3px under the code's (`--cm-toolbar-font-size`, themes/vscode.ts). */
const TFS = 'var(--cm-toolbar-font-size, var(--cm-font-size, 16px))';

const toolbarStyleModule = new StyleModule({
    '.cm-toolbar-panel': {
        padding: '0',
        background: 'var(--cm-toolbar-background)',
        display: 'flex',
        alignItems: 'center',
        position: 'relative',
    },
    '.cm-toolbar-input': {
        fontFamily: 'var(--cm-font-family)',
        lineHeight: '1.4',
        border: 'none',
        background: 'transparent',
        outline: 'none',
        fontSize: TFS,
        color: 'var(--cm-toolbar-color)',
        padding: '0 2px 0 6px',
        width: '100%',
        flex: 1,
    },
    // In the toolbar's colour, for what stands beside the field (the
    // active tab's close button): the field sets its own, the container
    // would otherwise inherit the page's.
    '.cm-toolbar-input-container': {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        flex: 1,
        color: 'var(--cm-toolbar-color)',
    },
    // The strip: the tabs and the field in one row that scrolls sideways
    // when the tabs outgrow the bar (the scrollbar hidden; the wheel
    // scrolls it; the active tab is brought into view). The dropdown stays
    // outside it, hung from the panel, or the strip's overflow would cut
    // it off.
    '.cm-toolbar-strip': {
        display: 'flex',
        alignItems: 'center',
        flex: '1 1 auto',
        minWidth: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
        scrollbarWidth: 'none',
    },
    '.cm-toolbar-strip::-webkit-scrollbar': {
        display: 'none',
    },
    // The group's other tabs (`ToolbarHost.tabs`), before and after the
    // field, and "+" after the last: plain here, shaped by the host's
    // styles (the markdown editor draws them as a window's tabs).
    '.cm-toolbar-tabs': {
        display: 'flex',
        alignItems: 'stretch',
        gap: '2px',
        flex: 'none',
        minWidth: 0,
    },
    '.cm-toolbar-tabs:empty': {
        display: 'none',
    },
    '.cm-toolbar-tab': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        maxWidth: '28ch',
        padding: '0 8px',
        border: 'none',
        background: 'transparent',
        color: 'var(--cm-command-result-color)',
        fontFamily: 'var(--cm-font-family)',
        fontSize: TFS,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        opacity: 0.7,
    },
    '.cm-toolbar-tab:hover, .cm-toolbar-tab:focus-visible': {
        opacity: 1,
    },
    '.cm-toolbar-tab-icon': {
        fontFamily: 'var(--cm-icon-font-family)',
        flex: 'none',
    },
    '.cm-toolbar-tab-label': {
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
    },
    '.cm-toolbar-tab-close': {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: '16px',
        height: '16px',
        margin: '0 0 0 2px',
        padding: 0,
        border: 'none',
        borderRadius: '4px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: 1,
        cursor: 'pointer',
        opacity: 0.6,
    },
    '.cm-toolbar-tab-close:hover, .cm-toolbar-tab-close:focus-visible': {
        opacity: 1,
        background: 'color-mix(in srgb, currentColor 15%, transparent)',
    },
    '.cm-toolbar-tab-close[hidden]': {
        display: 'none',
    },
    '.cm-toolbar-tab-add': {
        padding: '0 7px',
        fontSize: '1.15em',
    },
    // Sized to the FULL gutter width (line numbers + fold gutter) —
    // matching `.cm-search-result-icon-container` below — so the toolbar
    // input that follows starts at the same x as the code content (which
    // begins after the full gutter) AND as the dropdown result labels.
    // The glyph inside (width `--cm-gutter-lineno-width`, right-aligned)
    // still lines up with the line-number column. Kept in sync with the
    // scoped rule in themes/index.ts (which wins when the toolbar is
    // inside a `.cm-editor`); this standalone copy covers detached use.
    '.cm-toolbar-state-icon-container': {
        width: 'var(--cm-gutter-width, 2em)',
        minWidth: 'var(--cm-icon-col-width, 2em)',
        display: 'flex',
        // Never squeezed when the strip's tabs outgrow the bar: the strip scrolls.
        flex: 'none',
    },
    // The icon's drawn right edge sits where the line numbers' does: 3px
    // (CodeMirror's gutter padding) in from the column's edge.
    '.cm-toolbar-state-icon': {
        fontSize: TFS,
        color: 'var(--cm-foreground)',
        fontFamily: 'var(--cm-icon-font-family)',
        paddingRight: '3px',
        textAlign: 'right',
        boxSizing: 'border-box',
        width: 'var(--cm-gutter-lineno-width, 2em)',
        minWidth: 'var(--cm-icon-col-width, 2em)',
        transition: 'opacity 0.15s ease',
    },
    // `cm-toolbar-compact` (CodeblockConfig.toolbarLayout: 'compact'): the icon column hugs the text instead of
    // matching the editor's gutter — for a toolbar hosted away from the editor.
    '.cm-toolbar-panel.cm-toolbar-compact .cm-toolbar-state-icon-container, .cm-toolbar-panel.cm-toolbar-compact .cm-search-result > .cm-search-result-icon-container': {
        width: 'auto',
        minWidth: '0',
    },
    '.cm-toolbar-panel.cm-toolbar-compact .cm-toolbar-state-icon, .cm-toolbar-panel.cm-toolbar-compact .cm-search-result > .cm-search-result-icon-container > .cm-search-result-icon': {
        width: 'auto',
        minWidth: '0',
        paddingRight: '1ch',
        textAlign: 'left',
    },
    '.cm-search-results': {
        position: 'absolute',
        top: '100%',
        margin: '0',
        padding: '0',
        background: 'var(--cm-toolbar-background)',
        fontFamily: 'var(--cm-font-family)',
        fontSize: TFS,
        listStyleType: 'none',
        width: '100%',
        maxHeight: `calc(${TFS} * 1.4 * 10)`,
        overflowY: 'auto',
        zIndex: '200',
        '&:empty': {
            display: 'none',
        },
    },
    '.cm-search-result': {
        color: 'var(--cm-search-result-color)',
        display: 'flex',
        cursor: 'pointer',
        lineHeight: '1.4',
        '&.cm-command-result, &.cm-show-more-result': {
            color: 'var(--cm-command-result-color)',
        },
        '& > .cm-search-result-icon-container': {
            width: 'var(--cm-gutter-width, 2em)',
            minWidth: 'var(--cm-icon-col-width, 2em)',
            '& > .cm-search-result-icon': {
                fontSize: TFS,
                textAlign: 'right',
                paddingRight: '3px',
                boxSizing: 'border-box',
                width: 'var(--cm-gutter-lineno-width, 2em)',
                minWidth: 'var(--cm-icon-col-width, 2em)',
            },
        },
        // macOS-style single highlight: only the `.selected` row is coloured.
        // There's deliberately no `&:hover` rule — pointing at a row instead
        // moves `selectedIndex` to it (see renderItem's `mouseenter`), so the
        // pointer and the keyboard drive the *same* single highlight rather
        // than lighting up two rows at once.
        '&.selected': {
            '& div': { color: 'var(--cm-search-result-color-selected)' },
            backgroundColor: 'var(--cm-search-result-select-bg)',
        },
        '& > .cm-search-result-label': {
            flex: 1,
            padding: '0 2px 0 6px',
            minWidth: '0',
        },
        // A content hit: the line it matched, under its path.
        '& .cm-search-result-snippet': {
            display: 'block',
            opacity: '0.7',
            fontSize: '0.85em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
        },
    },
    // A line between the list's sections (files, file commands, actions, settings).
    '.cm-search-separator': {
        height: '1px',
        margin: '3px 0',
        background: 'color-mix(in srgb, var(--cm-search-result-color) 18%, transparent)',
    },
});

let toolbarStylesMounted = false;
function mountToolbarStyles() {
    if (toolbarStylesMounted) return;
    toolbarStylesMounted = true;
    StyleModule.mount(document, toolbarStyleModule);
    StyleModule.mount(document, vscodeStyleMod);
}

// ---------------------------------------------------------------------------
// ToolbarCore
// ---------------------------------------------------------------------------
const SHOW_MORE_SENTINEL: unique symbol = Symbol('show-more');
type VisibleItem = SearchResult | typeof SHOW_MORE_SENTINEL;
const MAX_COLLAPSED_FILE_RESULTS = 3;

export class ToolbarCore {
    // Public DOM elements — hosts may need to reference these
    readonly dom: HTMLElement;
    readonly stateIconContainer: HTMLElement;
    readonly stateIcon: HTMLElement;
    readonly inputContainer: HTMLElement;
    readonly input: HTMLInputElement;
    readonly resultsList: HTMLElement;
    /** The row of the tabs and the field, scrolled sideways when they outgrow the bar. */
    readonly strip: HTMLElement;
    /** The group's tabs before and after the field, and the field's own close button (`ToolbarHost.tabs`). */
    readonly tabsBefore: HTMLElement;
    readonly tabsAfter: HTMLElement;
    readonly closeButton: HTMLButtonElement;
    private activeTabId: string | null = null;
    private stripObserver: ResizeObserver | null = null;

    private host: ToolbarHost;
    private fileOps: FileOperations;
    /** Bumped per query, so a slow search cannot overwrite a newer one. */
    private searchToken = 0;
    /** The search for what is typed now, while it runs: Enter waits for it,
     *  so it acts on these results and not an earlier keystroke's. */
    private searching: Promise<void> | null = null;

    /** Run `search` as the current search, known to Enter while it runs. */
    private async asCurrentSearch(search: () => Promise<void>): Promise<void> {
        const running = search();
        const tracked: Promise<void> = running.catch(() => {}).finally(() => {
            if (this.searching === tracked) this.searching = null;
        });
        this.searching = tracked;
        return running;
    }

    /** Forget any search still running: its results would reopen the list. */
    private dropSearch() {
        this.searchToken++;
        this.searching = null;
    }
    private selectedIndex = 0;
    private namingMode: NamingMode = { active: false, type: 'create-file', originalQuery: '' };
    private browseMode: BrowseMode = { active: false, currentPath: '/', filter: '' };
    private settingsMode: SettingsMode = { active: false, filter: '', editing: null };
    private deleteMode: DeleteMode = { active: false, filePath: '' };
    private overwriteMode: OverwriteMode = { active: false, filePath: '', action: 'create-file' };
    private inputTouched = false;
    /** The path the toolbar itself asked the host to open, until the host reports a file. */
    private opening: string | null = null;
    /** What the field says instead of the path (the language of an unnamed
     *  block whose file is a stand-in); back to it whenever the field resets. */
    private shownAs: string | null = null;
    private resultsExpanded = false;
    private visibleItems: VisibleItem[] = [];
    private results: SearchResult[] = [];
    private currentFilePath: string | null;
    private handleClickOutsideBound: (event: Event) => void;
    /** The pointer over the toolbar: the state icon is the search's then. */
    private hovered = false;

    // AI intent classification state
    private aiClassifyTimer: ReturnType<typeof setTimeout> | null = null;
    private aiClassifyAbort: AbortController | null = null;
    private lastIntent: ToolbarIntent = 'unknown';

    constructor(host: ToolbarHost) {
        this.host = host;
        this.fileOps = host.files ?? fileOperations(host.fs);
        this.currentFilePath = host.filepath || null;

        injectNerdFontFace();
        mountToolbarStyles();

        // --- DOM ---
        this.dom = document.createElement("div");
        this.dom.className = "cm-toolbar-panel";

        this.stateIconContainer = document.createElement("div");
        this.stateIconContainer.className = "cm-toolbar-state-icon-container";
        this.stateIcon = document.createElement("div");
        this.stateIcon.className = "cm-toolbar-state-icon";
        this.setGlyph(SEARCH_ICON);
        this.stateIconContainer.appendChild(this.stateIcon);
        this.strip = document.createElement("div");
        this.strip.className = "cm-toolbar-strip";
        this.dom.appendChild(this.strip);
        this.strip.appendChild(this.stateIconContainer);

        this.inputContainer = document.createElement("div");
        this.inputContainer.className = "cm-toolbar-input-container";
        this.input = document.createElement("input");
        this.input.type = "text";
        this.input.value = host.filepath || host.language || "";
        this.input.className = "cm-toolbar-input";
        // Paths, languages and commands, not prose: no squiggles under
        // `App.tsx`, no capital put on a path by a phone's keyboard.
        this.input.spellcheck = false;
        this.input.autocomplete = "off";
        this.input.setAttribute("autocapitalize", "off");
        this.input.setAttribute("autocorrect", "off");
        this.inputContainer.appendChild(this.input);
        this.strip.appendChild(this.inputContainer);

        // The group's tabs: the ones before the field, the ones after it
        // with "+", and the field's own close button. Empty, and hidden,
        // for a host without tabs.
        this.tabsBefore = document.createElement("div");
        this.tabsBefore.className = "cm-toolbar-tabs cm-toolbar-tabs-before";
        this.strip.insertBefore(this.tabsBefore, this.stateIconContainer);
        this.closeButton = document.createElement("button");
        this.closeButton.type = "button";
        this.closeButton.className = "cm-toolbar-tab-close";
        this.closeButton.textContent = "×";
        this.closeButton.hidden = true;
        this.closeButton.addEventListener("mousedown", (e) => e.preventDefault());
        this.closeButton.addEventListener("click", (e) => {
            e.stopPropagation();
            if (this.activeTabId !== null) this.host.closeTab?.(this.activeTabId);
        });
        this.inputContainer.appendChild(this.closeButton);
        this.tabsAfter = document.createElement("div");
        this.tabsAfter.className = "cm-toolbar-tabs cm-toolbar-tabs-after";
        this.strip.appendChild(this.tabsAfter);
        // The strip scrolled: the dropdown follows the field. The wheel's
        // vertical turn scrolls it sideways, as a tab bar's does.
        this.strip.addEventListener("scroll", () => this.placeTab());
        this.strip.addEventListener("wheel", (e) => {
            if (this.strip.scrollWidth <= this.strip.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            e.preventDefault();
            this.strip.scrollLeft += e.deltaY;
        }, { passive: false });
        if (typeof ResizeObserver !== "undefined") {
            // The strip resized, or the field (grown to a name that arrived
            // after the tabs were drawn): the field kept in view, the edges marked.
            this.stripObserver = new ResizeObserver(() => this.settleStrip());
            this.stripObserver.observe(this.strip);
            this.stripObserver.observe(this.inputContainer);
        }

        this.resultsList = document.createElement("ul");
        this.resultsList.className = "cm-search-results";
        this.dom.appendChild(this.resultsList);

        // --- Event wiring ---
        this.handleClickOutsideBound = this.handleClickOutside.bind(this);

        this.input.addEventListener("click", () => this.onInputClick());
        this.input.addEventListener("input", (e) => this.onInputChange(e));
        this.input.addEventListener("keydown", (e) => this.onInputKeydown(e));
        // At rest the state icon is the open file's; the search's while the
        // field is being used or pointed at.
        this.input.addEventListener("focus", () => this.updateStateIcon());
        this.input.addEventListener("blur", () => this.updateStateIcon());
        // Pointed at: the field and its icon, not the whole bar (a group's
        // other tabs are the bar's too, and pointing at one is not a search).
        for (const part of [this.stateIconContainer, this.inputContainer]) {
            part.addEventListener("pointerenter", () => { this.hovered = true; this.updateStateIcon(); });
            part.addEventListener("pointerleave", () => { this.hovered = false; this.updateStateIcon(); });
        }
        this.updateStateIcon();
        this.refreshTabs();
    }

    /** The group's tabs drawn again from the host (`ToolbarHost.tabs`):
     *  the active one is the field, the others stand before and after it
     *  in the group's order, "+" after the last. Where the field stands is
     *  published as `--cm-toolbar-tab-left` for the dropdown to hang from. */
    refreshTabs() {
        const tabs = this.host.tabs?.() ?? [];
        this.tabsBefore.replaceChildren();
        this.tabsAfter.replaceChildren();
        this.dom.classList.toggle("cm-toolbar-tabbed", tabs.length > 0);
        this.closeButton.hidden = tabs.length === 0;
        this.activeTabId = null;
        // Whether the field is the first thing in the strip: a host's styles
        // may lay the first tab out differently (on the gutter's column).
        const active = Math.max(0, tabs.findIndex((tab) => tab.active));
        this.dom.classList.toggle("cm-toolbar-first-active", tabs.length === 0 || active === 0);
        if (tabs.length) {
            this.activeTabId = tabs[active].id;
            this.closeButton.title = `Close ${tabs[active].label}`;
            this.closeButton.setAttribute("aria-label", `Close ${tabs[active].label}`);
            tabs.forEach((tab, i) => {
                if (i !== active) (i < active ? this.tabsBefore : this.tabsAfter).appendChild(this.renderTab(tab));
            });
            const add = document.createElement("button");
            add.type = "button";
            add.className = "cm-toolbar-tab cm-toolbar-tab-add";
            add.textContent = "+";
            add.title = "Open a file in a new tab";
            add.setAttribute("aria-label", "Open a file in a new tab");
            add.addEventListener("mousedown", (e) => e.preventDefault());
            add.addEventListener("click", (e) => { e.stopPropagation(); this.host.addTab?.(); });
            this.tabsAfter.appendChild(add);
        }
        this.placeTab();
        this.settleStrip();
    }

    /** Once laid out, the active tab brought into view: in the next frame,
     *  and once more a moment later, for what lays out after it (the field
     *  grown to a name that arrives late, a block shown by its tab from
     *  hidden). Reads happen outside the resize observer's own turn, so
     *  they never queue it against itself. */
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    private settleStrip() {
        requestAnimationFrame(() => {
            if (this.strip.isConnected) this.revealActiveTab();
        });
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            if (this.strip.isConnected) this.revealActiveTab();
        }, 80);
    }

    /** The strip scrolled so the field (the active tab) is in view. */
    private revealActiveTab() {
        const strip = this.strip;
        if (strip.scrollWidth <= strip.clientWidth) return;
        const left = this.stateIconContainer.offsetLeft - strip.offsetLeft;
        const right = this.inputContainer.offsetLeft + this.inputContainer.offsetWidth - strip.offsetLeft;
        // A little clear of the edge, not just inside it.
        const clear = 16;
        if (left < strip.scrollLeft + clear) strip.scrollLeft = Math.max(0, left - clear);
        else if (right > strip.scrollLeft + strip.clientWidth - clear) strip.scrollLeft = right - strip.clientWidth + clear;
    }


    private renderTab(tab: ToolbarTab): HTMLElement {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cm-toolbar-tab";
        button.title = tab.label;
        const icon = document.createElement("span");
        icon.className = "cm-toolbar-tab-icon";
        icon.textContent = tab.icon;
        if (tab.iconColor) icon.style.color = tab.iconColor;
        const label = document.createElement("span");
        label.className = "cm-toolbar-tab-label";
        label.textContent = tab.label;
        // A close button inside a button is not allowed: a span with the role.
        const close = document.createElement("span");
        close.className = "cm-toolbar-tab-close";
        close.setAttribute("role", "button");
        close.setAttribute("aria-label", `Close ${tab.label}`);
        close.tabIndex = 0;
        close.textContent = "×";
        close.addEventListener("click", (e) => { e.stopPropagation(); this.host.closeTab?.(tab.id); });
        close.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); this.host.closeTab?.(tab.id); } });
        button.append(icon, label, close);
        button.addEventListener("mousedown", (e) => e.preventDefault());
        button.addEventListener("click", (e) => { e.stopPropagation(); this.host.activateTab?.(tab.id); });
        return button;
    }

    /** Where the field's icon column starts, within the panel (the strip's
     *  scroll taken off: the dropdown is the panel's, not the strip's). */
    private placeTab() {
        const left = `${this.stateIconContainer.offsetLeft - this.strip.scrollLeft}px`;
        if (this.dom.style.getPropertyValue("--cm-toolbar-tab-left") !== left) this.dom.style.setProperty("--cm-toolbar-tab-left", left);
    }

    // -----------------------------------------------------------------------
    // Public API — called by host adapters
    // -----------------------------------------------------------------------

    /** Update the current file path (called when the host opens a new file).
     *  `shownAs` is what the field says instead of the path (the language of
     *  an unnamed block whose file is a stand-in). A file that opens on its
     *  own (a region loading, a link followed) while the field is being typed
     *  in does not take the typing: the field names it once left or reset. */
    setFilePath(path: string | null, shownAs?: string) {
        const asked = this.opening !== null && ToolbarCore.splitLines(this.opening).file === path;
        this.opening = null;
        const typing = !asked && this.inputTouched && document.activeElement === this.input;
        this.currentFilePath = path;
        this.shownAs = shownAs ?? null;
        if (typing || this.namingMode.active || this.settingsMode.active) return;
        this.input.value = shownAs ?? path ?? '';
        this.inputTouched = false;
        this.updateStateIcon();
        this.fieldChanged();
    }

    /** The field's text changed, so its width may have (it is sized to its
     *  content where the host says so): once laid out, the field is kept in
     *  view in the strip and the strip's edges marked. */
    private fieldChanged() {
        this.settleStrip();
    }

    /** Ask the host for `path`: a file the toolbar opens is named in the field when it arrives. */
    private open(path: string, options?: { skipSave?: boolean; find?: string }) {
        this.opening = path;
        this.host.openFile(path, options);
    }

    /** A query's file and, after `#`, the lines asked for (`src/a.ts#L3-L9`). */
    private static splitLines(query: string): { file: string; lines: string } {
        const m = /^(.*?)(#L\d+(?:-L\d+)?)\s*$/i.exec(query);
        return m ? { file: m[1], lines: m[2] } : { file: query, lines: '' };
    }

    /** Get the current search results. */
    getResults(): SearchResult[] { return this.results; }

    destroy() {
        this.cancelAiClassify();
        this.stripObserver?.disconnect();
        if (this.settleTimer) clearTimeout(this.settleTimer);
        document.removeEventListener("click", this.handleClickOutsideBound);
    }

    // -----------------------------------------------------------------------
    // Search results
    // -----------------------------------------------------------------------
    private setResults(results: SearchResult[]) {
        this.results = results;
        this.updateDropdown();
        if (results.length === 0) {
            document.removeEventListener("click", this.handleClickOutsideBound);
        }
        this.updateStateIcon();
    }

    private getCurrentFilePath(): string | null {
        return this.host.getCurrentFilePath?.() ?? this.currentFilePath;
    }

    // -----------------------------------------------------------------------
    // Command generation
    // -----------------------------------------------------------------------
    private createCommandResults(query: string, searchResults: SearchResult[]): CommandResult[] {
        const commands: CommandResult[] = [];
        const currentPath = this.getCurrentFilePath();
        const hasValidFile = !!currentPath;
        const hasContent = this.host.getDocContent().length > 0;
        const isLanguageQuery = isValidProgrammingLanguage(query);
        // "Exact match" = the typed query refers to an existing file.
        // Two ways to confirm: the search index returned it as the top
        // hit, *or* the query is literally the currently-open file's
        // path (which is the case the moment the user clicks into the
        // input without typing — the input is pre-populated with the
        // current path). The path check is what suppresses bogus
        // "Create new file 'X'" / "Rename to 'X'" entries when X is
        // already open.
        const hasExactFileMatch = this.queryMatchesExistingFile(query, searchResults);

        // Save as
        if (hasContent || hasValidFile) {
            if (!query.trim()) {
                commands.push({ id: 'Save as', type: 'save-as', icon: DEFAULT_FILE_ICON, query: '', requiresInput: true });
            } else if (!hasExactFileMatch) {
                const langIcon = isLanguageQuery ? getLanguageIcon(query) : null;
                commands.push({
                    id: isLanguageQuery ? "Save as" : `Save as "${query}"`,
                    type: 'save-as', icon: langIcon?.glyph || DEFAULT_FILE_ICON,
                    iconColor: langIcon?.color, query, requiresInput: isLanguageQuery,
                });
            }
        }

        // Create new file
        if (!query.trim()) {
            commands.push({ id: 'Create new file', type: 'create-file', icon: DEFAULT_FILE_ICON, query: '', requiresInput: true });
        } else if (!hasExactFileMatch) {
            const langIcon = isLanguageQuery ? getLanguageIcon(query) : null;
            commands.push({
                id: isLanguageQuery ? "Create new file" : `Create new file "${query}"`,
                type: 'create-file', icon: langIcon?.glyph || DEFAULT_FILE_ICON,
                iconColor: langIcon?.color, query, requiresInput: isLanguageQuery,
            });
        }

        // Rename
        if (query.trim() && hasValidFile && !isLanguageQuery && !hasExactFileMatch) {
            commands.push({ id: `Rename to "${query}"`, type: 'rename-file', icon: '\uf044', query });
        }

        // Open file (browse)
        commands.push({ id: 'Open file', type: 'open-file', icon: FOLDER_OPEN_ICON, query: '' });

        // Import
        commands.push({ id: 'Import file(s)', type: 'import-local-files', icon: '\uf15b', query: '' });
        commands.push({ id: 'Import folder', type: 'import-local-folder', icon: FOLDER_ICON, query: '' });

        // Delete, last of the file commands: the file the query names (the
        // open one, when the field was only clicked into), asked about
        // before it goes. The Delete key on a result does the same, less
        // visibly. Never first: a bare Enter on an untouched field lands on
        // "Save as".
        if (hasExactFileMatch) {
            const { file } = ToolbarCore.splitLines(query.trim());
            commands.push({ id: `Delete "${file}"`, type: 'delete-file', icon: TRASH_ICON, query: file });
        }

        // File actions
        if (hasValidFile && currentPath) {
            const ext = currentPath.split('.').pop()?.toLowerCase() || '';
            for (const entry of (this.host.fileActions || [])) {
                if (entry.extensions.includes(ext)) {
                    commands.push({ id: entry.label, type: 'file-action', icon: entry.icon, query: '', action: entry.action });
                }
            }
        }

        // Navigation
        if (this.host.canGoBack?.()) {
            commands.push({ id: 'Go back', type: 'file-action', icon: '\uf060', query: '', action: () => this.host.goBack?.() });
        }
        if (this.host.canGoForward?.()) {
            commands.push({ id: 'Go forward', type: 'file-action', icon: '\uf061', query: '', action: () => this.host.goForward?.() });
        }

        // The host's own commands, matched against the query.
        for (const command of this.host.commands?.(query) ?? []) {
            commands.push({ id: command.id, type: 'host-command', icon: command.icon ?? '\uf120', query, action: () => command.run() });
        }

        // Settings, last: not about the file or the note, and wanted least often.
        if (this.host.buildSettingsEntries) {
            commands.push({ id: 'Settings', type: 'settings', icon: COG_ICON, query: '' });
        }

        return commands;
    }

    // -----------------------------------------------------------------------
    // Intent detection & result prioritization
    // -----------------------------------------------------------------------

    /** Command keyword patterns for intent detection */
    private static readonly COMMAND_PATTERNS: [RegExp, ToolbarIntent][] = [
        [/^(create|new|add|touch)\b/i, 'file-create'],
        [/^(open|browse|find|explore|ls|dir)\b/i, 'browse'],
        [/^(rename|mv|move|save|export)\b/i, 'file-action'],
        [/^(import|upload)\b/i, 'command'],
        [/^(settings?|config|prefs?|preferences?|options?)\b/i, 'settings'],
        [/^(theme|dark|light|font|color)\b/i, 'settings'],
    ];

    /**
     * Analyze input query to detect user intent using heuristics.
     * Returns a confidence-weighted intent.
     */
    /** True when `query` refers to a file that already exists — either the
     *  search found a file at exactly that path, or it's literally the open
     *  file. Used to tell "open/search this file" apart from "create this
     *  new file". */
    private queryMatchesExistingFile(query: string, searchResults: SearchResult[]): boolean {
        const currentPath = this.getCurrentFilePath();
        const { file } = ToolbarCore.splitLines(query);
        return searchResults.some((r) => r.id === file) ||
            (currentPath !== null && currentPath === file);
    }

    /** The section of the list a result stands in, a line between one
     *  section and the next: the files found, the commands about files
     *  (save, create, rename, open, import, delete), what the file or the
     *  host can do, and the settings. */
    private static sectionOf(result: VisibleItem): string {
        if (result === SHOW_MORE_SENTINEL || !isCommandResult(result)) return 'files';
        switch (result.type) {
            case 'settings': return 'settings';
            case 'file-action': case 'host-command': return 'actions';
            default: return 'file';
        }
    }

    /** A complete filename with an extension, e.g. `readme.md`, `src/main.ts`. */
    private static readonly COMPLETE_FILENAME = /[^/\\]\.\w{1,10}$/;

    private detectIntent(query: string, searchResults: SearchResult[]): { intent: ToolbarIntent; confidence: number } {
        const q = query.trim();
        if (!q) return { intent: 'unknown', confidence: 0 };
        const ql = q.toLowerCase();
        const hasFileResults = searchResults.length > 0;
        // A complete, valid filepath that doesn't already exist is a create —
        // not a search — so the create-file commands get promoted to the top.
        const completeNewFile =
            ToolbarCore.COMPLETE_FILENAME.test(q) && !this.queryMatchesExistingFile(q, searchResults);

        // Direct path: contains slash or starts with dot — clearly looking for a file
        if (q.includes('/')) {
            if (q.endsWith('/')) return { intent: 'browse', confidence: 0.9 };
            if (completeNewFile) return { intent: 'file-create', confidence: 0.85 };
            return { intent: 'file-search', confidence: 0.85 };
        }
        if (q.startsWith('.')) return { intent: 'file-search', confidence: 0.8 };

        // File extension pattern: e.g. "main.ts", "readme.md"
        if (ToolbarCore.COMPLETE_FILENAME.test(q)) {
            return { intent: completeNewFile ? 'file-create' : 'file-search', confidence: 0.8 };
        }

        // Command keywords
        for (const [pattern, intent] of ToolbarCore.COMMAND_PATTERNS) {
            if (pattern.test(ql)) return { intent, confidence: 0.85 };
        }

        // Language name — could be creating a file in that language
        if (isValidProgrammingLanguage(ql)) return { intent: 'language', confidence: 0.7 };

        // If there are file results, likely searching for a file
        if (hasFileResults) return { intent: 'file-search', confidence: 0.6 };

        // Default: ambiguous
        return { intent: 'unknown', confidence: 0.3 };
    }

    /**
     * Reorder results based on detected intent. Commands matching the
     * intent are promoted above other commands; for some intents,
     * commands are promoted above file results entirely.
     */
    private prioritizeResults(
        fileResults: SearchResult[],
        commands: CommandResult[],
        intent: ToolbarIntent,
    ): SearchResult[] {
        switch (intent) {
            case 'file-search':
                // Files first (default behavior), but boost exact/prefix matches
                return [...fileResults, ...commands];

            case 'file-create': {
                // Create the new file first, then the "save/rename the current
                // file to this path" actions, then any incidental matches, then
                // the rest.
                const create = commands.filter(c => c.type === 'create-file');
                const saveRename = commands.filter(c => c.type === 'save-as' || c.type === 'rename-file');
                const rest = commands.filter(c =>
                    c.type !== 'create-file' && c.type !== 'save-as' && c.type !== 'rename-file');
                return [...create, ...saveRename, ...fileResults, ...rest];
            }

            case 'file-action': {
                // Promote rename/save-as above files
                const actions = commands.filter(c =>
                    c.type === 'rename-file' || c.type === 'save-as');
                const rest = commands.filter(c =>
                    c.type !== 'rename-file' && c.type !== 'save-as');
                return [...actions, ...fileResults, ...rest];
            }

            case 'browse': {
                // Promote "Open file" command
                const browse = commands.filter(c => c.type === 'open-file');
                const rest = commands.filter(c => c.type !== 'open-file');
                return [...browse, ...fileResults, ...rest];
            }

            case 'settings': {
                // Settings command first
                const settings = commands.filter(c => c.type === 'settings');
                const rest = commands.filter(c => c.type !== 'settings');
                return [...settings, ...fileResults, ...rest];
            }

            case 'command': {
                // Promote the import commands
                const promoted = commands.filter(c =>
                    c.type === 'import-local-files' || c.type === 'import-local-folder');
                const rest = commands.filter(c =>
                    c.type !== 'import-local-files' && c.type !== 'import-local-folder');
                return [...promoted, ...fileResults, ...rest];
            }

            case 'language': {
                // Language-specific: create/save-as first (they'll have the language context)
                const langCmds = commands.filter(c => c.type === 'create-file' || c.type === 'save-as');
                const rest = commands.filter(c => c.type !== 'create-file' && c.type !== 'save-as');
                return [...langCmds, ...fileResults, ...rest];
            }

            default:
                return [...fileResults, ...commands];
        }
    }

    // -----------------------------------------------------------------------
    // Rendering
    // -----------------------------------------------------------------------
    private renderItem(result: SearchResult, i: number): HTMLElement {
        const li = document.createElement("li");
        let resultClass = 'cm-file-result';
        if (isSettingsEntry(result)) resultClass = 'cm-command-result';
        else if (isCommandResult(result)) resultClass = 'cm-command-result';
        else if (isBrowseEntry(result)) resultClass = result.type === 'browse-file' ? 'cm-file-result' : 'cm-browse-dir-result';
        li.className = `cm-search-result ${resultClass}`;

        const iconContainer = document.createElement("div");
        iconContainer.className = "cm-search-result-icon-container";
        const resultIcon = document.createElement("div");
        resultIcon.className = "cm-search-result-icon";

        if (isSettingsEntry(result)) {
            resultIcon.style.fontFamily = '';
            resultIcon.textContent = result.icon;
        } else {
            resultIcon.style.fontFamily = 'var(--cm-icon-font-family)';
            if (isBrowseEntry(result)) {
                resultIcon.textContent = result.icon;
                if (result.iconColor) resultIcon.style.color = result.iconColor;
            } else if (isCommandResult(result)) {
                resultIcon.textContent = result.icon;
                if (result.iconColor) resultIcon.style.color = result.iconColor;
            } else {
                const icon = getFileIcon(result.id);
                resultIcon.textContent = icon.glyph;
                if (icon.color) resultIcon.style.color = icon.color;
            }
        }
        iconContainer.appendChild(resultIcon);
        li.appendChild(iconContainer);

        const resultLabel = document.createElement("div");
        resultLabel.className = "cm-search-result-label";
        resultLabel.textContent = result.id;
        if (isFileResult(result) && result.match === 'content' && result.snippet) {
            const snippet = document.createElement("span");
            snippet.className = "cm-search-result-snippet";
            snippet.textContent = result.line ? `${result.line}: ${result.snippet}` : result.snippet;
            resultLabel.appendChild(snippet);
        }
        li.appendChild(resultLabel);

        if (i === this.selectedIndex) li.classList.add("selected");
        li.addEventListener("mousedown", (ev) => ev.preventDefault());
        li.addEventListener("mouseenter", () => this.hoverSelect(i));
        li.addEventListener("click", (ev) => { ev.stopPropagation(); this.selectResult(result); });
        return li;
    }

    /** macOS-style hover: pointing at a row makes it *the* selected row, so
     *  there's only ever one highlight and keyboard nav continues from the
     *  pointed-at item. */
    private hoverSelect(i: number) {
        if (this.selectedIndex === i) return;
        this.selectedIndex = i;
        this.highlightSelection(false);
    }

    /** Reflect `selectedIndex` onto the already-rendered rows *in place*
     *  (toggle the `.selected` class) instead of rebuilding the list.
     *
     *  This is what lets keyboard nav take precedence over the mouse: a full
     *  `updateDropdown()` re-render replaces the row under a stationary
     *  cursor, and the browser fires a fresh `mouseenter` on the new element
     *  — which would snap the selection straight back to the hovered row,
     *  defeating the arrow keys. Toggling a class moves no DOM, so no
     *  `mouseenter` fires and the keyboard selection holds until the pointer
     *  actually moves again. (It's also far cheaper per keystroke.)
     *
     *  `scrollIntoView` is true for keyboard moves (keep the active row
     *  visible while arrowing a long list) and false for hover (the row is
     *  already under the cursor, so scrolling would yank the list around). */
    private highlightSelection(scrollIntoView: boolean) {
        const items = this.resultsList.querySelectorAll<HTMLElement>('.cm-search-result');
        items.forEach((el, idx) => el.classList.toggle('selected', idx === this.selectedIndex));
        if (scrollIntoView) {
            const sel = items[this.selectedIndex];
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        }
    }

    private updateDropdown() {
        const results = this.results;
        const children: HTMLElement[] = [];

        // Preserve the prioritized order: commands that come *before* the first
        // file result stay pinned at the top (e.g. "Create new file" for a
        // complete, new filepath), the file results are collapsed in the
        // middle, and the remaining commands follow. Without this split the
        // collapse logic would force every command below every file result,
        // undoing `prioritizeResults`' create-first ordering.
        const leadingCommands: SearchResult[] = [];
        const fileResults: SearchResult[] = [];
        const trailingCommands: SearchResult[] = [];
        let seenFile = false;
        for (const r of results) {
            const isCommand = isCommandResult(r) || isBrowseEntry(r) || isSettingsEntry(r);
            if (!isCommand) { fileResults.push(r); seenFile = true; }
            else if (seenFile) trailingCommands.push(r);
            else leadingCommands.push(r);
        }

        const total = fileResults.length;
        const shouldCollapse = !this.resultsExpanded && total > MAX_COLLAPSED_FILE_RESULTS;
        const visibleFileCount = shouldCollapse ? MAX_COLLAPSED_FILE_RESULTS - 1 : total;
        const hiddenCount = total - visibleFileCount;

        this.visibleItems = [];
        for (const cmd of leadingCommands) this.visibleItems.push(cmd);
        for (let i = 0; i < visibleFileCount; i++) this.visibleItems.push(fileResults[i]);
        if (shouldCollapse) this.visibleItems.push(SHOW_MORE_SENTINEL);
        for (const cmd of trailingCommands) this.visibleItems.push(cmd);

        this.visibleItems.forEach((item, i) => {
            // A line between one section and the next. Not a row: the arrows
            // pass over it (`highlightSelection` counts `.cm-search-result`s).
            if (i > 0 && ToolbarCore.sectionOf(this.visibleItems[i - 1]) !== ToolbarCore.sectionOf(item)) {
                const line = document.createElement("li");
                line.className = "cm-search-separator";
                line.setAttribute("role", "separator");
                children.push(line);
            }
            if (item === SHOW_MORE_SENTINEL) {
                const li = document.createElement("li");
                li.className = "cm-search-result cm-show-more-result";
                const ic = document.createElement("div"); ic.className = "cm-search-result-icon-container";
                const icon = document.createElement("div"); icon.className = "cm-search-result-icon";
                icon.style.fontFamily = 'var(--cm-icon-font-family)';
                icon.textContent = ELLIPSIS_ICON;
                ic.appendChild(icon); li.appendChild(ic);
                const label = document.createElement("div"); label.className = "cm-search-result-label";
                label.textContent = `Show ${hiddenCount} more result${hiddenCount === 1 ? '' : 's'}`;
                li.appendChild(label);
                if (i === this.selectedIndex) li.classList.add("selected");
                li.addEventListener("mousedown", ev => ev.preventDefault());
                li.addEventListener("mouseenter", () => this.hoverSelect(i));
                li.addEventListener("click", ev => { ev.stopPropagation(); this.expandResults(); });
                children.push(li);
            } else {
                children.push(this.renderItem(item, i));
            }
        });

        this.resultsList.replaceChildren(...children);
        const sel = this.resultsList.querySelector('.selected') as HTMLElement;
        if (sel) sel.scrollIntoView({ block: 'nearest' });
        this.placeTab();
    }

    /** The rest of the files shown. The selection stays where it was: on
     *  the "Show more" row's index, which is now the first file it hid. */
    private expandResults() {
        this.resultsExpanded = true;
        this.updateDropdown();
    }

    // -----------------------------------------------------------------------
    // Result selection
    // -----------------------------------------------------------------------
    private selectResult(result: SearchResult) {
        this.dropSearch();
        if (isSettingsEntry(result)) {
            this.handleSettingsEntry(result);
        } else if (isBrowseEntry(result)) {
            this.navigateBrowse(result);
        } else if (isCommandResult(result)) {
            this.handleCommandResult(result);
        } else {
            this.handleSearchResult(result);
        }
    }

    private handleSearchResult(result: FileResult) {
        const query = this.input.value.trim();
        // The lines asked for go with the file (`a.ts#L3-L9` opens those lines).
        const { lines } = ToolbarCore.splitLines(query);
        const path = lines ? result.id + lines : result.id;
        this.input.value = path;
        this.setResults([]);
        this.open(path, result.match === 'content' ? { find: query } : undefined);
    }

    private handleCommandResult(command: CommandResult) {
        if (command.type === 'settings') {
            this.enterSettingsMode();
        } else if (command.type === 'open-file') {
            this.enterBrowseMode();
        } else if (command.type === 'save-as') {
            if (command.requiresInput) {
                const ext = command.query ? languageToFileExtension(command.query) : undefined;
                this.enterNamingMode('save-as', command.query, ext);
            } else {
                const p = command.query.includes('.') ? command.query : `${command.query}.txt`;
                this.input.value = p;
                this.checkOverwriteAndExecute(p, 'save-as', () => this.createAndOpenFile(p));
            }
        } else if (command.type === 'create-file') {
            if (command.requiresInput) {
                const ext = command.query ? languageToFileExtension(command.query) : undefined;
                this.enterNamingMode('create-file', command.query, ext);
            } else {
                const p = command.query.includes('.') ? command.query : `${command.query}.txt`;
                this.input.value = p;
                this.checkOverwriteAndExecute(p, 'create-file', () => this.createBlankFile(p));
            }
        } else if (command.type === 'delete-file') {
            this.enterDeleteMode(command.query);
        } else if (command.type === 'rename-file') {
            const currentPath = this.getCurrentFilePath();
            if (currentPath) {
                const newPath = command.query.includes('.') ? command.query : `${command.query}.txt`;
                this.input.value = newPath;
                this.checkOverwriteAndExecute(newPath, 'rename', () => this.performRename(currentPath, newPath), currentPath);
            }
        } else if (command.type === 'import-local-files') {
            this.triggerFileImport(false);
        } else if (command.type === 'import-local-folder') {
            this.triggerFileImport(true);
        } else if ((command.type === 'file-action' || command.type === 'host-command') && command.action) {
            this.setResults([]);
            this.resetInputToCurrentFile();
            command.action();
        }
    }

    // -----------------------------------------------------------------------
    // State icon
    // -----------------------------------------------------------------------
    /** What the state icon shows: a mode's own glyph; otherwise, at rest, the
     *  open file's icon in its colour (what the field names), and the search
     *  glyph while the field is focused, has results, or is pointed at. The
     *  colour is the file's own only for the file icon. */
    /** The glyph in the state icon, written into its own text node, so
     *  anything a host hangs inside the icon is left where it is. */
    private glyphNode: Text | null = null;
    private setGlyph(glyph: string) {
        if (!this.glyphNode || this.glyphNode.parentNode !== this.stateIcon) {
            this.glyphNode = document.createTextNode('');
            this.stateIcon.textContent = '';
            this.stateIcon.appendChild(this.glyphNode);
        }
        if (this.glyphNode.data !== glyph) this.glyphNode.data = glyph;
    }

    updateStateIcon() {
        let color = '';
        if (this.namingMode.active) {
            this.setGlyph((this.namingMode.type === 'create-file' || this.namingMode.type === 'save-as') ? DEFAULT_FILE_ICON : '\uf044');
        } else if (this.settingsMode.active) {
            this.setGlyph(COG_ICON);
        } else if (this.browseMode.active || this.deleteMode.active || this.overwriteMode.active || this.clearFilesystemPending) {
            return;
        } else {
            const path = this.getCurrentFilePath();
            const searching = document.activeElement === this.input || this.results.length > 0 || this.hovered;
            const named = this.shownAs ? getLanguageIcon(this.shownAs) : path ? getFileIcon(path) : this.host.language ? getLanguageIcon(this.host.language) : null;
            if (!searching && named) {
                this.setGlyph(named.glyph);
                color = named.color;
            } else {
                this.setGlyph(SEARCH_ICON);
            }
        }
        if (this.stateIcon.style.color !== color) this.stateIcon.style.color = color;
    }

    // -----------------------------------------------------------------------
    // Naming mode
    // -----------------------------------------------------------------------
    private enterNamingMode(type: NamingMode['type'], originalQuery: string, languageExtension?: string) {
        this.namingMode = { active: true, type, originalQuery, languageExtension };
        this.updateStateIcon();
        this.input.value = '';
        // A name is optional for a new file of a language where the host
        // keeps unnamed blocks: Enter alone makes the block one of that
        // language and nothing on disk is named.
        const optional = type === 'create-file' && !!languageExtension && this.canSkipNaming();
        this.input.placeholder = languageExtension
            ? optional ? `filename.${languageExtension} (or Enter for an unnamed ${languageExtension} block)` : `filename.${languageExtension}`
            : 'filename';
        this.input.focus();
        this.setResults([]);
    }

    /** Whether "Create new file" for a language may go without a name. */
    private canSkipNaming(): boolean {
        return typeof this.host.setLanguage === 'function';
    }

    private exitNamingMode() {
        this.namingMode = { active: false, type: 'create-file', originalQuery: '' };
        this.updateStateIcon();
        this.input.placeholder = '';
    }

    private executeNamingMode(filename: string) {
        if (!this.namingMode.active) return;
        if (!filename.trim()) {
            // No name given: for a new file of a language, the block becomes
            // an unnamed one of that language (the host's affair: a stand-in
            // file where it keeps them). A save or a rename needs a name.
            const { type, languageExtension } = this.namingMode;
            if (type !== 'create-file' || !languageExtension || !this.canSkipNaming()) return;
            this.exitNamingMode();
            this.setResults([]);
            this.input.value = languageExtension;
            this.inputTouched = false;
            this.host.setLanguage!(languageExtension);
            this.host.focusEditor();
            return;
        }
        const resolvePath = (fn: string) => this.namingMode.languageExtension && !fn.includes('.')
            ? `${fn}.${this.namingMode.languageExtension}` : fn;

        if (this.namingMode.type === 'save-as') {
            const p = resolvePath(filename);
            this.input.value = p;
            this.exitNamingMode();
            this.checkOverwriteAndExecute(p, 'save-as', () => this.createAndOpenFile(p));
        } else if (this.namingMode.type === 'create-file') {
            const p = resolvePath(filename);
            this.input.value = p;
            this.exitNamingMode();
            this.checkOverwriteAndExecute(p, 'create-file', () => this.createBlankFile(p));
        } else if (this.namingMode.type === 'rename-file') {
            const currentPath = this.getCurrentFilePath();
            if (currentPath) {
                const newPath = filename.includes('.') ? filename : `${filename}.txt`;
                this.input.value = newPath;
                this.exitNamingMode();
                this.checkOverwriteAndExecute(newPath, 'rename', () => this.performRename(currentPath, newPath), currentPath);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Browse mode
    // -----------------------------------------------------------------------
    private async enterBrowseMode(startPath?: string) {
        const browsePath = startPath || this.host.cwd || '/';
        this.browseMode = { active: true, currentPath: browsePath, filter: '' };
        this.setGlyph(FOLDER_OPEN_ICON);
        this.input.value = browsePath.endsWith('/') ? browsePath : browsePath + '/';
        this.input.placeholder = '';
        this.input.focus();
        await this.refreshBrowseEntries();
        document.addEventListener("click", this.handleClickOutsideBound);
    }

    private async refreshBrowseEntries() {
        if (!this.browseMode.active) return;
        const { fs } = this.host;
        const dir = this.browseMode.currentPath;
        try {
            const entries = await fs.readDir(dir);
            const browseResults: BrowseEntry[] = [];
            if (dir !== '/' && dir !== '') {
                const parentPath = dir.split('/').slice(0, -1).join('/') || '/';
                browseResults.push({ id: '..', type: 'browse-parent', icon: PARENT_DIR_ICON, fullPath: parentPath });
            }
            const dirs: BrowseEntry[] = [];
            const files: BrowseEntry[] = [];
            for (const [name, fileType] of entries) {
                if (name.startsWith('.')) continue;
                const fullPath = dir === '/' ? `${name}` : `${dir}/${name}`;
                if (fileType === 2) {
                    dirs.push({ id: name + '/', type: 'browse-directory', icon: FOLDER_ICON, fullPath });
                } else {
                    const icon = getFileIcon(name);
                    files.push({ id: name, type: 'browse-file', icon: icon.glyph, iconColor: icon.color, fullPath });
                }
            }
            dirs.sort((a, b) => a.id.localeCompare(b.id));
            files.sort((a, b) => a.id.localeCompare(b.id));
            const filter = this.browseMode.filter.toLowerCase();
            const filtered = [...browseResults, ...dirs, ...files].filter(e =>
                e.type === 'browse-parent' || e.id.toLowerCase().includes(filter)
            );
            this.selectedIndex = 0;
            this.setResults(filtered);
        } catch {
            this.selectedIndex = 0;
            this.setResults([]);
        }
    }

    private async navigateBrowse(entry: BrowseEntry) {
        if (entry.type === 'browse-file') {
            const path = entry.fullPath;
            this.exitBrowseMode();
            this.input.value = path;
            this.setResults([]);
            this.open(path);
        } else {
            this.browseMode.currentPath = entry.fullPath;
            this.browseMode.filter = '';
            this.input.value = entry.fullPath === '/' ? '/' : entry.fullPath + '/';
            this.selectedIndex = 0;
            await this.refreshBrowseEntries();
        }
    }

    private exitBrowseMode() {
        this.browseMode = { active: false, currentPath: '/', filter: '' };
        this.updateStateIcon();
        this.input.placeholder = '';
    }

    // -----------------------------------------------------------------------
    // Settings mode
    // -----------------------------------------------------------------------
    private enterSettingsMode() {
        if (!this.host.buildSettingsEntries) return;
        this.settingsMode = { active: true, filter: '', editing: null };
        this.setGlyph(COG_ICON);
        this.input.value = 'settings/';
        this.input.placeholder = '';
        this.input.focus();
        this.selectedIndex = 0;
        this.setResults(this.host.buildSettingsEntries(''));
        document.addEventListener("click", this.handleClickOutsideBound);
    }

    private exitSettingsMode() {
        this.settingsMode = { active: false, filter: '', editing: null };
        this.updateStateIcon();
        this.input.placeholder = '';
    }

    private handleSettingsEntry(entry: SettingsEntry) {
        if (entry.type === 'settings-action' && entry.settingKey === 'clearFilesystem') {
            this.exitSettingsMode();
            this.enterClearFilesystemConfirm();
            return;
        }
        this.host.handleSettingsEntry?.(entry);
        if (entry.type === 'settings-input') {
            this.settingsMode.editing = entry.settingKey;
            this.input.value = entry.currentValue;
            this.input.select();
        }
    }

    refreshSettingsEntries() {
        if (!this.settingsMode.active || !this.host.buildSettingsEntries) return;
        const entries = this.host.buildSettingsEntries(this.settingsMode.filter);
        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, entries.length - 1));
        this.setResults(entries);
    }

    private confirmSettingsEdit() {
        if (!this.settingsMode.editing) return;
        this.host.confirmSettingsEdit?.(this.settingsMode.editing, this.input.value.trim());
        this.settingsMode.editing = null;
        this.input.value = 'settings/' + this.settingsMode.filter;
        queueMicrotask(() => this.refreshSettingsEntries());
    }

    private cancelSettingsEdit() {
        this.settingsMode.editing = null;
        this.input.value = 'settings/' + this.settingsMode.filter;
    }

    // -----------------------------------------------------------------------
    // Delete mode
    // -----------------------------------------------------------------------
    private enterDeleteMode(filePath: string) {
        this.deleteMode = { active: true, filePath };
        this.setGlyph('\u2717');
        this.input.value = '';
        this.input.placeholder = `Delete "${filePath}"? (Enter to confirm, Esc to cancel)`;
        this.input.focus();
        this.setResults([]);
    }

    private exitDeleteMode() {
        this.deleteMode = { active: false, filePath: '' };
        this.updateStateIcon();
        this.input.placeholder = '';
    }

    private async confirmDelete() {
        if (!this.deleteMode.active) return;
        const path = this.deleteMode.filePath;
        try {
            const currentPath = this.getCurrentFilePath();
            const wasOpen = currentPath === path;
            // Put down first, so no pending save lands after the delete and
            // brings the file back.
            if (wasOpen) await this.host.closeFile();
            await this.fileOps.remove(path).catch(e => console.warn('Delete failed:', e));
            this.host.notifyFileChanged?.(path, FileChangeType.Deleted);
            this.exitDeleteMode();
            this.setResults([]);
            this.resetInputToCurrentFile();
            if (wasOpen) this.input.value = '';
        } catch (e) {
            console.error('Failed to delete file:', e);
            this.exitDeleteMode();
        }
    }

    // -----------------------------------------------------------------------
    // Clear filesystem confirmation
    // -----------------------------------------------------------------------
    private clearFilesystemPending = false;

    private enterClearFilesystemConfirm() {
        this.clearFilesystemPending = true;
        this.setGlyph('\u2717');
        this.input.value = '';
        this.input.placeholder = 'Delete every file here? (Enter to confirm, Esc to cancel)';
        this.input.focus();
        this.setResults([]);
    }

    private exitClearFilesystemConfirm() {
        this.clearFilesystemPending = false;
        this.updateStateIcon();
        this.input.placeholder = '';
    }

    private async confirmClearFilesystem() {
        if (!this.clearFilesystemPending) return;
        this.exitClearFilesystemConfirm();
        this.setResults([]);
        this.resetInputToCurrentFile();
        await this.host.onClearFilesystem?.();
    }

    // -----------------------------------------------------------------------
    // Overwrite mode
    // -----------------------------------------------------------------------
    private enterOverwriteMode(filePath: string, action: OverwriteMode['action'], oldPath?: string) {
        this.overwriteMode = { active: true, filePath, action, oldPath };
        this.setGlyph('\u26A0');
        this.input.value = '';
        this.input.placeholder = `"${filePath}" exists. Overwrite? (Enter/Esc)`;
        this.input.focus();
        this.setResults([]);
    }

    private exitOverwriteMode() {
        this.overwriteMode = { active: false, filePath: '', action: 'create-file' };
        this.updateStateIcon();
        this.input.placeholder = '';
    }

    private async confirmOverwrite() {
        if (!this.overwriteMode.active) return;
        const { filePath, action, oldPath } = this.overwriteMode;
        this.exitOverwriteMode();
        if (action === 'save-as') { this.input.value = filePath; await this.createAndOpenFile(filePath); }
        else if (action === 'create-file') { this.input.value = filePath; await this.createBlankFile(filePath); }
        else if (action === 'rename' && oldPath) { this.input.value = filePath; await this.performRename(oldPath, filePath); }
    }

    private async checkOverwriteAndExecute(path: string, action: OverwriteMode['action'], execute: () => void | Promise<void>, oldPath?: string) {
        // A rename to another spelling of the same name is not a replacement,
        // even where the disk says a file of that name exists (it is this one).
        const exists = await pathTaken(this.host.fs, path, action === 'rename' ? oldPath : undefined);
        if (exists) this.enterOverwriteMode(path, action, oldPath);
        else await execute();
    }

    // -----------------------------------------------------------------------
    // File operations
    // -----------------------------------------------------------------------
    private async createBlankFile(pathToOpen: string) {
        // Reaching here with a file at the path means the overwrite was confirmed.
        await this.fileOps.create(pathToOpen, '', { overwrite: true }).catch(console.error);
        this.host.notifyFileChanged?.(pathToOpen, FileChangeType.Created);
        this.setResults([]);
        this.open(pathToOpen);
    }

    private async createAndOpenFile(pathToOpen: string) {
        await this.fileOps.create(pathToOpen, this.host.getDocContent(), { overwrite: true }).catch(console.error);
        this.host.notifyFileChanged?.(pathToOpen, FileChangeType.Created);
        this.setResults([]);
        this.open(pathToOpen);
    }

    private async performRename(oldPath: string, newPath: string) {
        try {
            // The open document is the file being moved: its edits go first.
            await this.host.persist();
            // Reaching here with a file at `newPath` means the overwrite was confirmed.
            if (await pathTaken(this.host.fs, newPath, oldPath)) await this.fileOps.remove(newPath);
            await this.fileOps.rename(oldPath, newPath);
        } catch (e) {
            console.error(`Rename of ${oldPath} to ${newPath} failed:`, e);
            return;
        }
        this.host.notifyFileChanged?.(oldPath, FileChangeType.Deleted);
        this.host.notifyFileChanged?.(newPath, FileChangeType.Created);
        this.setResults([]);
        this.open(newPath, { skipSave: true });
    }

    private async importFiles(files: FileList) {
        for (const file of files) {
            const path = file.webkitRelativePath || file.name;
            // As bytes, whatever the name says: decoding as text would change
            // a file that is not UTF-8 (or strip a BOM), and the editor tells
            // text from bytes when it opens the file.
            await this.fileOps.create(path, new Uint8Array(await file.arrayBuffer()), { overwrite: true });
            this.host.notifyFileChanged?.(path, FileChangeType.Created);
        }
        if (files.length > 0) {
            const first = files[0].webkitRelativePath || files[0].name;
            this.open(first);
        }
    }

    private triggerFileImport(folder: boolean) {
        this.setResults([]);
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        if (folder) fileInput.setAttribute('webkitdirectory', '');
        else fileInput.multiple = true;
        fileInput.addEventListener('change', () => { if (fileInput.files?.length) this.importFiles(fileInput.files); });
        fileInput.click();
    }

    // -----------------------------------------------------------------------
    // Input helpers
    // -----------------------------------------------------------------------
    resetInputToCurrentFile() {
        const currentPath = this.getCurrentFilePath();
        this.input.value = this.shownAs ?? (currentPath || this.host.language || '');
        this.fieldChanged();
    }

    private handleClickOutside(event: Event) {
        if (!this.dom.contains(event.target as Node)) {
            if (this.settingsMode.active) this.exitSettingsMode();
            if (this.browseMode.active) this.exitBrowseMode();
            this.setResults([]);
            this.resetInputToCurrentFile();
        }
    }

    // -----------------------------------------------------------------------
    // Input event handlers
    // -----------------------------------------------------------------------
    /** A query starting `>` asks for the host's commands alone (as in a
     *  command palette): no files, no file commands. */
    private commandsOnly(query: string): CommandResult[] | null {
        if (!query.startsWith('>') || !this.host.commands) return null;
        return this.host.commands(query).map((command) => ({
            id: command.id, type: 'host-command' as const, icon: command.icon ?? '\uf120', query, action: () => command.run(),
        }));
    }

    /** Files matching `query`, from the host's search. */
    private async searchFiles(query: string, limit: number): Promise<FileResult[]> {
        if (!this.host.search || !query.trim()) return [];
        const hits = await this.host.search.search(query, { limit }).catch(() => []);
        return hits.map((hit) => ({ ...hit, id: hit.path }));
    }

    private async onInputClick() {
        if (this.namingMode.active || this.settingsMode.active || this.browseMode.active) return;
        this.resultsExpanded = false;
        const query = this.input.value;
        const token = ++this.searchToken;
        const onlyCommands = this.commandsOnly(query);
        if (onlyCommands) {
            this.setResults(onlyCommands);
            document.addEventListener("click", this.handleClickOutsideBound);
            return;
        }
        await this.asCurrentSearch(async () => {
            let results: SearchResult[] = [];
            if (query.trim()) {
                // Even on the "untouched" path (user just clicked into the
                // input without typing, so input.value is the current file
                // path), we still need to run the FS search so
                // `createCommandResults` can detect that the query matches
                // an existing file. Without this, `hasExactFileMatch` is
                // always false on first open and the dropdown shows
                // nonsensical "Create new file 'X'" / "Rename to 'X'"
                // entries for the file the user already has open.
                const searchResults: SearchResult[] = await this.searchFiles(query, 100);
                if (token !== this.searchToken) return;
                if (!this.inputTouched) {
                    results = this.createCommandResults(query, searchResults);
                } else {
                    const commands = this.createCommandResults(query, searchResults);
                    const { intent } = this.detectIntent(query, searchResults);
                    results = this.prioritizeResults(searchResults, commands, intent);
                }
            } else {
                results = this.createCommandResults('', []);
            }
            this.setResults(results);
            document.addEventListener("click", this.handleClickOutsideBound);
        });
    }

    private async onInputChange(event: Event) {
        const query = (event.target as HTMLInputElement).value;
        const token = ++this.searchToken;
        this.selectedIndex = 0;
        this.inputTouched = true;
        this.resultsExpanded = false;

        if (this.deleteMode.active || this.overwriteMode.active || this.clearFilesystemPending) { this.input.value = ''; return; }
        if (this.namingMode.active) return;
        if (this.settingsMode.active && this.settingsMode.editing) return;

        if (this.settingsMode.active) {
            const prefix = 'settings/';
            this.settingsMode.filter = query.startsWith(prefix) ? query.slice(prefix.length) : query;
            this.refreshSettingsEntries();
            return;
        }
        if (this.browseMode.active) {
            const prefix = this.browseMode.currentPath === '/' ? '/' : this.browseMode.currentPath + '/';
            const filter = query.startsWith(prefix) ? query.slice(prefix.length) : query;
            // If the user has typed a complete filename inside the browsed
            // directory (e.g. `src/example.md`), they're creating a file, not
            // navigating — leave browse mode and fall through to the normal
            // search/create flow so the create-file commands are offered for
            // the full path. Otherwise keep filtering the directory listing.
            if (ToolbarCore.COMPLETE_FILENAME.test(filter.trim())) {
                this.exitBrowseMode();
            } else {
                this.browseMode.filter = filter;
                this.refreshBrowseEntries();
                return;
            }
        }

        const onlyCommands = this.commandsOnly(query);
        if (onlyCommands) {
            this.lastIntent = 'command';
            this.cancelAiClassify();
            this.setResults(onlyCommands);
            return;
        }
        await this.asCurrentSearch(async () => {
            let results: SearchResult[] = [];
            if (query.trim()) {
                const searchResults: SearchResult[] = await this.searchFiles(ToolbarCore.splitLines(query).file, 200);
                if (token !== this.searchToken) return;
                const commands = this.createCommandResults(query, searchResults);
                const { intent, confidence } = this.detectIntent(query, searchResults);
                this.lastIntent = intent;

                // Auto-enter modes for high-confidence structural intents
                if (confidence >= 0.85) {
                    if (intent === 'browse' && query.endsWith('/')) {
                        this.enterBrowseMode(query === '/' ? '/' : query.replace(/\/+$/, ''));
                        return;
                    }
                    if (intent === 'settings' && /^settings?\/?$/i.test(query.trim())) {
                        this.enterSettingsMode();
                        return;
                    }
                }

                results = this.prioritizeResults(searchResults, commands, intent);

                // Schedule AI classification for low-confidence intents
                this.scheduleAiClassify(query, searchResults, commands, confidence);
            } else {
                this.lastIntent = 'unknown';
                results = this.createCommandResults('', []);
                this.cancelAiClassify();
            }
            this.setResults(results);
        });
    }

    /**
     * Schedule a debounced AI intent classification request.
     * Only fires when heuristic confidence is low and AI is available.
     */
    private scheduleAiClassify(
        query: string,
        fileResults: SearchResult[],
        commands: CommandResult[],
        confidence: number,
    ) {
        this.cancelAiClassify();
        if (confidence >= 0.75 || !this.host.classifyIntent) return;

        this.aiClassifyTimer = setTimeout(async () => {
            const ctrl = new AbortController();
            this.aiClassifyAbort = ctrl;
            try {
                const aiIntent = await this.host.classifyIntent!(query, {
                    currentFile: this.getCurrentFilePath(),
                });
                if (ctrl.signal.aborted || !aiIntent) return;
                // Only re-prioritize if the input hasn't changed
                if (this.input.value === query) {
                    this.lastIntent = aiIntent;
                    const reordered = this.prioritizeResults(fileResults, commands, aiIntent);
                    this.setResults(reordered);
                }
            } catch { /* AI unavailable — silently degrade */ }
        }, 500);
    }

    private cancelAiClassify() {
        if (this.aiClassifyTimer) { clearTimeout(this.aiClassifyTimer); this.aiClassifyTimer = null; }
        if (this.aiClassifyAbort) { this.aiClassifyAbort.abort(); this.aiClassifyAbort = null; }
    }

    private onInputKeydown(event: KeyboardEvent) {
        // Clear filesystem confirmation
        if (this.clearFilesystemPending) {
            if (event.key === "Enter") { event.preventDefault(); this.confirmClearFilesystem(); }
            else if (event.key === "Escape") { event.preventDefault(); this.exitClearFilesystemConfirm(); this.resetInputToCurrentFile(); }
            event.preventDefault();
            return;
        }
        // Overwrite confirmation
        if (this.overwriteMode.active) {
            if (event.key === "Enter") { event.preventDefault(); this.confirmOverwrite(); }
            else if (event.key === "Escape") { event.preventDefault(); this.exitOverwriteMode(); this.resetInputToCurrentFile(); }
            event.preventDefault();
            return;
        }
        // Delete confirmation
        if (this.deleteMode.active) {
            if (event.key === "Enter") { event.preventDefault(); this.confirmDelete(); }
            else if (event.key === "Escape") { event.preventDefault(); this.exitDeleteMode(); this.resetInputToCurrentFile(); }
            event.preventDefault();
            return;
        }
        // Naming mode
        if (this.namingMode.active) {
            if (event.key === "Enter") { event.preventDefault(); this.executeNamingMode(this.input.value); }
            else if (event.key === "Escape") { event.preventDefault(); this.exitNamingMode(); this.input.value = this.namingMode.originalQuery; }
            return;
        }
        // Settings mode
        if (this.settingsMode.active) {
            const results = this.results;
            if (this.settingsMode.editing) {
                if (event.key === "Enter") { event.preventDefault(); this.confirmSettingsEdit(); }
                else if (event.key === "Escape") { event.preventDefault(); this.cancelSettingsEdit(); }
                return;
            }
            if (event.key === "ArrowDown") { event.preventDefault(); if (results.length) { this.selectedIndex = mod(this.selectedIndex + 1, results.length); this.highlightSelection(true); } }
            else if (event.key === "ArrowUp") { event.preventDefault(); if (results.length) { this.selectedIndex = mod(this.selectedIndex - 1, results.length); this.highlightSelection(true); } }
            else if (event.key === "Enter" && results.length && this.selectedIndex >= 0) { event.preventDefault(); this.selectResult(results[this.selectedIndex]); }
            else if (event.key === "Backspace") { if (this.settingsMode.filter === '') { event.preventDefault(); this.exitSettingsMode(); this.setResults([]); this.resetInputToCurrentFile(); } }
            else if (event.key === "Escape") { event.preventDefault(); this.exitSettingsMode(); this.setResults([]); this.resetInputToCurrentFile(); this.input.blur(); }
            return;
        }
        // Browse mode
        if (this.browseMode.active) {
            const results = this.results;
            if (event.key === "ArrowDown") { event.preventDefault(); if (results.length) { this.selectedIndex = mod(this.selectedIndex + 1, results.length); this.highlightSelection(true); } }
            else if (event.key === "ArrowUp") { event.preventDefault(); if (results.length) { this.selectedIndex = mod(this.selectedIndex - 1, results.length); this.highlightSelection(true); } }
            else if (event.key === "Enter" && results.length && this.selectedIndex >= 0) { event.preventDefault(); this.selectResult(results[this.selectedIndex]); }
            else if (event.key === "Backspace") {
                if (this.browseMode.filter === '' && this.browseMode.currentPath !== '/') {
                    event.preventDefault();
                    const parentPath = this.browseMode.currentPath.split('/').slice(0, -1).join('/') || '/';
                    this.browseMode.currentPath = parentPath;
                    this.input.value = parentPath === '/' ? '/' : parentPath + '/';
                    this.refreshBrowseEntries();
                }
            }
            else if (event.key === "Delete" && results.length && this.selectedIndex >= 0) {
                const result = results[this.selectedIndex];
                if (isBrowseEntry(result) && result.type === 'browse-file') {
                    event.preventDefault(); this.exitBrowseMode(); this.enterDeleteMode(result.fullPath);
                }
            }
            else if (event.key === "Escape") { event.preventDefault(); this.exitBrowseMode(); this.setResults([]); this.resetInputToCurrentFile(); this.input.blur(); }
            return;
        }
        // Normal search mode — navigate visibleItems
        if (event.key === "ArrowDown") {
            event.preventDefault();
            if (this.visibleItems.length) { this.selectedIndex = mod(this.selectedIndex + 1, this.visibleItems.length); this.highlightSelection(true); }
            else { this.host.focusEditor(); }
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (this.visibleItems.length) { this.selectedIndex = mod(this.selectedIndex - 1, this.visibleItems.length); this.highlightSelection(true); }
        } else if (event.key === "Enter" && (this.searching || (this.visibleItems.length && this.selectedIndex >= 0))) {
            event.preventDefault();
            void this.enterSelected();
        } else if (event.key === "Delete" && this.visibleItems.length && this.selectedIndex >= 0) {
            const item = this.visibleItems[this.selectedIndex];
            if (item !== SHOW_MORE_SENTINEL && !isCommandResult(item) && !isBrowseEntry(item) && !isSettingsEntry(item)) {
                event.preventDefault(); this.enterDeleteMode(item.id);
            }
        } else if (event.key === "Escape") {
            event.preventDefault(); this.dropSearch(); this.setResults([]); this.resetInputToCurrentFile(); this.input.blur();
        }
    }

    /** Enter on the selected result of what is typed now: while its search
     *  runs, the list shown belongs to an earlier keystroke. */
    private async enterSelected() {
        const query = this.input.value;
        while (this.searching) await this.searching;
        if (this.input.value !== query) return;
        if (!this.visibleItems.length || this.selectedIndex < 0) return;
        const item = this.visibleItems[this.selectedIndex];
        if (item === SHOW_MORE_SENTINEL) this.expandResults();
        else this.selectResult(item);
    }

    // -----------------------------------------------------------------------
    // Mode queries (for host adapters)
    // -----------------------------------------------------------------------
    isSettingsModeActive(): boolean { return this.settingsMode.active; }
    isBrowseModeActive(): boolean { return this.browseMode.active; }
    isNamingModeActive(): boolean { return this.namingMode.active; }
    /** The most recently detected intent from the toolbar input. */
    getLastIntent(): ToolbarIntent { return this.lastIntent; }
    isAnyModeActive(): boolean {
        return this.namingMode.active || this.settingsMode.active ||
            this.browseMode.active || this.deleteMode.active || this.overwriteMode.active ||
            this.clearFilesystemPending;
    }
}
