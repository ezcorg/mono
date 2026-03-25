import { EditorView, Panel } from "@codemirror/view";
import { StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { HighlightedSearch } from "../utils/search";
import { CodeblockFacet, openFileEffect, fileLoadedEffect, currentFileField, setThemeEffect, lineWrappingCompartment, lineNumbersCompartment, foldGutterCompartment } from "../editor";
import { lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { foldGutter } from "@codemirror/language";
import { extOrLanguageToLanguageId } from "../lsps";
import { LSP, LspLog, FileChangeType } from "../utils/lsp";
import { Seti } from "@m234/nerd-fonts/fs";
import { settingsField, resolveThemeDark, updateSettingsEffect, EditorSettings } from "./settings";

type NerdIcon = { value: string; hexCode: number; color?: string };

// Browser-safe file icon lookup (avoids node:path.parse used by Seti.fromPath)
const FALLBACK_ICON: NerdIcon = { value: '\ue64e', hexCode: 0xe64e }; // nf-seti-text

function setiIconForPath(filePath: string): NerdIcon {
    const base = filePath.split('/').pop() || filePath;

    // Check exact basename match first (e.g. Dockerfile, Makefile)
    const byBase = Seti.byBaseSeti.get(base);
    if (byBase) return byBase;

    // Walk extensions from longest to shortest (e.g. .spec.ts → .ts)
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

// Command result types for the first section
export interface CommandResult {
    id: string;
    type: 'create-file' | 'save-as' | 'rename-file' | 'import-local-files' | 'import-local-folder' | 'open-file' | 'settings' | 'open-terminal' | 'file-action';
    icon: string;
    iconColor?: string;
    query: string;
    requiresInput?: boolean;
    /** For type 'file-action': callback executed when the command is selected. */
    action?: (view: EditorView) => void;
}

// --- File-extension-specific command registry ---
// Commands registered here appear in the toolbar dropdown when a matching file is open.
export interface FileActionEntry {
    /** File extensions this command applies to (e.g. ['svg']) */
    extensions: string[];
    /** Display label */
    label: string;
    /** Nerd Font icon glyph */
    icon: string;
    /** Callback when selected */
    action: (view: EditorView) => void;
}

const fileActionRegistry: FileActionEntry[] = [];

/** Register a command that appears when files with matching extensions are open. */
export function registerFileAction(entry: FileActionEntry) {
    fileActionRegistry.push(entry);
}

// Settings entry for dropdown-based settings
export interface SettingsEntry {
    id: string;          // display label like "Theme: dark"
    settingKey: string;  // key in EditorSettings
    type: 'settings-toggle' | 'settings-cycle' | 'settings-input';
    icon: string;
    currentValue: string; // display value
}

// Browse entry for filesystem navigation
export interface BrowseEntry {
    id: string;         // display name
    type: 'browse-directory' | 'browse-file' | 'browse-parent';
    icon: string;
    iconColor?: string;
    fullPath: string;   // full path for navigation/opening
}

// Combined result type
export type SearchResult = HighlightedSearch | CommandResult | BrowseEntry | SettingsEntry;

// Type guards
function isCommandResult(result: SearchResult): result is CommandResult {
    return 'type' in result && (result as CommandResult).query !== undefined;
}

function isBrowseEntry(result: SearchResult): result is BrowseEntry {
    return 'type' in result && ('fullPath' in result);
}

function isSettingsEntry(result: SearchResult): result is SettingsEntry {
    return 'type' in result && ('settingKey' in result);
}

// Naming mode state
export interface NamingMode {
    active: boolean;
    type: 'create-file' | 'save-as' | 'rename-file';
    originalQuery: string;
    languageExtension?: string;
}

// Browse mode state for filesystem navigation
export interface BrowseMode {
    active: boolean;
    currentPath: string;
    filter: string;
}

// Settings mode state for dropdown-based settings
export interface SettingsMode {
    active: boolean;
    filter: string;
    editing: string | null; // settingKey currently being edited, or null
}

// Delete confirmation mode
export interface DeleteMode {
    active: boolean;
    filePath: string;
}

// Overwrite confirmation mode
export interface OverwriteMode {
    active: boolean;
    filePath: string;
    action: 'save-as' | 'create-file' | 'rename';
    /** For rename: the old path to delete after overwrite */
    oldPath?: string;
}

// Search results state - now handles both commands and search results
export const setSearchResults = StateEffect.define<SearchResult[]>();
export const searchResultsField = StateField.define<SearchResult[]>({
    create() {
        return [];
    },
    update(value, tr) {
        for (let e of tr.effects) if (e.is(setSearchResults)) return e.value;
        return value;
    }
});

const mod = (n: number, m: number) => ((n % m) + m) % m;

// A safe dispatcher to avoid nested-update errors from UI events during CM updates
function safeDispatch(view: EditorView, spec: TransactionSpec) {
    // Always queue to a microtask so we never dispatch within an ongoing update cycle
    queueMicrotask(() => {
        try { view.dispatch(spec); } catch (e) { console.error(e); }
    });
}

// Check if query matches a programming language
function isValidProgrammingLanguage(query: string): boolean {
    const lowerQuery = query.toLowerCase();
    return Object.keys(extOrLanguageToLanguageId).some(key =>
        key.toLowerCase() === lowerQuery ||
        extOrLanguageToLanguageId[key].toLowerCase() === lowerQuery
    );
}

// Map language names to canonical file extensions
function languageToFileExtension(langOrExt: string): string {
    const nameToExt: Record<string, string> = {
        javascript: 'js',
        typescript: 'ts',
        python: 'py',
        ruby: 'rb',
        csharp: 'cs',
        kotlin: 'kt',
        rust: 'rs',
        haskell: 'hs',
        perl: 'pl',
        bash: 'sh',
        shell: 'sh',
        mysql: 'sql',
        markdown: 'md',
    };
    return nameToExt[langOrExt.toLowerCase()] || langOrExt.toLowerCase();
}

// Icons
const SEARCH_ICON = '\uf002'; // nf-fa-search (magnifying glass)
const DEFAULT_FILE_ICON = '\ue64e'; // nf-seti-text
const COG_ICON = '\uf013'; // nf-fa-cog
const FOLDER_ICON = '\ue613'; // nf-seti-folder
const FOLDER_OPEN_ICON = '\ue614'; // nf-seti-folder (open variant)
const PARENT_DIR_ICON = '\uf112'; // nf-fa-reply (back/up arrow)
const TERMINAL_ICON = '\uf120'; // nf-fa-terminal

// Get nerd font icon for a file path
function getFileIcon(path: string): { glyph: string; color: string } {
    const result = setiIconForPath(path);
    return { glyph: result.value, color: result.color || '' };
}

// Get icon for a language/extension query (used for create-file commands)
function getLanguageIcon(query: string): { glyph: string; color: string } {
    return getFileIcon(`file.${query}`);
}


// Theme cycle values and icons
const themeCycleValues: EditorSettings['theme'][] = ['light', 'dark', 'system'];
const themeIcons: Record<EditorSettings['theme'], string> = {
    light: '\u2600\uFE0F',   // ☀️
    dark: '\uD83C\uDF19',    // 🌙
    system: '\uD83C\uDF13',  // 🌓
};

// Font family cycle values
const fontFamilyCycleValues = ['', '"UbuntuMono NF", monospace'];
const fontFamilyLabels: Record<string, string> = {
    '': 'System default',
    '"UbuntuMono NF", monospace': 'UbuntuMono NF',
};

// Create command results for the first section
function createCommandResults(query: string, view: EditorView, searchResults: SearchResult[]): CommandResult[] {
    const commands: CommandResult[] = [];
    const currentFile = view.state.field(currentFileField);
    const hasValidFile = currentFile.path && !currentFile.loading;
    const hasContent = view.state.doc.length > 0;
    const isLanguageQuery = isValidProgrammingLanguage(query);

    // Check if query matches an existing file (first search result with exact match)
    const hasExactFileMatch = searchResults.length > 0 && searchResults[0].id === query;

    // "Save as" — shown when the editor has content or a file is open
    if (hasContent || hasValidFile) {
        if (!query.trim()) {
            commands.push({
                id: 'Save as',
                type: 'save-as',
                icon: DEFAULT_FILE_ICON,
                query: '',
                requiresInput: true,
            });
        } else if (!hasExactFileMatch) {
            const langIcon = isLanguageQuery ? getLanguageIcon(query) : null;
            commands.push({
                id: isLanguageQuery ? "Save as" : `Save as "${query}"`,
                type: 'save-as',
                icon: langIcon ? langIcon.glyph : DEFAULT_FILE_ICON,
                iconColor: langIcon?.color,
                query,
                requiresInput: isLanguageQuery,
            });
        }
    }

    // "Create new file" — always available, creates a blank file
    if (!query.trim()) {
        commands.push({
            id: 'Create new file',
            type: 'create-file',
            icon: DEFAULT_FILE_ICON,
            query: '',
            requiresInput: true,
        });
    } else if (!hasExactFileMatch) {
        const langIcon = isLanguageQuery ? getLanguageIcon(query) : null;
        commands.push({
            id: isLanguageQuery ? "Create new file" : `Create new file "${query}"`,
            type: 'create-file',
            icon: langIcon ? langIcon.glyph : DEFAULT_FILE_ICON,
            iconColor: langIcon?.color,
            query,
            requiresInput: isLanguageQuery,
        });
    }

    if (query.trim()) {
        // Rename file command (only if file is open, query is not a language, and doesn't match current file)
        if (hasValidFile && !isLanguageQuery && !hasExactFileMatch) {
            const renameCommand: CommandResult = {
                id: `Rename to "${query}"`,
                type: 'rename-file',
                icon: '\uf044', // nf-fa-pencil_square_o (edit icon)
                query
            };
            commands.push(renameCommand);
        }
    }

    // Open file (filesystem browser) — always shown
    commands.push({
        id: 'Open file',
        type: 'open-file',
        icon: FOLDER_OPEN_ICON,
        query: '',
    });

    // Open terminal — shown when a jswasi backend is configured
    if (view.state.facet(CodeblockFacet).jswasi) {
        commands.push({
            id: 'Open terminal',
            type: 'open-terminal',
            icon: TERMINAL_ICON,
            query: '',
        });
    }

    // Import commands — always shown
    commands.push({
        id: 'Import file(s)',
        type: 'import-local-files',
        icon: '\uf15b', // nf-fa-file
        query: '',
    });
    commands.push({
        id: 'Import folder',
        type: 'import-local-folder',
        icon: FOLDER_ICON,
        query: '',
    });

    // File-extension-specific commands — shown when a matching file is open
    if (hasValidFile && currentFile.path) {
        const ext = currentFile.path.split('.').pop()?.toLowerCase() || '';
        for (const entry of fileActionRegistry) {
            if (entry.extensions.includes(ext)) {
                commands.push({
                    id: entry.label,
                    type: 'file-action',
                    icon: entry.icon,
                    query: '',
                    action: entry.action,
                });
            }
        }
    }

    // Settings command — always shown
    commands.push({
        id: 'Settings',
        type: 'settings',
        icon: COG_ICON,
        query: '',
    });

    return commands;
}

const BINARY_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);

function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function importFiles(files: FileList, view: EditorView) {
    const { fs, index } = view.state.facet(CodeblockFacet);
    for (const file of files) {
        const path = file.webkitRelativePath || file.name;
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir) await fs.mkdir(dir, { recursive: true });

        // Store binary images as data URLs so they can be rendered
        const ext = path.split('.').pop()?.toLowerCase() || '';
        if (BINARY_IMAGE_EXTS.has(ext)) {
            const dataUrl = await fileToDataUrl(file);
            await fs.writeFile(path, dataUrl);
        } else {
            await fs.writeFile(path, await file.text());
        }

        if (index) index.add(path);
        LSP.notifyFileChanged(path, FileChangeType.Created);
    }
    if (index?.savePath) await index.save(fs, index.savePath);
    // Open first imported file
    if (files.length > 0) {
        const first = files[0].webkitRelativePath || files[0].name;
        safeDispatch(view, { effects: openFileEffect.of({ path: first }) });
    }
}

// Create an LSP log overlay element
function createLspLogOverlay(): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "cm-settings-overlay";

    // Log content
    const content = document.createElement("div");
    content.className = "cm-lsp-log-content";
    overlay.appendChild(content);

    function render() {
        const entries = LspLog.entries();
        const fragment = document.createDocumentFragment();
        for (const entry of entries) {
            const div = document.createElement("div");
            div.className = `cm-lsp-log-entry cm-lsp-log-${entry.level}`;
            const time = new Date(entry.timestamp).toLocaleTimeString();
            div.textContent = `[${time}] [${entry.level}] ${entry.message}`;
            fragment.appendChild(div);
        }
        content.replaceChildren(fragment);
        content.scrollTop = content.scrollHeight;
    }

    render();
    const unsub = LspLog.subscribe(render);
    (overlay as any)._lspLogUnsub = unsub;

    return overlay;
}

