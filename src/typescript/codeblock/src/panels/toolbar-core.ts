/**
 * Shared toolbar core — host-agnostic toolbar logic for file search, browse,
 * naming, delete/overwrite confirmation, settings, and import.
 *
 * Both the CodeMirror panel adapter (toolbar.ts) and the Tiptap/ProseMirror
 * adapter (markdown-editor toolbar.ts) instantiate ToolbarCore with
 * host-specific callbacks.
 */

import { HighlightedSearch, SearchIndex } from "../utils/search";
import { extOrLanguageToLanguageId } from "../lsps";
import { Seti } from "@m234/nerd-fonts/fs";
import type { VfsInterface } from "../types";
import { StyleModule } from "style-mod";
import { vscodeStyleMod } from "../themes/vscode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type NerdIcon = { value: string; hexCode: number; color?: string };

export interface CommandResult {
    id: string;
    type: 'create-file' | 'save-as' | 'rename-file' | 'import-local-files' | 'import-local-folder' | 'open-file' | 'settings' | 'open-terminal' | 'file-action' | 'clear-filesystem';
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

export type SearchResult = HighlightedSearch | CommandResult | BrowseEntry | SettingsEntry;

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
    | 'command'        // Wants a specific command (import, terminal)
    | 'language'       // Typed a language name
    | 'unknown';       // Can't determine intent

// ---------------------------------------------------------------------------
// Host interface — implemented by CM and Tiptap adapters
// ---------------------------------------------------------------------------
export interface ToolbarHost {
    fs: VfsInterface;
    index?: SearchIndex;
    cwd?: string;
    filepath?: string;
    language?: string;

    /** Tell the host to open a file. */
    openFile(path: string, options?: { skipSave?: boolean }): void;
    /** Get the current document content (for save-as). */
    getDocContent(): string;
    /** Move focus from toolbar to editor body. */
    focusEditor(): void;
    /** Notify that a file was created/changed/deleted on the VFS. */
    notifyFileChanged?(path: string, type: number): void;
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

    // Terminal command visibility
    hasTerminal?: boolean;
    onEnterTerminal?(): void;

