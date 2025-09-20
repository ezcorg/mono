import { EditorView, Panel } from "@codemirror/view";
import { StateEffect, StateField, TransactionSpec } from "@codemirror/state";
import { HighlightedSearch } from "../utils/search";
import { CodeblockFacet, openFileEffect, currentFileField } from "../editor";
import { extOrLanguageToLanguageId } from "../lsps";

// Command result types for the first section
export interface CommandResult {
    id: string;
    type: 'create-file' | 'rename-file';
    icon: string;
    query: string;
    requiresInput?: boolean;
}

// Combined result type
export type SearchResult = HighlightedSearch | CommandResult;

// Type guards
function isCommandResult(result: SearchResult): result is CommandResult {
    return 'type' in result;
}

function isSearchResult(result: SearchResult): result is HighlightedSearch {
    return 'score' in result;
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
// Get appropriate icon for language/extension
function getLanguageIcon(query: string): string {
    const lowerQuery = query.toLowerCase();

    // Language/extension icons matching extOrLanguageToLanguageId
    const iconMap: Record<string, string> = {
        // JavaScript/TypeScript family
        'javascript': '🟨',
        'js': '🟨',
        'typescript': '🔷',
        'ts': '🔷',
        'jsx': '⚛️',
        'tsx': '⚛️',

        // Python
        'python': '🐍',
        'py': '🐍',

        // Ruby
        'ruby': '💎',
        'rb': '💎',

        // PHP
        'php': '🐘',

        // Java
        'java': '☕',

        // C/C++
        'cpp': '⚙️',
        'c': '⚙️',

        // C#
        'csharp': '🔷',
        'cs': '🔷',

        // Go
        'go': '🐹',

        // Swift
        'swift': '🦉',

        // Kotlin
        'kotlin': '🟣',
        'kt': '🟣',

        // Rust
        'rust': '🦀',
        'rs': '🦀',

        // Scala
        'scala': '🔴',

        // Visual Basic
        'vb': '🔵',

        // Haskell
        'haskell': '🎭',
        'hs': '🎭',

        // Lua
        'lua': '🌙',

        // Perl
        'perl': '🐪',
        'pl': '🐪',

        // Shell/Bash
        'bash': '🐚',
        'shell': '🐚',
        'sh': '🐚',
        'zsh': '🐚',

        // SQL
        'mysql': '🗃️',
        'sql': '🗃️',

        // Web technologies
        'html': '🌐',
        'css': '🎨',
        'scss': '🎨',
        'less': '🎨',

        // Data formats
        'json': '📋',
        'yaml': '⚙️',
        'yml': '⚙️',
        'xml': '📄',
        'toml': '⚙️',
        'ini': '⚙️',
        'conf': '⚙️',
        'log': '📄',
        'env': '🔧',

        // Documentation
        'markdown': '📝',
        'md': '📝',

        // Docker/Build
        'dockerfile': '🐳',
        'makefile': '🔨',
        'dockerignore': '🐳',
        'gitignore': '📝'
    };

    return iconMap[lowerQuery] || '📄';
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
            const createFileCommand: CommandResult = {
                id: isLanguageQuery ? "Create new file" : `Create new file "${query}"`,
                type: 'create-file',
                icon: isLanguageQuery ? getLanguageIcon(query) : '📄',
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
                icon: '✏️',
                query
            };
            commands.push(renameCommand);
        }
    }

    return commands;
}

// Toolbar Panel
export const toolbarPanel = (view: EditorView): Panel => {
    let { filepath, language, index } = view.state.facet(CodeblockFacet);

    const dom = document.createElement("div");
    dom.className = "cm-toolbar-panel";

    // Create state icon (left side)
    const stateIcon = document.createElement("div");
    stateIcon.className = "cm-toolbar-state-icon";
    stateIcon.textContent = "📄"; // Default file icon

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

    const resultsList = document.createElement("ul");
    resultsList.className = "cm-search-results";
    dom.appendChild(resultsList);

    let selectedIndex = 0;
    let namingMode: NamingMode = { active: false, type: 'create-file', originalQuery: '' };

    // Tracks gutter width for toolbar alignment
    function updateGutterWidthVariables() {
        const gutters = view.dom.querySelector('.cm-gutters');
        if (gutters) {
            const gutterWidth = gutters.getBoundingClientRect().width;
            dom.style.setProperty('--cm-gutter-width', `${gutterWidth}px`);

            const numberGutter = gutters.querySelector('.cm-lineNumbers');

            if (numberGutter) {
                const numberGutterWidth = numberGutter.getBoundingClientRect().width;
                dom.style.setProperty('--cm-gutter-lineno-width', `${numberGutterWidth}px`);
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
        resultIcon.textContent = isCommandResult(result) ? result.icon : '📄';

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

        // Separate commands from search results
        const commands = results.filter(isCommandResult);
        const searchResults = results.filter(isSearchResult);

        let currentIndex = 0;

        // Render commands section
        commands.forEach((command) => {
            children.push(renderItem(command, currentIndex));
            currentIndex++;
        });

        // Render search results section
        searchResults.forEach((result) => {
            children.push(renderItem(result, currentIndex));
            currentIndex++;
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
            stateIcon.textContent = namingMode.type === 'create-file' ? '📄' : '✏️';
        } else {
            stateIcon.textContent = '📄'; // Default file icon
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

    // Close dropdown when clicking outside
    function handleClickOutside(event: Event) {
        if (!dom.contains(event.target as Node)) {
            safeDispatch(view, { effects: setSearchResults.of([]) });
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

                // Add command results first (passing search results to check for existing files)
                const commands = createCommandResults(query, view, searchResults);

                results = searchResults.concat(commands);
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

            // Add command results first (passing search results to check for existing files)
            const commands = createCommandResults(query, view, searchResults);
            results.push(...commands);

            // Add search results
            results.push(...searchResults);
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
        },
        destroy() {
            // Clean up event listeners when panel is destroyed
            document.removeEventListener("click", handleClickOutside);

            // Clean up ResizeObserver
            if (gutterObserver) {
                gutterObserver.disconnect();
                gutterObserver = null;
            }
        }
    };
};