const SPINNER_FADE_MS = 150;

// Toolbar Panel
export const toolbarPanel = (view: EditorView): Panel => {
    let { filepath, language, index } = view.state.facet(CodeblockFacet);

    const dom = document.createElement("div");
    dom.className = "cm-toolbar-panel";

    // Create state icon (left side) — magnifying glass at rest
    const stateIcon = document.createElement("div");
    stateIcon.className = "cm-toolbar-state-icon";
    stateIcon.textContent = SEARCH_ICON;

    // Create container for state icon to help with alignment
    const stateIconContainer = document.createElement("div");
    stateIconContainer.className = "cm-toolbar-state-icon-container";
    stateIconContainer.appendChild(stateIcon);
    dom.appendChild(stateIconContainer);

    // Create input container for the right-aligned input
    const inputContainer = document.createElement("div");
    inputContainer.className = "cm-toolbar-input-container";
    dom.appendChild(inputContainer);

    const input = document.createElement("input");
    input.type = "text";
    input.value = filepath || language || "";
    input.className = "cm-toolbar-input";
    inputContainer.appendChild(input);

    // LSP log button (shows file-type icon of current file, hidden when lspLogEnabled is false)
    const lspLogBtn = document.createElement("button");
    lspLogBtn.className = "cm-toolbar-lsp-log";
    lspLogBtn.style.fontFamily = 'var(--cm-icon-font-family)';
    function updateLspLogIcon() {
        const filePath = view.state.field(currentFileField).path;
        if (filePath) {
            const icon = getFileIcon(filePath);
            lspLogBtn.textContent = icon.glyph;
            lspLogBtn.style.color = icon.color || '';
        } else {
            lspLogBtn.textContent = DEFAULT_FILE_ICON;
            lspLogBtn.style.color = '';
        }
    }
    function updateLspLogVisibility() {
        const enabled = view.state.field(settingsField).lspLogEnabled;
        lspLogBtn.style.display = enabled ? '' : 'none';
    }
    updateLspLogIcon();
    updateLspLogVisibility();

    // LSP log overlay management (dedicated to LSP log only)
    let lspLogOverlay: HTMLElement | null = null;
    let lspLogSavedInputValue: string | null = null;

    function showLspLogOverlay(overlay: HTMLElement) {
        const panelsTop = view.dom.querySelector('.cm-panels-top');
        if (panelsTop) {
            overlay.style.top = `${panelsTop.getBoundingClientRect().height}px`;
        }
        view.dom.appendChild(overlay);
    }

    function openLspLogOverlay() {
        lspLogSavedInputValue = input.value;
        input.value = 'lsp.log';
        lspLogOverlay = createLspLogOverlay();
        showLspLogOverlay(lspLogOverlay);
    }

    function closeLspLogOverlay() {
        if (lspLogOverlay) {
            if ((lspLogOverlay as any)._lspLogUnsub) {
                (lspLogOverlay as any)._lspLogUnsub();
            }
            lspLogOverlay.remove();
            lspLogOverlay = null;

            if (lspLogSavedInputValue !== null) {
                input.value = lspLogSavedInputValue;
                lspLogSavedInputValue = null;
            }
        }
    }

    lspLogBtn.addEventListener("click", () => {
        if (lspLogOverlay) {
            closeLspLogOverlay();
        } else {
            openLspLogOverlay();
        }
    });

    // LSP log button is hidden — the feature is non-functional and visually noisy.
    // Keeping the code for potential future use but not appending to DOM.
    // dom.appendChild(lspLogBtn);

    const resultsList = document.createElement("ul");
    resultsList.className = "cm-search-results";
    dom.appendChild(resultsList);

    let selectedIndex = 0;
    let namingMode: NamingMode = { active: false, type: 'create-file', originalQuery: '' };
    let browseMode: BrowseMode = { active: false, currentPath: '/', filter: '' };
    let settingsMode: SettingsMode = { active: false, filter: '', editing: null };
    let deleteMode: DeleteMode = { active: false, filePath: '' };
    let overwriteMode: OverwriteMode = { active: false, filePath: '', action: 'create-file' };
    let terminalMode = { active: false };
    let terminalResizeObserver: ResizeObserver | null = null;

    // Terminal wrapper — replaces the toolbar input with the ghostty terminal.
    // Positioned as a dropdown below the toolbar, growing as output arrives.
    const terminalWrapper = document.createElement("div");
    terminalWrapper.className = "cm-terminal-wrapper";
    terminalWrapper.style.display = 'none';
    dom.appendChild(terminalWrapper);

    // Close terminal on Ctrl+C or Escape (capture phase so we get it before ghostty)
    terminalWrapper.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            exitTerminalMode();
        } else if (e.ctrlKey && e.key === 'c') {
            // Let ghostty also handle SIGINT, then close
            requestAnimationFrame(() => exitTerminalMode());
        }
    }, { capture: true });

    function handleTerminalClickOutside(event: Event) {
        if (!terminalMode.active) return;
        if (!dom.contains(event.target as Node)) {
            exitTerminalMode();
        }
    }

    /** Sync the wrapper height to the terminal CM editor's actual content height. */
    function syncTerminalWrapperHeight() {
        const cmEditor = terminalWrapper.querySelector('.cm-editor') as HTMLElement | null;
        if (!cmEditor) return;
        const contentPx = cmEditor.scrollHeight;
        const minPx = dom.offsetHeight; // at least cover the toolbar filler
        const maxPx = window.innerHeight * 0.5;
        terminalWrapper.style.height = `${Math.min(Math.max(contentPx, minPx), maxPx)}px`;
    }

    async function enterTerminalMode() {
        terminalMode.active = true;
        view.dom.style.setProperty('--cm-gutter-width', '0px');
        view.dom.style.setProperty('--cm-gutter-lineno-width', '0px');

        // Swap toolbar content: hide input elements (visibility preserves layout height),
        // show terminal wrapper
        stateIconContainer.style.visibility = 'hidden';
        inputContainer.style.visibility = 'hidden';
        terminalWrapper.style.display = '';
        safeDispatch(view, { effects: setSearchResults.of([]) });
        document.addEventListener("click", handleTerminalClickOutside);

        // Lazy-load terminal
        const termMod = await import('./terminal');

        const terminalEl = await termMod.ensureTerminalElement(view);
        if (!terminalWrapper.contains(terminalEl)) {
            terminalWrapper.appendChild(terminalEl);
        }

        // Sync wrapper height after each terminal render (content may grow/shrink)
        termMod.setHeightCallback(() => {
            if (terminalMode.active) syncTerminalWrapperHeight();
        });

        // Resize observer for terminal column width
        terminalResizeObserver = new ResizeObserver(() => {
            termMod.handleTerminalResize(view.state.field(settingsField).fontSize);
        });
        terminalResizeObserver.observe(terminalWrapper);

        // Focus terminal + initial height sync
        requestAnimationFrame(() => {
            termMod.focusTerminalEl();
            syncTerminalWrapperHeight();
        });
    }

    function exitTerminalMode() {
        if (!terminalMode.active) return;
        terminalMode.active = false;
        updateGutterWidthVariables();

        // Restore toolbar: show input elements, hide terminal
        stateIconContainer.style.visibility = '';
        inputContainer.style.visibility = '';
        terminalWrapper.style.display = 'none';
        stateIcon.textContent = SEARCH_ICON;
        resetInputToCurrentFile();

        import('./terminal').then(({ setHeightCallback }) => {
            setHeightCallback(null);
        });

        terminalResizeObserver?.disconnect();
        terminalResizeObserver = null;
        document.removeEventListener("click", handleTerminalClickOutside);
    }

    // System theme media query listener
    const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    function handleSystemThemeChange() {
        const settings = view.state.field(settingsField);
        if (settings.theme === 'system') {
            safeDispatch(view, {
                effects: setThemeEffect.of({ dark: systemThemeQuery.matches })
            });
        }
    }
    systemThemeQuery.addEventListener('change', handleSystemThemeChange);

    // Apply initial settings (font size, font family, theme)
    function applySettings() {
        const settings = view.state.field(settingsField);
        view.dom.style.setProperty('--cm-font-size', `${settings.fontSize}px`);
        if (settings.fontFamily) {
            view.dom.style.setProperty('--cm-font-family', settings.fontFamily);
        } else {
            view.dom.style.removeProperty('--cm-font-family');
        }
        // Max visible lines: set max-height on the scroller
        const scroller = view.dom.querySelector('.cm-scroller') as HTMLElement;
        if (scroller) {
            if (settings.maxVisibleLines > 0) {
                const lineHeight = settings.fontSize * 1.5; // approximate
                scroller.style.maxHeight = `${settings.maxVisibleLines * lineHeight}px`;
            } else {
                scroller.style.maxHeight = '';
            }
        }
    }
    applySettings();

    // Apply initial theme and auto-hide
    const initialSettings = view.state.field(settingsField);
    const initialDark = resolveThemeDark(initialSettings.theme);
    view.dom.setAttribute('data-theme', initialDark ? 'dark' : 'light');
    // Auto-hide is enabled after the panel is mounted (needs parent ref).
    // Defer to first update cycle.
    let autoHidePendingInit = initialSettings.autoHideToolbar;

    // Tracks gutter width for toolbar alignment.
    // Sets CSS variables used by icon containers and alignment:
    //   --cm-gutter-width: total width of all gutters combined
    //   --cm-gutter-lineno-width: width of the line numbers gutter
    //   --cm-icon-col-width: character-width-based minimum for icon column
    function updateGutterWidthVariables() {
        // Character width for ch-based sizing (2 columns: icon occupies ~0.5ch advance,
        // but we want the container to be a clean multiple of character width)
        const chWidth = view.defaultCharacterWidth;
        const iconColWidth = Math.ceil(2 * chWidth); // 2 character columns minimum
        view.dom.style.setProperty('--cm-icon-col-width', `${iconColWidth}px`);

        const gutters = view.dom.querySelector('.cm-gutters');
        if (gutters) {
            const gutterWidth = gutters.getBoundingClientRect().width;
            view.dom.style.setProperty('--cm-gutter-width', `${gutterWidth}px`);

            const numberGutter = gutters.querySelector('.cm-lineNumbers');
            if (numberGutter) {
                const numberGutterWidth = numberGutter.getBoundingClientRect().width;
                view.dom.style.setProperty('--cm-gutter-lineno-width', `${numberGutterWidth}px`);
            } else {
                // Line numbers hidden — icon column sized to character-width multiple
                view.dom.style.setProperty('--cm-gutter-lineno-width', `${iconColWidth}px`);
            }
        } else {
            // No gutters at all — icon column sized to character-width multiple
            view.dom.style.setProperty('--cm-gutter-width', `${iconColWidth}px`);
            view.dom.style.setProperty('--cm-gutter-lineno-width', `${iconColWidth}px`);
        }
    }

    // Set up ResizeObserver to watch gutter width changes
    let gutterObserver: ResizeObserver | null = null;
    function setupGutterObserver() {
        const gutters = view.dom.querySelector('.cm-gutters');
        if (gutters && window.ResizeObserver) {
            gutterObserver = new ResizeObserver(() => {
                updateGutterWidthVariables();
            });
            gutterObserver.observe(gutters);
        }
    }

    // Initial width setup and observer
    updateGutterWidthVariables();
    setupGutterObserver();

    // --- Auto-hide toolbar management ---
    // When enabled, the toolbar retracts (height → 0). It expands when:
    //   - the mouse enters the first visible code line (top of scroller), OR
    //   - the toolbar input receives focus.
    // It retracts when:
    //   - the mouse leaves the toolbar AND the input doesn't have focus.
    let autoHideEnabled = false;
    let panelsTopEl: HTMLElement | null = null;

    function getPanelsTop(): HTMLElement | null {
        if (!panelsTopEl) panelsTopEl = dom.parentElement as HTMLElement | null;
        return panelsTopEl;
    }

    function retractToolbar() {
        const pt = getPanelsTop();
        if (pt && autoHideEnabled) pt.classList.add('cm-toolbar-retracted');
    }

    function expandToolbar() {
        const pt = getPanelsTop();
        if (pt) pt.classList.remove('cm-toolbar-retracted');
    }

    function isToolbarInteractive() {
        return dom.contains(document.activeElement);
    }

    // Single mousemove handler on the editor root checks whether the mouse
    // is inside the toolbar region (panels-top + any overflow like dropdowns)
    // or inside the first code line (trigger zone). This is more reliable than
    // mouseleave on cm-panels-top, which misses absolutely-positioned children.
    function handleEditorMouseMove(e: MouseEvent) {
        if (!autoHideEnabled) return;
        const pt = getPanelsTop();
        if (!pt) return;

        // Check if mouse is inside the toolbar panel or its dropdown
        // (dropdown overflows below cm-panels-top, so check dom directly)
        if (dom.contains(e.target as Node) || pt.contains(e.target as Node)) {
            return; // still in toolbar region — stay expanded
        }

        // Check if mouse is within the first code line (trigger to expand)
        const scroller = view.dom.querySelector('.cm-scroller');
        if (scroller) {
            const scrollRect = scroller.getBoundingClientRect();
            if (e.clientY >= scrollRect.top && e.clientY < scrollRect.top + view.defaultLineHeight) {
                expandToolbar();
                return;
            }
        }

        // Mouse is elsewhere in the editor — retract if not interactive
        if (!isToolbarInteractive()) retractToolbar();
    }

    function handleEditorMouseLeave() {
        if (!autoHideEnabled) return;
        if (!isToolbarInteractive()) retractToolbar();
    }

    function handleInputBlur() {
        if (!autoHideEnabled) return;
        // Delay slightly so click-to-focus-another-element events settle
        setTimeout(() => {
            if (autoHideEnabled && !isToolbarInteractive()) {
                retractToolbar();
            }
        }, 100);
    }

    function enableAutoHide() {
        autoHideEnabled = true;
        view.dom.addEventListener('mousemove', handleEditorMouseMove);
        view.dom.addEventListener('mouseleave', handleEditorMouseLeave);
        input.addEventListener('blur', handleInputBlur);
        retractToolbar();
    }

    function disableAutoHide() {
        autoHideEnabled = false;
        view.dom.removeEventListener('mousemove', handleEditorMouseMove);
        view.dom.removeEventListener('mouseleave', handleEditorMouseLeave);
        input.removeEventListener('blur', handleInputBlur);
        expandToolbar();
    }

    // --- Settings mode functions ---
    function buildSettingsEntries(filter: string): SettingsEntry[] {
        const settings = view.state.field(settingsField);
        const entries: SettingsEntry[] = [];

        // Theme: cycle through light/dark/system
        entries.push({
            id: `Theme: ${settings.theme}`,
            settingKey: 'theme',
            type: 'settings-cycle',
            icon: themeIcons[settings.theme],
            currentValue: settings.theme,
        });

        // Font size: input
        entries.push({
            id: `Font size: ${settings.fontSize}px`,
            settingKey: 'fontSize',
            type: 'settings-input',
            icon: 'Aa',
            currentValue: String(settings.fontSize),
        });

        // Font family: cycle
        const fontLabel = fontFamilyLabels[settings.fontFamily] || settings.fontFamily || 'System default';
        entries.push({
            id: `Font family: ${fontLabel}`,
            settingKey: 'fontFamily',
            type: 'settings-cycle',
            icon: 'Aa',
            currentValue: settings.fontFamily,
        });

        // Autosave: toggle
        entries.push({
            id: `Autosave: ${settings.autosave ? 'on' : 'off'}`,
            settingKey: 'autosave',
            type: 'settings-toggle',
            icon: settings.autosave ? '\u2713' : '\u2717', // ✓ or ✗
            currentValue: String(settings.autosave),
        });

        // Line wrap: toggle
        entries.push({
            id: `Line wrap: ${settings.lineWrap ? 'on' : 'off'}`,
            settingKey: 'lineWrap',
            type: 'settings-toggle',
            icon: settings.lineWrap ? '\u2713' : '\u2717',
            currentValue: String(settings.lineWrap),
        });

        // Max visible lines: input
        entries.push({
            id: `Max lines: ${settings.maxVisibleLines || 'unlimited'}`,
            settingKey: 'maxVisibleLines',
            type: 'settings-input',
            icon: '\u2195', // ↕
            currentValue: String(settings.maxVisibleLines || ''),
        });

        // Line numbers: toggle
        entries.push({
            id: `Line numbers: ${settings.showLineNumbers ? 'on' : 'off'}`,
            settingKey: 'showLineNumbers',
            type: 'settings-toggle',
            icon: settings.showLineNumbers ? '\u2713' : '\u2717',
            currentValue: String(settings.showLineNumbers),
        });

        // Fold gutter: toggle
        entries.push({
            id: `Fold gutter: ${settings.showFoldGutter ? 'on' : 'off'}`,
            settingKey: 'showFoldGutter',
            type: 'settings-toggle',
            icon: settings.showFoldGutter ? '\u2713' : '\u2717',
            currentValue: String(settings.showFoldGutter),
        });

        // Auto-hide toolbar: toggle
        entries.push({
            id: `Auto-hide toolbar: ${settings.autoHideToolbar ? 'on' : 'off'}`,
            settingKey: 'autoHideToolbar',
            type: 'settings-toggle',
            icon: settings.autoHideToolbar ? '\u2713' : '\u2717',
            currentValue: String(settings.autoHideToolbar),
        });

        // Filter entries
        if (filter) {
            const lowerFilter = filter.toLowerCase();
            return entries.filter(e => e.id.toLowerCase().includes(lowerFilter));
        }
        return entries;
    }

    function refreshSettingsEntries() {
        if (!settingsMode.active) return;
        const entries = buildSettingsEntries(settingsMode.filter);
        selectedIndex = Math.min(selectedIndex, Math.max(0, entries.length - 1));
        safeDispatch(view, { effects: setSearchResults.of(entries) });
    }

    function enterSettingsMode() {
        settingsMode = { active: true, filter: '', editing: null };
        stateIcon.textContent = COG_ICON;
        input.value = 'settings/';
        input.placeholder = '';
        input.focus();
        selectedIndex = 0;
        const entries = buildSettingsEntries('');
        safeDispatch(view, { effects: setSearchResults.of(entries) });
        // Ensure click-outside listener is active
        document.addEventListener("click", handleClickOutside);
    }

    function exitSettingsMode() {
        settingsMode = { active: false, filter: '', editing: null };
        updateStateIcon();
        input.placeholder = '';
    }

    function handleSettingsEntry(entry: SettingsEntry) {
        const settings = view.state.field(settingsField);

        if (entry.type === 'settings-toggle') {
            const key = entry.settingKey as keyof EditorSettings;
            const newValue = !settings[key];
            const effects: StateEffect<any>[] = [updateSettingsEffect.of({ [key]: newValue })];

            // Special handling for lineWrap: reconfigure compartment
            if (key === 'lineWrap') {
                effects.push(lineWrappingCompartment.reconfigure(newValue ? EditorView.lineWrapping : []));
            }
            // Special handling for showLineNumbers: reconfigure compartment
            if (key === 'showLineNumbers') {
                effects.push(lineNumbersCompartment.reconfigure(newValue ? [lineNumbers(), highlightActiveLineGutter()] : []));
            }
            // Special handling for showFoldGutter: reconfigure compartment
            if (key === 'showFoldGutter') {
                effects.push(foldGutterCompartment.reconfigure(newValue ? [foldGutter()] : []));
            }
            // Special handling for autoHideToolbar: JS-managed retract/expand
            if (key === 'autoHideToolbar') {
                if (newValue) enableAutoHide(); else disableAutoHide();
            }

            safeDispatch(view, { effects });
        } else if (entry.type === 'settings-cycle') {
            if (entry.settingKey === 'theme') {
                const currentIdx = themeCycleValues.indexOf(settings.theme);
                const nextTheme = themeCycleValues[(currentIdx + 1) % themeCycleValues.length];
                safeDispatch(view, {
                    effects: [
                        updateSettingsEffect.of({ theme: nextTheme }),
                        setThemeEffect.of({ dark: resolveThemeDark(nextTheme) }),
                    ]
                });
            } else if (entry.settingKey === 'fontFamily') {
                const currentIdx = fontFamilyCycleValues.indexOf(settings.fontFamily);
                const nextIdx = (currentIdx + 1) % fontFamilyCycleValues.length;
                safeDispatch(view, {
                    effects: [updateSettingsEffect.of({ fontFamily: fontFamilyCycleValues[nextIdx] })]
                });
            }
        } else if (entry.type === 'settings-input') {
            // Enter editing mode: show the current value in the input for inline editing
            settingsMode.editing = entry.settingKey;
            input.value = entry.currentValue;
            input.select();
        }
    }

    function confirmSettingsEdit() {
        if (!settingsMode.editing) return;
        const key = settingsMode.editing;
        const rawValue = input.value.trim();

        if (key === 'fontSize') {
            const size = Number(rawValue);
            if (!isNaN(size) && size >= 1 && size <= 128) {
                safeDispatch(view, { effects: [updateSettingsEffect.of({ fontSize: size })] });
            }
        } else if (key === 'maxVisibleLines') {
            const lines = rawValue === '' ? 0 : Number(rawValue);
            if (!isNaN(lines) && lines >= 0) {
                safeDispatch(view, { effects: [updateSettingsEffect.of({ maxVisibleLines: Math.floor(lines) })] });
            }
        }

        settingsMode.editing = null;
        input.value = 'settings/' + settingsMode.filter;
        // Refresh entries after a microtask so the state update has landed
        queueMicrotask(() => refreshSettingsEntries());
    }

    function cancelSettingsEdit() {
        settingsMode.editing = null;
        input.value = 'settings/' + settingsMode.filter;
    }

    // --- Delete mode functions ---
    function enterDeleteMode(filePath: string) {
        deleteMode = { active: true, filePath };
        stateIcon.textContent = '\u2717'; // ✗
        input.value = '';
        input.placeholder = `Delete "${filePath}"? (Enter to confirm, Esc to cancel)`;
        input.focus();
        safeDispatch(view, { effects: setSearchResults.of([]) });
    }

    function exitDeleteMode() {
        deleteMode = { active: false, filePath: '' };
        updateStateIcon();
        input.placeholder = '';
    }

    async function confirmDelete() {
        if (!deleteMode.active) return;
        const path = deleteMode.filePath;
        const { fs, index } = view.state.facet(CodeblockFacet);

        try {
            const currentFile = view.state.field(currentFileField);
            const wasOpen = currentFile.path === path;

            // Delete from VFS
            await fs.unlink(path).catch((e) => console.warn('VFS unlink failed:', e));

            // Remove from search index
            if (index) {
                try { index.index.discard(path); } catch { /* not in index */ }
                if (index.savePath) index.save(fs, index.savePath);
            }

            // Notify LSP
            LSP.notifyFileChanged(path, FileChangeType.Deleted);

            exitDeleteMode();
            safeDispatch(view, { effects: setSearchResults.of([]) });
            resetInputToCurrentFile();

            // If the deleted file was currently open, clear the editor
            if (wasOpen) {
                safeDispatch(view, {
                    changes: { from: 0, to: view.state.doc.length, insert: '' },
                    effects: [
                        fileLoadedEffect.of({ path: '', content: '', language: null }),
                    ]
                });
                input.value = '';
            }
        } catch (e) {
            console.error('Failed to delete file:', e);
            exitDeleteMode();
        }
    }

    // --- Overwrite confirmation mode ---
    function enterOverwriteMode(filePath: string, action: OverwriteMode['action'], oldPath?: string) {
        overwriteMode = { active: true, filePath, action, oldPath };
        stateIcon.textContent = '\u26A0'; // ⚠
        input.value = '';
        input.placeholder = `"${filePath}" exists. Overwrite? (Enter/Esc)`;
        input.focus();
        safeDispatch(view, { effects: setSearchResults.of([]) });
    }

    function exitOverwriteMode() {
        overwriteMode = { active: false, filePath: '', action: 'create-file' };
        updateStateIcon();
        input.placeholder = '';
    }

    async function confirmOverwrite() {
        if (!overwriteMode.active) return;
        const { filePath, action, oldPath } = overwriteMode;
        exitOverwriteMode();

        if (action === 'save-as') {
            input.value = filePath;
            await createAndOpenFile(filePath);
        } else if (action === 'create-file') {
            input.value = filePath;
            await createBlankFile(filePath);
        } else if (action === 'rename' && oldPath) {
            input.value = filePath;
            await performRename(oldPath, filePath);
        }
    }

    /** Check if file exists before executing; enters overwrite mode if it does. */
    async function checkOverwriteAndExecute(
        path: string,
        action: OverwriteMode['action'],
        execute: () => void | Promise<void>,
        oldPath?: string,
    ) {
        const { fs } = view.state.facet(CodeblockFacet);
        const exists = await fs.exists(path);
        if (exists) {
            enterOverwriteMode(path, action, oldPath);
        } else {
            await execute();
        }
    }

    /** Create a blank (empty) file in the VFS and open it. */
    async function createBlankFile(pathToOpen: string) {
        const { fs, index } = view.state.facet(CodeblockFacet);
        const dir = pathToOpen.substring(0, pathToOpen.lastIndexOf('/'));
        if (dir) await fs.mkdir(dir, { recursive: true }).catch(() => {});
        await fs.writeFile(pathToOpen, '').catch(console.error);

        if (index) {
            index.add(pathToOpen);
            if (index.savePath) index.save(fs, index.savePath);
        }

        safeDispatch(view, {
            effects: [setSearchResults.of([]), openFileEffect.of({ path: pathToOpen })]
        });
    }

    /** Rename a file: save current content to newPath, delete oldPath. */
    async function performRename(oldPath: string, newPath: string) {
        const { fs, index } = view.state.facet(CodeblockFacet);
        const content = view.state.doc.toString();

        // Write content to new path
        const dir = newPath.substring(0, newPath.lastIndexOf('/'));
        if (dir) await fs.mkdir(dir, { recursive: true }).catch(() => {});
        await fs.writeFile(newPath, content).catch(console.error);

        // Delete old path
        await fs.unlink(oldPath).catch((e) => console.warn('VFS unlink failed during rename:', e));

        // Update search index
        if (index) {
            try { index.index.discard(oldPath); } catch { /* not in index */ }
            index.add(newPath);
            if (index.savePath) index.save(fs, index.savePath);
        }

        // Notify LSP
        LSP.notifyFileChanged(oldPath, FileChangeType.Deleted);
        LSP.notifyFileChanged(newPath, FileChangeType.Created);

        // Open the new file — skipSave prevents handleOpen's save-on-switch
        // from re-creating the old file we just deleted
        safeDispatch(view, {
            effects: [setSearchResults.of([]), openFileEffect.of({ path: newPath, skipSave: true })]
        });
    }

    const renderItem = (result: SearchResult, i: number) => {
        const li = document.createElement("li");

        let resultClass = 'cm-file-result';
        if (isSettingsEntry(result)) resultClass = 'cm-command-result';
        else if (isCommandResult(result)) resultClass = 'cm-command-result';
        else if (isBrowseEntry(result)) resultClass = result.type === 'browse-file' ? 'cm-file-result' : 'cm-browse-dir-result';
        li.className = `cm-search-result ${resultClass}`;

        const resultIconContainer = document.createElement("div");
        resultIconContainer.className = "cm-search-result-icon-container";

        const resultIcon = document.createElement("div");
        resultIcon.className = "cm-search-result-icon";

        if (isSettingsEntry(result)) {
            // Settings entries use emoji or text icons, not nerd fonts
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

        resultIconContainer.appendChild(resultIcon);
        li.appendChild(resultIconContainer);

        const resultLabel = document.createElement("div");
        resultLabel.className = "cm-search-result-label";
        resultLabel.textContent = result.id;

        li.appendChild(resultLabel);

        if (i === selectedIndex) li.classList.add("selected");

        li.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
        });

        li.addEventListener("click", (ev) => {
            ev.stopPropagation();
            selectResult(result);
        });
        return li;
    };

    function updateDropdown() {
        const results = view.state.field(searchResultsField);
        const children: HTMLElement[] = [];

        // Render items in state array order (search results first, commands second)
        results.forEach((result, i) => {
            children.push(renderItem(result, i));
        });

        resultsList.replaceChildren(...children);

        // Scroll the selected item into view
        const selected = resultsList.querySelector('.selected') as HTMLElement;
        if (selected) {
            selected.scrollIntoView({ block: 'nearest' });
        }
    }

    function selectResult(result: SearchResult) {
        if (isSettingsEntry(result)) {
            handleSettingsEntry(result);
        } else if (isBrowseEntry(result)) {
            navigateBrowse(result);
        } else if (isCommandResult(result)) {
            handleCommandResult(result);
        } else {
            handleSearchResult(result);
        }
    }

    function updateStateIcon() {
        if (namingMode.active) {
            stateIcon.textContent = (namingMode.type === 'create-file' || namingMode.type === 'save-as') ? DEFAULT_FILE_ICON : '\uf044';
        } else if (settingsMode.active) {
            stateIcon.textContent = COG_ICON;
        } else {
            stateIcon.textContent = SEARCH_ICON;
        }
    }

    function enterNamingMode(type: NamingMode['type'], originalQuery: string, languageExtension?: string) {
        namingMode = { active: true, type, originalQuery, languageExtension };

        // Update state icon
        updateStateIcon();

        // Clear input and focus
        input.value = '';
        input.placeholder = languageExtension ? `filename.${languageExtension}` : 'filename';
        input.focus();

        // Clear search results
        safeDispatch(view, { effects: setSearchResults.of([]) });
    }

    function exitNamingMode() {
        namingMode = { active: false, type: 'create-file', originalQuery: '' };
        updateStateIcon();
        input.placeholder = '';
    }

    // --- Browse mode functions ---
    async function enterBrowseMode(startPath?: string) {
        const { cwd } = view.state.facet(CodeblockFacet);
        const browsePath = startPath || cwd || '/';
        browseMode = { active: true, currentPath: browsePath, filter: '' };

        // Update state icon to folder
        stateIcon.textContent = FOLDER_OPEN_ICON;

        input.value = browsePath.endsWith('/') ? browsePath : browsePath + '/';
        input.placeholder = '';
        input.focus();

        await refreshBrowseEntries();
        // Ensure click-outside listener is active
        document.addEventListener("click", handleClickOutside);
    }

    async function refreshBrowseEntries() {
        if (!browseMode.active) return;

        const { fs } = view.state.facet(CodeblockFacet);
        const dir = browseMode.currentPath;

        try {
            const entries = await fs.readDir(dir);
            const browseResults: BrowseEntry[] = [];

            // Add parent directory entry if not at root
            if (dir !== '/' && dir !== '') {
                const parentPath = dir.split('/').slice(0, -1).join('/') || '/';
                browseResults.push({
                    id: '..',
                    type: 'browse-parent',
                    icon: PARENT_DIR_ICON,
                    fullPath: parentPath,
                });
            }

            // Separate directories and files, sort each alphabetically
            const dirs: BrowseEntry[] = [];
            const files: BrowseEntry[] = [];

            for (const [name, fileType] of entries) {
                // Skip hidden/internal files
                if (name.startsWith('.')) continue;

                const fullPath = dir === '/' ? `${name}` : `${dir}/${name}`;

                // FileType.Directory = 2
                if (fileType === 2) {
                    dirs.push({
                        id: name + '/',
                        type: 'browse-directory',
                        icon: FOLDER_ICON,
                        fullPath,
                    });
                } else {
                    const icon = getFileIcon(name);
                    files.push({
                        id: name,
                        type: 'browse-file',
                        icon: icon.glyph,
                        iconColor: icon.color,
                        fullPath,
                    });
                }
            }

            dirs.sort((a, b) => a.id.localeCompare(b.id));
            files.sort((a, b) => a.id.localeCompare(b.id));

            // Apply filter
            const filter = browseMode.filter.toLowerCase();
            const filtered = [...browseResults, ...dirs, ...files].filter(entry =>
                entry.type === 'browse-parent' || entry.id.toLowerCase().includes(filter)
            );

            selectedIndex = 0;
            safeDispatch(view, { effects: setSearchResults.of(filtered) });
        } catch (e) {
            console.warn('Failed to read directory:', e);
            // Show an empty listing instead of crashing — the filesystem
            // may not be mounted or OPFS state may be stale.
            selectedIndex = 0;
            safeDispatch(view, { effects: setSearchResults.of([]) });
        }
    }

    async function navigateBrowse(entry: BrowseEntry) {
        if (entry.type === 'browse-file') {
            // Open the file and exit browse mode
            exitTerminalMode();
            const path = entry.fullPath;
            exitBrowseMode();
            input.value = path;
            safeDispatch(view, {
                effects: [setSearchResults.of([]), openFileEffect.of({ path })]
            });
        } else {
            // Navigate into directory (or parent)
            browseMode.currentPath = entry.fullPath;
            browseMode.filter = '';
            const displayPath = entry.fullPath === '/' ? '/' : entry.fullPath + '/';
            input.value = displayPath;
            selectedIndex = 0;
            await refreshBrowseEntries();
        }
    }

    function exitBrowseMode() {
        browseMode = { active: false, currentPath: '/', filter: '' };
        updateStateIcon();
        input.placeholder = '';
    }

    function triggerFileImport(folder: boolean) {
        safeDispatch(view, { effects: setSearchResults.of([]) });
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        if (folder) {
            fileInput.setAttribute('webkitdirectory', '');
        } else {
            fileInput.multiple = true;
        }
        fileInput.addEventListener('change', () => {
            if (fileInput.files?.length) {
                importFiles(fileInput.files, view);
            }
        });
        fileInput.click();
    }

    function handleCommandResult(command: CommandResult) {
        if (command.type === 'settings') {
            enterSettingsMode();
            return;
        } else if (command.type === 'open-file') {
            enterBrowseMode();
            return;
        } else if (command.type === 'open-terminal') {
            enterTerminalMode();
            return;
        } else if (command.type === 'save-as') {
            if (command.requiresInput) {
                const ext = command.query ? languageToFileExtension(command.query) : undefined;
                enterNamingMode('save-as', command.query, ext);
            } else {
                const pathToOpen = command.query.includes('.') ? command.query : `${command.query}.txt`;
                input.value = pathToOpen;
                checkOverwriteAndExecute(pathToOpen, 'save-as', () => createAndOpenFile(pathToOpen));
            }
        } else if (command.type === 'create-file') {
            if (command.requiresInput) {
                const ext = command.query ? languageToFileExtension(command.query) : undefined;
                enterNamingMode('create-file', command.query, ext);
            } else {
                const pathToOpen = command.query.includes('.') ? command.query : `${command.query}.txt`;
                input.value = pathToOpen;
                checkOverwriteAndExecute(pathToOpen, 'create-file', () => createBlankFile(pathToOpen));
            }
        } else if (command.type === 'rename-file') {
            const currentFile = view.state.field(currentFileField);
            if (currentFile.path) {
                const newPath = command.query.includes('.') ? command.query : `${command.query}.txt`;
                input.value = newPath;
                checkOverwriteAndExecute(newPath, 'rename', () => performRename(currentFile.path!, newPath), currentFile.path);
            }
        } else if (command.type === 'import-local-files') {
            triggerFileImport(false);
        } else if (command.type === 'import-local-folder') {
            triggerFileImport(true);
        } else if (command.type === 'file-action' && command.action) {
            safeDispatch(view, { effects: setSearchResults.of([]) });
            command.action(view);
        }
    }

    function handleSearchResult(result: HighlightedSearch) {
        exitTerminalMode();
        input.value = result.id;
        safeDispatch(view, {
            effects: [setSearchResults.of([]), openFileEffect.of({ path: result.id })]
        });
    }

    /** Save the current editor content to a new file path in the VFS, then open it. */
    async function createAndOpenFile(pathToOpen: string) {
        const { fs } = view.state.facet(CodeblockFacet);
        const content = view.state.doc.toString();
        const dir = pathToOpen.substring(0, pathToOpen.lastIndexOf('/'));
        if (dir) await fs.mkdir(dir, { recursive: true }).catch(() => {});
        await fs.writeFile(pathToOpen, content).catch(console.error);

        // Add to search index
        const { index } = view.state.facet(CodeblockFacet);
        if (index) {
            index.add(pathToOpen);
            if (index.savePath) index.save(fs, index.savePath);
        }

        safeDispatch(view, {
            effects: [setSearchResults.of([]), openFileEffect.of({ path: pathToOpen })]
        });
    }

    function executeNamingMode(filename: string) {
        if (!namingMode.active || !filename.trim()) return;

        const resolvePath = (fn: string) => namingMode.languageExtension && !fn.includes('.')
            ? `${fn}.${namingMode.languageExtension}`
            : fn;

        if (namingMode.type === 'save-as') {
            const pathToOpen = resolvePath(filename);
            input.value = pathToOpen;
            exitNamingMode();
            checkOverwriteAndExecute(pathToOpen, 'save-as', () => createAndOpenFile(pathToOpen));
            return;
        } else if (namingMode.type === 'create-file') {
            const pathToOpen = resolvePath(filename);
            input.value = pathToOpen;
            exitNamingMode();
            checkOverwriteAndExecute(pathToOpen, 'create-file', () => createBlankFile(pathToOpen));
            return;
        } else if (namingMode.type === 'rename-file') {
            const currentFile = view.state.field(currentFileField);
            if (currentFile.path) {
                const newPath = filename.includes('.') ? filename : `${filename}.txt`;
                input.value = newPath;
                exitNamingMode();
                checkOverwriteAndExecute(newPath, 'rename', () => performRename(currentFile.path!, newPath), currentFile.path);
                return;
            }
        }

        exitNamingMode();
    }

    function resetInputToCurrentFile() {
        const currentFile = view.state.field(currentFileField);
        const cfg = view.state.facet(CodeblockFacet);
        input.value = currentFile.path || cfg.language || '';
    }

    function resetInputToTerminalOrFile() {
        if (terminalMode.active) {
            input.value = '/ $';
        } else {
            resetInputToCurrentFile();
        }
    }

    // Close dropdown when clicking outside
    function handleClickOutside(event: Event) {
        if (!dom.contains(event.target as Node)) {
            if (settingsMode.active) exitSettingsMode();
            if (browseMode.active) exitBrowseMode();
            safeDispatch(view, { effects: setSearchResults.of([]) });
            resetInputToTerminalOrFile();
        }
    }

    input.addEventListener("click", () => {
        // Don't interfere when in a special mode
        if (namingMode.active || settingsMode.active || browseMode.active || terminalMode.active) {
            return;
        }

        const query = input.value;
        let results: SearchResult[] = [];

        if (query.trim()) {
            // Get regular search results from index first
            const searchResults: SearchResult[] = (index?.search(query) || []).slice(0, 100);

            // Add command results (passing search results to check for existing files)
            const commands = createCommandResults(query, view, searchResults);

            // Search results first, then commands
            results = searchResults.concat(commands);
        } else {
            // Show import commands when dropdown opens with empty query
            results = createCommandResults('', view, []);
        }

        safeDispatch(view, { effects: setSearchResults.of(results) });

        // Add click-outside listener when dropdown opens
        document.addEventListener("click", handleClickOutside);
    });

    input.addEventListener("input", (event) => {
        const query = (event.target as HTMLInputElement).value;
        selectedIndex = 0;

        // Block input during delete/overwrite confirmation
        if (deleteMode.active || overwriteMode.active) {
            input.value = '';
            return;
        }

        // If in naming mode, don't show search results
        if (namingMode.active) {
            return;
        }

        // If editing a settings value, don't interfere
        if (settingsMode.active && settingsMode.editing) {
            return;
        }

        // If in settings mode, filter the settings entries
        if (settingsMode.active) {
            const prefix = 'settings/';
            settingsMode.filter = query.startsWith(prefix) ? query.slice(prefix.length) : query;
            refreshSettingsEntries();
            return;
        }

        // If in browse mode, filter the directory entries
        if (browseMode.active) {
            // Extract filter text after the directory path prefix
            const prefix = browseMode.currentPath === '/' ? '/' : browseMode.currentPath + '/';
            browseMode.filter = query.startsWith(prefix) ? query.slice(prefix.length) : query;
            refreshBrowseEntries();
            return;
        }

        let results: SearchResult[] = [];

        if (query.trim()) {
            // Get regular search results from index first
            const searchResults = (index?.search(query) || []).slice(0, 1000);

            // Add command results (passing search results to check for existing files)
            const commands = createCommandResults(query, view, searchResults);

            // Search results first, then commands
            results.push(...searchResults);
            results.push(...commands);
        } else {
            // Show import commands even with empty query
            results = createCommandResults('', view, []);
        }

        safeDispatch(view, { effects: setSearchResults.of(results) });
    });

    input.addEventListener("keydown", (event) => {
        // Overwrite confirmation mode
        if (overwriteMode.active) {
            if (event.key === "Enter") {
                event.preventDefault();
                confirmOverwrite();
            } else if (event.key === "Escape") {
                event.preventDefault();
                exitOverwriteMode();
                resetInputToCurrentFile();
            }
            event.preventDefault();
            return;
        }

        // Delete confirmation mode
        if (deleteMode.active) {
            if (event.key === "Enter") {
                event.preventDefault();
                confirmDelete();
            } else if (event.key === "Escape") {
                event.preventDefault();
                exitDeleteMode();
                resetInputToCurrentFile();
            }
            // Block all other keys in delete mode
            event.preventDefault();
            return;
        }

        if (namingMode.active) {
            // Handle naming mode
            if (event.key === "Enter") {
                event.preventDefault();
                executeNamingMode(input.value);
            } else if (event.key === "Escape") {
                event.preventDefault();
                exitNamingMode();
                input.value = namingMode.originalQuery;
            }
            return;
        }

        // Settings mode keyboard handling
        if (settingsMode.active) {
            const results = view.state.field(searchResultsField);

            // If currently editing a settings value
            if (settingsMode.editing) {
                if (event.key === "Enter") {
                    event.preventDefault();
                    confirmSettingsEdit();
                } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelSettingsEdit();
                }
                return;
            }

            if (event.key === "ArrowDown") {
                event.preventDefault();
                if (results.length) {
                    selectedIndex = mod(selectedIndex + 1, results.length);
                    updateDropdown();
                }
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (results.length) {
                    selectedIndex = mod(selectedIndex - 1, results.length);
                    updateDropdown();
                }
            } else if (event.key === "Enter" && results.length && selectedIndex >= 0) {
                event.preventDefault();
                selectResult(results[selectedIndex]);
            } else if (event.key === "Backspace") {
                // If filter is empty and not editing, exit settings mode
                if (settingsMode.filter === '') {
                    event.preventDefault();
                    exitSettingsMode();
                    safeDispatch(view, { effects: setSearchResults.of([]) });
                    resetInputToCurrentFile();
                }
            } else if (event.key === "Escape") {
                event.preventDefault();
                exitSettingsMode();
                safeDispatch(view, { effects: setSearchResults.of([]) });
                resetInputToCurrentFile();
                input.blur();
            }
            return;
        }

        // Browse mode keyboard handling
        if (browseMode.active) {
            const results = view.state.field(searchResultsField);
            if (event.key === "ArrowDown") {
                event.preventDefault();
                if (results.length) {
                    selectedIndex = mod(selectedIndex + 1, results.length);
                    updateDropdown();
                }
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (results.length) {
                    selectedIndex = mod(selectedIndex - 1, results.length);
                    updateDropdown();
                }
            } else if (event.key === "Enter" && results.length && selectedIndex >= 0) {
                event.preventDefault();
                selectResult(results[selectedIndex]);
            } else if (event.key === "Backspace") {
                // If filter is empty and backspace pressed, go up a directory
                if (browseMode.filter === '' && browseMode.currentPath !== '/') {
                    event.preventDefault();
                    const parentPath = browseMode.currentPath.split('/').slice(0, -1).join('/') || '/';
                    browseMode.currentPath = parentPath;
                    const displayPath = parentPath === '/' ? '/' : parentPath + '/';
                    input.value = displayPath;
                    refreshBrowseEntries();
                }
            } else if (event.key === "Delete" && results.length && selectedIndex >= 0) {
                // Delete a file from the browse dropdown
                const result = results[selectedIndex];
                if (isBrowseEntry(result) && result.type === 'browse-file') {
                    event.preventDefault();
                    exitBrowseMode();
                    enterDeleteMode(result.fullPath);
                }
            } else if (event.key === "Escape") {
                event.preventDefault();
                exitBrowseMode();
                safeDispatch(view, { effects: setSearchResults.of([]) });
                resetInputToCurrentFile();
                input.blur();
            }
            return;
        }

        // Normal search mode
        const results = view.state.field(searchResultsField);
        if (event.key === "ArrowDown") {
            event.preventDefault();
            if (results.length) {
                selectedIndex = mod(selectedIndex + 1, results.length);
                updateDropdown();
            } else {
                // No dropdown open — move cursor to editor body
                view.focus();
            }
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (results.length) {
                selectedIndex = mod(selectedIndex - 1, results.length);
                updateDropdown();
            }
        } else if (event.key === "Enter" && results.length && selectedIndex >= 0) {
            event.preventDefault();
            selectResult(results[selectedIndex]);
        } else if (event.key === "Delete" && results.length && selectedIndex >= 0) {
            // Delete key on a highlighted file result → enter delete confirmation
            const result = results[selectedIndex];
            if (!isCommandResult(result) && !isBrowseEntry(result) && !isSettingsEntry(result)) {
                event.preventDefault();
                enterDeleteMode(result.id);
            }
        } else if (event.key === "Escape") {
            event.preventDefault();
            safeDispatch(view, { effects: setSearchResults.of([]) });
            resetInputToTerminalOrFile();
            input.blur();
        }
    });

    return {
        dom,
        top: true,
        update(update) {
            // Re-render dropdown when search results change
            const a = update.startState.field(searchResultsField);
            const b = update.state.field(searchResultsField);
            if (a !== b) {
                updateDropdown();

                // Remove click-outside listener when dropdown closes
                if (b.length === 0) {
                    document.removeEventListener("click", handleClickOutside);
                }
            }

            // Apply settings when they change
            const prevSettings = update.startState.field(settingsField);
            const nextSettings = update.state.field(settingsField);
            if (prevSettings.fontSize !== nextSettings.fontSize || prevSettings.fontFamily !== nextSettings.fontFamily || prevSettings.maxVisibleLines !== nextSettings.maxVisibleLines) {
                applySettings();
            }
            if (prevSettings.lspLogEnabled !== nextSettings.lspLogEnabled) {
                updateLspLogVisibility();
                // Close the log overlay if the user disables it
                if (!nextSettings.lspLogEnabled && lspLogOverlay) {
                    closeLspLogOverlay();
                }
            }

            // Sync autoHideToolbar via JS event handlers
            if (prevSettings.autoHideToolbar !== nextSettings.autoHideToolbar) {
                if (nextSettings.autoHideToolbar) enableAutoHide(); else disableAutoHide();
            }

            // Deferred auto-hide init (needs parent element to be mounted)
            if (autoHidePendingInit && getPanelsTop()) {
                autoHidePendingInit = false;
                enableAutoHide();
            }
            // Refresh gutter width variables when gutter-related settings change
            if (prevSettings.showLineNumbers !== nextSettings.showLineNumbers || prevSettings.showFoldGutter !== nextSettings.showFoldGutter) {
                queueMicrotask(() => updateGutterWidthVariables());
            }

            // Refresh settings dropdown when settings change and settings mode is active
            if (settingsMode.active && prevSettings !== nextSettings) {
                refreshSettingsEntries();
            }

            // Loading spinner — separate element so the container keeps
            // tracking gutter width while the spinner has fixed dimensions.
            const prevFile = update.startState.field(currentFileField);
            const nextFile = update.state.field(currentFileField);
            if (prevFile.loading !== nextFile.loading) {
                if (nextFile.loading) {
                    // Immediately swap icon → spinner (no delay to avoid race conditions)
                    stateIcon.style.display = 'none';
                    stateIcon.style.opacity = '0';
                    if (!stateIconContainer.querySelector('.cm-loading')) {
                        const spinner = document.createElement('div');
                        spinner.className = 'cm-loading';
                        stateIconContainer.appendChild(spinner);
                    }
                } else {
                    // Fade spinner out, then crossfade icon in
                    const spinner = stateIconContainer.querySelector('.cm-loading') as HTMLElement | null;
                    if (spinner) {
                        spinner.style.opacity = '0';
                        setTimeout(() => {
                            spinner.remove();
                            if (!view.state.field(currentFileField).loading) {
                                stateIcon.style.display = '';
                                // Force reflow so the browser sees opacity:0 before transitioning to 1
                                stateIcon.offsetHeight;
                                stateIcon.style.opacity = '1';
                            }
                        }, SPINNER_FADE_MS);
                    } else {
                        stateIcon.style.display = '';
                        stateIcon.style.opacity = '1';
                    }
                }
            }

            // Update LSP log icon when file changes
            if (prevFile.path !== nextFile.path) {
                updateLspLogIcon();
            }

            // Sync input value when file path changes (unless overlay/mode is active, naming, or terminal is open)
            if (prevFile.path !== nextFile.path && !namingMode.active && !lspLogOverlay && !settingsMode.active && !terminalMode.active) {
                input.value = nextFile.path || '';
            }
        },
        destroy() {
            // Clean up event listeners when panel is destroyed
            document.removeEventListener("click", handleClickOutside);
            systemThemeQuery.removeEventListener('change', handleSystemThemeChange);

            // Clean up auto-hide
            if (autoHideEnabled) disableAutoHide();

            // Clean up LSP log overlay
            closeLspLogOverlay();

            // Clean up terminal overlay
            exitTerminalMode();

            // Clean up ResizeObserver
            if (gutterObserver) {
                gutterObserver.disconnect();
                gutterObserver = null;
            }
        }
    };
};
