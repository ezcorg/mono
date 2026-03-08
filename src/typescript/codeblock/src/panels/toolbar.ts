import { EditorView, Panel } from "@codemirror/view";
import { StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { HighlightedSearch } from "../utils/search";
import { CodeblockFacet, openFileEffect, currentFileField, setThemeEffect } from "../editor";
import { extOrLanguageToLanguageId } from "../lsps";
import { LSP, LspLog, FileChangeType } from "../utils/lsp";
import { Seti } from "@m234/nerd-fonts/fs";
import { settingsField, resolveThemeDark, createSettingsOverlay } from "./footer";

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
    type: 'create-file' | 'rename-file' | 'import-local-files' | 'import-local-folder';
    icon: string;
    iconColor?: string;
    query: string;
    requiresInput?: boolean;
}

// Combined result type
export type SearchResult = HighlightedSearch | CommandResult;

// Type guards
function isCommandResult(result: SearchResult): result is CommandResult {
    return 'type' in result;
}

// Naming mode state
export interface NamingMode {
    active: boolean;
    type: 'create-file' | 'rename-file';
    originalQuery: string;
    languageExtension?: string;
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

// Get nerd font icon for a file path
function getFileIcon(path: string): { glyph: string; color: string } {
    const result = setiIconForPath(path);
    return { glyph: result.value, color: result.color || '' };
}

// Get icon for a language/extension query (used for create-file commands)
function getLanguageIcon(query: string): { glyph: string; color: string } {
    return getFileIcon(`file.${query}`);
}


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

    // Import commands — always shown
    commands.push({
        id: 'Import file(s)',
        type: 'import-local-files',
        icon: '\uf15b', // nf-fa-file
        query: '',
    });
    commands.push({
        id: 'Import folder(s)',
        type: 'import-local-folder',
        icon: '\ue613', // nf-seti-folder
        query: '',
    });

    return commands;
}

