import { EditorView, Panel } from "@codemirror/view";
import { StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { HighlightedSearch } from "../utils/search";
import { CodeblockFacet, openFileEffect, fileLoadedEffect, currentFileField, setThemeEffect, lineWrappingCompartment } from "../editor";
import { extOrLanguageToLanguageId } from "../lsps";
import { LSP, LspLog, FileChangeType } from "../utils/lsp";
import { Seti } from "@m234/nerd-fonts/fs";
import { settingsField, resolveThemeDark, updateSettingsEffect, EditorSettings } from "./footer";

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
    type: 'create-file' | 'rename-file' | 'import-local-files' | 'import-local-folder' | 'open-file' | 'settings';
    icon: string;
    iconColor?: string;
    query: string;
    requiresInput?: boolean;
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
    type: 'create-file' | 'rename-file';
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

// Icons
const SEARCH_ICON = '\uf002'; // nf-fa-search (magnifying glass)
const DEFAULT_FILE_ICON = '\ue64e'; // nf-seti-text
const COG_ICON = '\uf013'; // nf-fa-cog
const FOLDER_ICON = '\ue613'; // nf-seti-folder
const FOLDER_OPEN_ICON = '\ue614'; // nf-seti-folder (open variant)
const PARENT_DIR_ICON = '\uf112'; // nf-fa-reply (back/up arrow)

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
    const isLanguageQuery = isValidProgrammingLanguage(query);
    // TODO: fix language ext for new file with full language names, "typescript" -> "file.ts"

    // Check if query matches an existing file (first search result with exact match)
    const hasExactFileMatch = searchResults.length > 0 && searchResults[0].id === query;

    if (query.trim()) {
        // Create new file command (only if query doesn't match existing file)
        if (!hasExactFileMatch) {
            const langIcon = isLanguageQuery ? getLanguageIcon(query) : null;
            const createFileCommand: CommandResult = {
                id: isLanguageQuery ? "Create new file" : `Create new file "${query}"`,
                type: 'create-file',
                icon: langIcon ? langIcon.glyph : DEFAULT_FILE_ICON,
                iconColor: langIcon?.color,
                query,
                requiresInput: isLanguageQuery
            };
            commands.push(createFileCommand);
        }

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

const MIN_LOADING_MS = 400;

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

    dom.appendChild(lspLogBtn);

    const resultsList = document.createElement("ul");
    resultsList.className = "cm-search-results";
    dom.appendChild(resultsList);

    let selectedIndex = 0;
    let namingMode: NamingMode = { active: false, type: 'create-file', originalQuery: '' };
    let browseMode: BrowseMode = { active: false, currentPath: '/', filter: '' };
    let settingsMode: SettingsMode = { active: false, filter: '', editing: null };
    let deleteMode: DeleteMode = { active: false, filePath: '' };
    let loadingStartTime: number | null = null;

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

    // Apply initial theme
    const initialSettings = view.state.field(settingsField);
    const initialDark = resolveThemeDark(initialSettings.theme);
    view.dom.setAttribute('data-theme', initialDark ? 'dark' : 'light');

    // Tracks gutter width for toolbar alignment
    function updateGutterWidthVariables() {
        const gutters = view.dom.querySelector('.cm-gutters');
        if (gutters) {
            const gutterWidth = gutters.getBoundingClientRect().width;
            view.dom.style.setProperty('--cm-gutter-width', `${gutterWidth}px`);

            const numberGutter = gutters.querySelector('.cm-lineNumbers');

            if (numberGutter) {
                const numberGutterWidth = numberGutter.getBoundingClientRect().width;
                view.dom.style.setProperty('--cm-gutter-lineno-width', `${numberGutterWidth}px`);
            }
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

        // LSP log: toggle
        entries.push({
            id: `LSP log: ${settings.lspLogEnabled ? 'on' : 'off'}`,
            settingKey: 'lspLogEnabled',
            type: 'settings-toggle',
            icon: settings.lspLogEnabled ? '\u2713' : '\u2717',
            currentValue: String(settings.lspLogEnabled),
        });

        // Max visible lines: input
        entries.push({
            id: `Max lines: ${settings.maxVisibleLines || 'unlimited'}`,
            settingKey: 'maxVisibleLines',
            type: 'settings-input',
            icon: '\u2195', // ↕
            currentValue: String(settings.maxVisibleLines || ''),
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
            stateIcon.textContent = namingMode.type === 'create-file' ? DEFAULT_FILE_ICON : '\uf044';
        } else if (settingsMode.active) {
            stateIcon.textContent = COG_ICON;
        } else {
            stateIcon.textContent = SEARCH_ICON;
        }
    }

    function enterNamingMode(type: 'create-file' | 'rename-file', originalQuery: string, languageExtension?: string) {
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
            console.error('Failed to read directory:', e);
            exitBrowseMode();
        }
    }

    async function navigateBrowse(entry: BrowseEntry) {
        if (entry.type === 'browse-file') {
            // Open the file and exit browse mode
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
        } else if (command.type === 'create-file') {
            if (command.requiresInput) {
                // Enter naming mode for language-specific file
                enterNamingMode('create-file', command.query, command.query);
            } else {
                // Create file directly and populate toolbar
                const pathToOpen = command.query.includes('.') ? command.query : `${command.query}.txt`;
                input.value = pathToOpen;
                safeDispatch(view, {
                    effects: [setSearchResults.of([]), openFileEffect.of({ path: pathToOpen })]
                });
            }
        } else if (command.type === 'rename-file') {
            // Rename file directly since the new name is provided by the query
            const currentFile = view.state.field(currentFileField);
            if (currentFile.path) {
                const newPath = command.query.includes('.') ? command.query : `${command.query}.txt`;
                input.value = newPath;
                // TODO: Implement actual file rename logic
                console.log(`Rename ${currentFile.path} to ${newPath}`);
                safeDispatch(view, {
                    effects: [setSearchResults.of([]), openFileEffect.of({ path: newPath })]
                });
            }
        } else if (command.type === 'import-local-files') {
            triggerFileImport(false);
        } else if (command.type === 'import-local-folder') {
            triggerFileImport(true);
        }
    }

    function handleSearchResult(result: HighlightedSearch) {
        input.value = result.id;
        safeDispatch(view, {
            effects: [setSearchResults.of([]), openFileEffect.of({ path: result.id })]
        });
    }

    function executeNamingMode(filename: string) {
        if (!namingMode.active || !filename.trim()) return;

        if (namingMode.type === 'create-file') {
            const pathToOpen = namingMode.languageExtension && !filename.includes('.')
                ? `${filename}.${namingMode.languageExtension}`
                : filename;
            input.value = pathToOpen;
            // TODO: handle edge-cases like trying to create folders, invalid characters, etc.
            safeDispatch(view, {
                effects: [setSearchResults.of([]), openFileEffect.of({ path: pathToOpen })]
            });
        } else if (namingMode.type === 'rename-file') {
            const currentFile = view.state.field(currentFileField);
            if (currentFile.path) {
                const newPath = filename.includes('.') ? filename : `${filename}.txt`;
                input.value = newPath;
                // TODO: Implement actual file rename logic
                console.log(`Rename ${currentFile.path} to ${newPath}`);
                safeDispatch(view, {
                    effects: [setSearchResults.of([]), openFileEffect.of({ path: newPath })]
                });
            }
        }

        exitNamingMode();
    }

    function resetInputToCurrentFile() {
        const currentFile = view.state.field(currentFileField);
        input.value = currentFile.path || '';
    }

    // Close dropdown when clicking outside
    function handleClickOutside(event: Event) {
        if (!dom.contains(event.target as Node)) {
            if (settingsMode.active) exitSettingsMode();
            if (browseMode.active) exitBrowseMode();
            safeDispatch(view, { effects: setSearchResults.of([]) });
            resetInputToCurrentFile();
        }
    }

    input.addEventListener("click", () => {
        // Don't interfere when in a special mode
        if (namingMode.active || settingsMode.active || browseMode.active) {
            return;
        }

        // Open dropdown when input is clicked
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

        // Block input during delete confirmation
        if (deleteMode.active) {
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
            resetInputToCurrentFile();
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

            // Refresh settings dropdown when settings change and settings mode is active
            if (settingsMode.active && prevSettings !== nextSettings) {
                refreshSettingsEntries();
            }

            // Update loading indicator with minimum animation duration
            const prevFile = update.startState.field(currentFileField);
            const nextFile = update.state.field(currentFileField);
            if (prevFile.loading !== nextFile.loading) {
                if (nextFile.loading) {
                    loadingStartTime = Date.now();
                    stateIcon.textContent = ''; // clear glyph; CSS border spinner handles the visual
                    stateIcon.classList.add('cm-loading');
                } else {
                    const elapsed = loadingStartTime ? Date.now() - loadingStartTime : Infinity;
                    const remaining = Math.max(0, MIN_LOADING_MS - elapsed);
                    loadingStartTime = null;
                    setTimeout(() => {
                        if (!view.state.field(currentFileField).loading) {
                            stateIcon.textContent = SEARCH_ICON;
                            stateIcon.classList.remove('cm-loading');
                        }
                    }, remaining);
                }
            }

            // Update LSP log icon when file changes
            if (prevFile.path !== nextFile.path) {
                updateLspLogIcon();
            }

            // Sync input value when file path changes (unless overlay/mode is active or user is naming)
            if (prevFile.path !== nextFile.path && !namingMode.active && !lspLogOverlay && !settingsMode.active) {
                input.value = nextFile.path || '';
            }
        },
        destroy() {
            // Clean up event listeners when panel is destroyed
            document.removeEventListener("click", handleClickOutside);
            systemThemeQuery.removeEventListener('change', handleSystemThemeChange);

            // Clean up LSP log overlay
            closeLspLogOverlay();

            // Clean up ResizeObserver
            if (gutterObserver) {
                gutterObserver.disconnect();
                gutterObserver = null;
            }
        }
    };
};