    /** Clear the filesystem and all related persistent storage. */
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
export const FOLDER_OPEN_ICON = '\ue614';
const PARENT_DIR_ICON = '\uf112';
export const TERMINAL_ICON = '\uf120';

const BINARY_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);
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

// Nerd font injection (idempotent)
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

// ---------------------------------------------------------------------------
// File import helper
// ---------------------------------------------------------------------------
function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ---------------------------------------------------------------------------
// Standalone toolbar styles (not scoped to .cm-editor)
// ---------------------------------------------------------------------------
const FS = 'var(--cm-font-size, 16px)';

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
        fontSize: FS,
        color: 'var(--cm-toolbar-color)',
        padding: '0 2px 0 6px',
        width: '100%',
        flex: '1',
    },
    '.cm-toolbar-input-container': {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        flex: '1',
    },
    '.cm-toolbar-state-icon-container': {
        width: 'var(--cm-gutter-width, 2em)',
        minWidth: 'var(--cm-icon-col-width, 2em)',
        display: 'flex',
    },
    '.cm-toolbar-state-icon': {
        fontSize: FS,
        color: 'var(--cm-foreground)',
        fontFamily: 'var(--cm-icon-font-family)',
        paddingRight: 'calc(1ch + 3px)',
        textAlign: 'right',
        boxSizing: 'border-box',
        width: 'var(--cm-gutter-lineno-width, 2em)',
        minWidth: 'var(--cm-icon-col-width, 2em)',
        transition: 'opacity 0.15s ease',
    },
    '.cm-search-results': {
        position: 'absolute',
        top: '100%',
        margin: '0',
        padding: '0',
        background: 'var(--cm-toolbar-background)',
        fontFamily: 'var(--cm-font-family)',
        fontSize: FS,
        listStyleType: 'none',
        width: '100%',
        maxHeight: `calc(${FS} * 1.4 * 10)`,
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
                fontSize: FS,
                textAlign: 'right',
                paddingRight: 'calc(1ch + 3px)',
                boxSizing: 'border-box',
                width: 'var(--cm-gutter-lineno-width, 2em)',
                minWidth: 'var(--cm-icon-col-width, 2em)',
            },
        },
        '&:hover': {
            '& div': { color: 'var(--cm-search-result-color-hover)' },
            backgroundColor: 'var(--cm-search-result-bg-hover)',
        },
        '&.selected': {
            '& div': { color: 'var(--cm-search-result-color-selected)' },
            backgroundColor: 'var(--cm-search-result-select-bg)',
        },
        '& > .cm-search-result-label': {
            flex: '1',
            padding: '0 2px 0 6px',
        },
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

    private host: ToolbarHost;
    private selectedIndex = 0;
    private namingMode: NamingMode = { active: false, type: 'create-file', originalQuery: '' };
    private browseMode: BrowseMode = { active: false, currentPath: '/', filter: '' };
    private settingsMode: SettingsMode = { active: false, filter: '', editing: null };
    private deleteMode: DeleteMode = { active: false, filePath: '' };
    private overwriteMode: OverwriteMode = { active: false, filePath: '', action: 'create-file' };
    private inputTouched = false;
    private resultsExpanded = false;
    private visibleItems: VisibleItem[] = [];
    private results: SearchResult[] = [];
    private currentFilePath: string | null;
    private handleClickOutsideBound: (event: Event) => void;

    // AI intent classification state
    private aiClassifyTimer: ReturnType<typeof setTimeout> | null = null;
    private aiClassifyAbort: AbortController | null = null;
    private lastIntent: ToolbarIntent = 'unknown';

    constructor(host: ToolbarHost) {
        this.host = host;
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
        this.stateIcon.textContent = SEARCH_ICON;
        this.stateIconContainer.appendChild(this.stateIcon);
        this.dom.appendChild(this.stateIconContainer);

        this.inputContainer = document.createElement("div");
        this.inputContainer.className = "cm-toolbar-input-container";
        this.input = document.createElement("input");
        this.input.type = "text";
        this.input.value = host.filepath || host.language || "";
        this.input.className = "cm-toolbar-input";
        this.inputContainer.appendChild(this.input);
        this.dom.appendChild(this.inputContainer);

        this.resultsList = document.createElement("ul");
        this.resultsList.className = "cm-search-results";
        this.dom.appendChild(this.resultsList);

        // --- Event wiring ---
        this.handleClickOutsideBound = this.handleClickOutside.bind(this);

        this.input.addEventListener("click", () => this.onInputClick());
        this.input.addEventListener("input", (e) => this.onInputChange(e));
        this.input.addEventListener("keydown", (e) => this.onInputKeydown(e));
    }

    // -----------------------------------------------------------------------
    // Public API — called by host adapters
    // -----------------------------------------------------------------------

    /** Update the current file path (called when the host opens a new file). */
    setFilePath(path: string | null) {
        this.currentFilePath = path;
        if (!this.namingMode.active && !this.settingsMode.active) {
            this.input.value = path || '';
            this.inputTouched = false;
        }
    }

    /** Get the current search results. */
    getResults(): SearchResult[] { return this.results; }

    destroy() {
        this.cancelAiClassify();
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
        const hasExactFileMatch = searchResults.length > 0 && searchResults[0].id === query;

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

        // Terminal
        if (this.host.hasTerminal) {
            commands.push({ id: 'Open terminal', type: 'open-terminal', icon: TERMINAL_ICON, query: '' });
        }

        // Import
        commands.push({ id: 'Import file(s)', type: 'import-local-files', icon: '\uf15b', query: '' });
        commands.push({ id: 'Import folder', type: 'import-local-folder', icon: FOLDER_ICON, query: '' });

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

        // Settings
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
        [/^(terminal|term|shell|bash|sh|console)\b/i, 'command'],
        [/^(settings?|config|prefs?|preferences?|options?)\b/i, 'settings'],
        [/^(theme|dark|light|font|color)\b/i, 'settings'],
    ];

    /**
     * Analyze input query to detect user intent using heuristics.
     * Returns a confidence-weighted intent.
     */
    private detectIntent(query: string, hasFileResults: boolean): { intent: ToolbarIntent; confidence: number } {
        const q = query.trim();
        if (!q) return { intent: 'unknown', confidence: 0 };
        const ql = q.toLowerCase();

        // Direct path: contains slash or starts with dot — clearly looking for a file
        if (q.includes('/')) {
            if (q.endsWith('/')) return { intent: 'browse', confidence: 0.9 };
            return { intent: 'file-search', confidence: 0.85 };
        }
        if (q.startsWith('.')) return { intent: 'file-search', confidence: 0.8 };

        // File extension pattern: e.g. "main.ts", "readme.md"
        if (/\.\w{1,10}$/.test(q)) return { intent: 'file-search', confidence: 0.8 };

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
                // Promote create/save-as commands above file results
                const create = commands.filter(c => c.type === 'create-file' || c.type === 'save-as');
                const rest = commands.filter(c => c.type !== 'create-file' && c.type !== 'save-as');
                return [...create, ...fileResults, ...rest];
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
                // Promote terminal and import commands
                const promoted = commands.filter(c =>
                    c.type === 'open-terminal' || c.type === 'import-local-files' || c.type === 'import-local-folder');
                const rest = commands.filter(c =>
                    c.type !== 'open-terminal' && c.type !== 'import-local-files' && c.type !== 'import-local-folder');
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
        li.appendChild(resultLabel);

        if (i === this.selectedIndex) li.classList.add("selected");
        li.addEventListener("mousedown", (ev) => ev.preventDefault());
        li.addEventListener("click", (ev) => { ev.stopPropagation(); this.selectResult(result); });
        return li;
    }

    private updateDropdown() {
        const results = this.results;
        const children: HTMLElement[] = [];

        const fileResults: SearchResult[] = [];
        const commandResults: SearchResult[] = [];
        for (const r of results) {
            if (!isCommandResult(r) && !isBrowseEntry(r) && !isSettingsEntry(r)) fileResults.push(r);
            else commandResults.push(r);
        }

        const total = fileResults.length;
        const shouldCollapse = !this.resultsExpanded && total > MAX_COLLAPSED_FILE_RESULTS;
        const visibleFileCount = shouldCollapse ? MAX_COLLAPSED_FILE_RESULTS - 1 : total;
        const hiddenCount = total - visibleFileCount;

        this.visibleItems = [];
        for (let i = 0; i < visibleFileCount; i++) this.visibleItems.push(fileResults[i]);
        if (shouldCollapse) this.visibleItems.push(SHOW_MORE_SENTINEL);
        for (const cmd of commandResults) this.visibleItems.push(cmd);

        this.visibleItems.forEach((item, i) => {
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
                li.addEventListener("click", ev => { ev.stopPropagation(); this.expandResults(); });
                children.push(li);
            } else {
                children.push(this.renderItem(item, i));
            }
        });

        this.resultsList.replaceChildren(...children);
        const sel = this.resultsList.querySelector('.selected') as HTMLElement;
        if (sel) sel.scrollIntoView({ block: 'nearest' });
    }

    private expandResults() {
        this.resultsExpanded = true;
        this.selectedIndex = 0;
        this.updateDropdown();
    }

    // -----------------------------------------------------------------------
    // Result selection
    // -----------------------------------------------------------------------
    private selectResult(result: SearchResult) {
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

    private handleSearchResult(result: HighlightedSearch) {
        this.input.value = result.id;
        this.setResults([]);
        this.host.openFile(result.id);
    }

    private handleCommandResult(command: CommandResult) {
        if (command.type === 'settings') {
            this.enterSettingsMode();
        } else if (command.type === 'open-file') {
            this.enterBrowseMode();
        } else if (command.type === 'open-terminal') {
            this.setResults([]);
            this.host.onEnterTerminal?.();
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
        } else if (command.type === 'file-action' && command.action) {
            this.setResults([]);
            command.action();
        }
    }

    // -----------------------------------------------------------------------
    // State icon
    // -----------------------------------------------------------------------
    updateStateIcon() {
        if (this.namingMode.active) {
            this.stateIcon.textContent = (this.namingMode.type === 'create-file' || this.namingMode.type === 'save-as') ? DEFAULT_FILE_ICON : '\uf044';
        } else if (this.settingsMode.active) {
            this.stateIcon.textContent = COG_ICON;
        } else {
            this.stateIcon.textContent = SEARCH_ICON;
        }
    }

    // -----------------------------------------------------------------------
    // Naming mode
    // -----------------------------------------------------------------------
    private enterNamingMode(type: NamingMode['type'], originalQuery: string, languageExtension?: string) {
        this.namingMode = { active: true, type, originalQuery, languageExtension };
        this.updateStateIcon();
        this.input.value = '';
        this.input.placeholder = languageExtension ? `filename.${languageExtension}` : 'filename';
        this.input.focus();
        this.setResults([]);
    }

    private exitNamingMode() {
        this.namingMode = { active: false, type: 'create-file', originalQuery: '' };
        this.updateStateIcon();
        this.input.placeholder = '';
    }

    private executeNamingMode(filename: string) {
        if (!this.namingMode.active || !filename.trim()) return;
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
        this.stateIcon.textContent = FOLDER_OPEN_ICON;
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
            this.host.openFile(path);
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
        this.stateIcon.textContent = COG_ICON;
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
        this.stateIcon.textContent = '\u2717';
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
        const { fs, index } = this.host;
        try {
            const currentPath = this.getCurrentFilePath();
            const wasOpen = currentPath === path;
            await fs.unlink(path).catch(e => console.warn('VFS unlink failed:', e));
            if (index) {
                try { index.index.discard(path); } catch { }
                if (index.savePath) index.save(fs, index.savePath);
            }
            this.host.notifyFileChanged?.(path, FileChangeType.Deleted);
            this.exitDeleteMode();
            this.setResults([]);
            this.resetInputToCurrentFile();
            if (wasOpen) {
                this.host.openFile('');
                this.input.value = '';
            }
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
        this.stateIcon.textContent = '\u2717';
        this.input.value = '';
        this.input.placeholder = 'Clear all files and storage? (Enter to confirm, Esc to cancel)';
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
        this.stateIcon.textContent = '\u26A0';
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
        const exists = await this.host.fs.exists(path);
        if (exists) this.enterOverwriteMode(path, action, oldPath);
        else await execute();
    }

    // -----------------------------------------------------------------------
    // File operations
    // -----------------------------------------------------------------------
    private async createBlankFile(pathToOpen: string) {
        const { fs, index } = this.host;
        const dir = pathToOpen.substring(0, pathToOpen.lastIndexOf('/'));
        if (dir) await fs.mkdir(dir, { recursive: true }).catch(() => {});
        await fs.writeFile(pathToOpen, '').catch(console.error);
        if (index) { index.add(pathToOpen); if (index.savePath) index.save(fs, index.savePath); }
        this.setResults([]);
        this.host.openFile(pathToOpen);
    }

    private async createAndOpenFile(pathToOpen: string) {
        const { fs, index } = this.host;
        const content = this.host.getDocContent();
        const dir = pathToOpen.substring(0, pathToOpen.lastIndexOf('/'));
        if (dir) await fs.mkdir(dir, { recursive: true }).catch(() => {});
        await fs.writeFile(pathToOpen, content).catch(console.error);
        if (index) { index.add(pathToOpen); if (index.savePath) index.save(fs, index.savePath); }
        this.setResults([]);
        this.host.openFile(pathToOpen);
    }

    private async performRename(oldPath: string, newPath: string) {
        const { fs, index } = this.host;
        const content = this.host.getDocContent();
        const dir = newPath.substring(0, newPath.lastIndexOf('/'));
        if (dir) await fs.mkdir(dir, { recursive: true }).catch(() => {});
        await fs.writeFile(newPath, content).catch(console.error);
        await fs.unlink(oldPath).catch(e => console.warn('VFS unlink failed during rename:', e));
        if (index) {
            try { index.index.discard(oldPath); } catch { }
            index.add(newPath);
            if (index.savePath) index.save(fs, index.savePath);
        }
        this.host.notifyFileChanged?.(oldPath, FileChangeType.Deleted);
        this.host.notifyFileChanged?.(newPath, FileChangeType.Created);
        this.setResults([]);
        this.host.openFile(newPath, { skipSave: true });
    }

    private async importFiles(files: FileList) {
        const { fs, index } = this.host;
        for (const file of files) {
            const path = file.webkitRelativePath || file.name;
            const dir = path.substring(0, path.lastIndexOf('/'));
            if (dir) await fs.mkdir(dir, { recursive: true });
            const ext = path.split('.').pop()?.toLowerCase() || '';
            if (BINARY_IMAGE_EXTS.has(ext)) {
                await fs.writeFile(path, await fileToDataUrl(file));
            } else {
                await fs.writeFile(path, await file.text());
            }
            if (index) index.add(path);
            this.host.notifyFileChanged?.(path, FileChangeType.Created);
        }
        if (index?.savePath) await index.save(fs, index.savePath);
        if (files.length > 0) {
            const first = files[0].webkitRelativePath || files[0].name;
            this.host.openFile(first);
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
        this.input.value = currentPath || this.host.language || '';
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
    private onInputClick() {
        if (this.namingMode.active || this.settingsMode.active || this.browseMode.active) return;
        this.resultsExpanded = false;
        const query = this.input.value;
        let results: SearchResult[] = [];
        if (query.trim()) {
            if (!this.inputTouched) {
                results = this.createCommandResults(query, []);
            } else {
                const searchResults: SearchResult[] = (this.host.index?.search(query) || []).slice(0, 100);
                const commands = this.createCommandResults(query, searchResults);
                const { intent } = this.detectIntent(query, searchResults.length > 0);
                results = this.prioritizeResults(searchResults, commands, intent);
            }
        } else {
            results = this.createCommandResults('', []);
        }
        this.setResults(results);
        document.addEventListener("click", this.handleClickOutsideBound);
    }

    private onInputChange(event: Event) {
        const query = (event.target as HTMLInputElement).value;
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
            this.browseMode.filter = query.startsWith(prefix) ? query.slice(prefix.length) : query;
            this.refreshBrowseEntries();
            return;
        }

        let results: SearchResult[] = [];
        if (query.trim()) {
            const searchResults: SearchResult[] = (this.host.index?.search(query) || []).slice(0, 1000);
            const commands = this.createCommandResults(query, searchResults);
            const { intent, confidence } = this.detectIntent(query, searchResults.length > 0);
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
            if (event.key === "ArrowDown") { event.preventDefault(); if (results.length) { this.selectedIndex = mod(this.selectedIndex + 1, results.length); this.updateDropdown(); } }
            else if (event.key === "ArrowUp") { event.preventDefault(); if (results.length) { this.selectedIndex = mod(this.selectedIndex - 1, results.length); this.updateDropdown(); } }
            else if (event.key === "Enter" && results.length && this.selectedIndex >= 0) { event.preventDefault(); this.selectResult(results[this.selectedIndex]); }
            else if (event.key === "Backspace") { if (this.settingsMode.filter === '') { event.preventDefault(); this.exitSettingsMode(); this.setResults([]); this.resetInputToCurrentFile(); } }
            else if (event.key === "Escape") { event.preventDefault(); this.exitSettingsMode(); this.setResults([]); this.resetInputToCurrentFile(); this.input.blur(); }
            return;
        }
        // Browse mode
        if (this.browseMode.active) {
            const results = this.results;
            if (event.key === "ArrowDown") { event.preventDefault(); if (results.length) { this.selectedIndex = mod(this.selectedIndex + 1, results.length); this.updateDropdown(); } }
            else if (event.key === "ArrowUp") { event.preventDefault(); if (results.length) { this.selectedIndex = mod(this.selectedIndex - 1, results.length); this.updateDropdown(); } }
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
            if (this.visibleItems.length) { this.selectedIndex = mod(this.selectedIndex + 1, this.visibleItems.length); this.updateDropdown(); }
            else { this.host.focusEditor(); }
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (this.visibleItems.length) { this.selectedIndex = mod(this.selectedIndex - 1, this.visibleItems.length); this.updateDropdown(); }
        } else if (event.key === "Enter" && this.visibleItems.length && this.selectedIndex >= 0) {
            event.preventDefault();
            const item = this.visibleItems[this.selectedIndex];
            if (item === SHOW_MORE_SENTINEL) this.expandResults();
            else this.selectResult(item);
        } else if (event.key === "Delete" && this.visibleItems.length && this.selectedIndex >= 0) {
            const item = this.visibleItems[this.selectedIndex];
            if (item !== SHOW_MORE_SENTINEL && !isCommandResult(item) && !isBrowseEntry(item) && !isSettingsEntry(item)) {
                event.preventDefault(); this.enterDeleteMode(item.id);
            }
        } else if (event.key === "Escape") {
            event.preventDefault(); this.setResults([]); this.resetInputToCurrentFile(); this.input.blur();
        }
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