async function importFiles(files: FileList, view: EditorView) {
    const { fs, index } = view.state.facet(CodeblockFacet);
    for (const file of files) {
        const path = file.webkitRelativePath || file.name;
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir) await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path, await file.text());
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

    // Settings cog button (far right of toolbar)
    const settingsCog = document.createElement("button");
    settingsCog.className = "cm-toolbar-settings-cog";
    settingsCog.style.fontFamily = 'var(--cm-icon-font-family)';
    settingsCog.textContent = COG_ICON;

    // Overlay management
    let activeOverlay: HTMLElement | null = null;
    let activeOverlayType: 'settings' | 'lsp-log' | null = null;
    let savedInputValue: string | null = null;

    const overlayLabels: Record<string, string> = {
        'settings': 'settings',
        'lsp-log': 'lsp.log',
    };

    function updateCogAppearance() {
        if (activeOverlayType) {
            settingsCog.textContent = '\u2715'; // ✕
            settingsCog.style.fontFamily = '';
            settingsCog.classList.add('cm-cog-active');
        } else {
            settingsCog.textContent = COG_ICON;
            settingsCog.style.fontFamily = 'var(--cm-icon-font-family)';
            settingsCog.classList.remove('cm-cog-active');
        }
    }

    function showOverlay(overlay: HTMLElement) {
        const panelsTop = view.dom.querySelector('.cm-panels-top');
        if (panelsTop) {
            overlay.style.top = `${panelsTop.getBoundingClientRect().height}px`;
        }
        view.dom.appendChild(overlay);
    }

    function openOverlay(type: 'settings' | 'lsp-log', overlay: HTMLElement) {
        // Save current input and show overlay label
        savedInputValue = input.value;
        input.value = overlayLabels[type];

        activeOverlay = overlay;
        activeOverlayType = type;
        showOverlay(overlay);
        updateCogAppearance();
    }

    function closeOverlay() {
        if (activeOverlay) {
            // Clean up LSP log subscription if applicable
            if ((activeOverlay as any)._lspLogUnsub) {
                (activeOverlay as any)._lspLogUnsub();
            }
            activeOverlay.remove();
            activeOverlay = null;
            activeOverlayType = null;

            // Restore input text
            if (savedInputValue !== null) {
                input.value = savedInputValue;
                savedInputValue = null;
            }
            updateCogAppearance();
        }
    }

    settingsCog.addEventListener("click", () => {
        if (activeOverlayType) {
            closeOverlay();
        } else {
            openOverlay('settings', createSettingsOverlay(view));
        }
    });

    lspLogBtn.addEventListener("click", () => {
        if (activeOverlayType === 'lsp-log') {
            closeOverlay();
        } else {
            closeOverlay();
            openOverlay('lsp-log', createLspLogOverlay());
        }
    });

    dom.appendChild(lspLogBtn);
    dom.appendChild(settingsCog);

    const resultsList = document.createElement("ul");
    resultsList.className = "cm-search-results";
    dom.appendChild(resultsList);

    let selectedIndex = 0;
    let namingMode: NamingMode = { active: false, type: 'create-file', originalQuery: '' };
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

    const renderItem = (result: SearchResult, i: number) => {
        const li = document.createElement("li");
        li.className = `cm-search-result ${isCommandResult(result) ? 'cm-command-result' : 'cm-file-result'}`;

        const resultIconContainer = document.createElement("div");
        resultIconContainer.className = "cm-search-result-icon-container";

        const resultIcon = document.createElement("div");
        resultIcon.className = "cm-search-result-icon";
        resultIcon.style.fontFamily = 'var(--cm-icon-font-family)';
        if (isCommandResult(result)) {
            resultIcon.textContent = result.icon;
            if (result.iconColor) resultIcon.style.color = result.iconColor;
        } else {
            const icon = getFileIcon(result.id);
            resultIcon.textContent = icon.glyph;
            if (icon.color) resultIcon.style.color = icon.color;
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

        li.addEventListener("click", () => selectResult(result));
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
    }

    function selectResult(result: SearchResult) {
        if (isCommandResult(result)) {
            handleCommandResult(result);
        } else {
            handleSearchResult(result);
        }
    }

    function updateStateIcon() {
        if (namingMode.active) {
            stateIcon.textContent = namingMode.type === 'create-file' ? DEFAULT_FILE_ICON : '\uf044';
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
        if (command.type === 'create-file') {
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
            safeDispatch(view, { effects: setSearchResults.of([]) });
            resetInputToCurrentFile();
        }
    }

    input.addEventListener("click", () => {
        // Open dropdown when input is clicked
        if (!namingMode.active) {
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
        }
    });

    input.addEventListener("input", (event) => {
        const query = (event.target as HTMLInputElement).value;
        selectedIndex = 0;

        // If in naming mode, don't show search results
        if (namingMode.active) {
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
            if (prevSettings.fontSize !== nextSettings.fontSize || prevSettings.fontFamily !== nextSettings.fontFamily) {
                applySettings();
            }
            if (prevSettings.lspLogEnabled !== nextSettings.lspLogEnabled) {
                updateLspLogVisibility();
                // Close the log overlay if the user disables it
                if (!nextSettings.lspLogEnabled && activeOverlayType === 'lsp-log') {
                    closeOverlay();
                }
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

            // Sync input value when file path changes (unless overlay is open or user is naming)
            if (prevFile.path !== nextFile.path && !namingMode.active && !activeOverlayType) {
                input.value = nextFile.path || '';
            }
        },
        destroy() {
            // Clean up event listeners when panel is destroyed
            document.removeEventListener("click", handleClickOutside);
            systemThemeQuery.removeEventListener('change', handleSystemThemeChange);

            // Clean up overlay
            closeOverlay();

            // Clean up ResizeObserver
            if (gutterObserver) {
                gutterObserver.disconnect();
                gutterObserver = null;
            }
        }
    };
};
