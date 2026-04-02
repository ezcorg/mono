/**
 * CodeMirror panel adapter for the shared ToolbarCore.
 *
 * Handles CM-specific concerns: terminal mode, LSP log, auto-hide,
 * gutter-width CSS variables, loading spinner, settings compartment
 * reconfiguration, and the CM StateField / StateEffect plumbing.
 */
import { EditorView, Panel, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { CodeblockFacet, openFileEffect, currentFileField, setThemeEffect, lineWrappingCompartment, lineNumbersCompartment, foldGutterCompartment } from "../editor";
import { foldGutter } from "@codemirror/language";
import { LSP, LspLog } from "../utils/lsp";
import { goBack, goForward, canGoBack, canGoForward } from "../navigation";
import { settingsField, resolveThemeDark, updateSettingsEffect, EditorSettings } from "./settings";
import {
    ToolbarCore, type ToolbarHost, type ToolbarIntent, type SearchResult, type SettingsEntry,
    SEARCH_ICON, getFileIcon, DEFAULT_FILE_ICON,
} from "./toolbar-core";

// Re-export shared types so existing consumers keep working
export type { CommandResult, BrowseEntry, SettingsEntry, SearchResult } from "./toolbar-core";

// ---------------------------------------------------------------------------
// CM-specific FileActionEntry (action receives EditorView)
// ---------------------------------------------------------------------------
export interface FileActionEntry {
    extensions: string[];
    label: string;
    icon: string;
    action: (view: EditorView) => void;
}

const fileActionRegistry: FileActionEntry[] = [];

export function registerFileAction(entry: FileActionEntry) {
    fileActionRegistry.push(entry);
}

// ---------------------------------------------------------------------------
// StateField / StateEffect kept for backward-compat (used as extension)
// ---------------------------------------------------------------------------
export const setSearchResults = StateEffect.define<SearchResult[]>();
export const searchResultsField = StateField.define<SearchResult[]>({
    create() { return []; },
    update(value, tr) {
        for (let e of tr.effects) if (e.is(setSearchResults)) return e.value;
        return value;
    }
});

// ---------------------------------------------------------------------------
// Theme cycle constants
// ---------------------------------------------------------------------------
const themeCycleValues: EditorSettings['theme'][] = ['light', 'dark', 'system'];
const themeIcons: Record<EditorSettings['theme'], string> = {
    light: '\u2600\uFE0F',
    dark: '\uD83C\uDF19',
    system: '\uD83C\uDF13',
};
const fontFamilyCycleValues = ['', '"UbuntuMono NF", monospace'];
const fontFamilyLabels: Record<string, string> = {
    '': 'System default',
    '"UbuntuMono NF", monospace': 'UbuntuMono NF',
};
const agentUrlCycleValues = ['', 'http://localhost:3141'];
const agentUrlLabels: Record<string, string> = {
    '': 'Off',
    'http://localhost:3141': 'localhost:3141',
};
const aiModelCycleValues = ['haiku', 'sonnet', 'opus'];
const aiModelLabels: Record<string, string> = {
    'haiku': 'Haiku (fast)',
    'sonnet': 'Sonnet (balanced)',
    'opus': 'Opus (powerful)',
};

// ---------------------------------------------------------------------------
// CM settings helpers
// ---------------------------------------------------------------------------
function buildCMSettingsEntries(view: EditorView, filter: string): SettingsEntry[] {
    const s = view.state.field(settingsField);
    const entries: SettingsEntry[] = [
        { id: `Theme: ${s.theme}`, settingKey: 'theme', type: 'settings-cycle', icon: themeIcons[s.theme], currentValue: s.theme },
        { id: `Font size: ${s.fontSize}px`, settingKey: 'fontSize', type: 'settings-input', icon: 'Aa', currentValue: String(s.fontSize) },
        { id: `Font family: ${fontFamilyLabels[s.fontFamily] || s.fontFamily || 'System default'}`, settingKey: 'fontFamily', type: 'settings-cycle', icon: 'Aa', currentValue: s.fontFamily },
        { id: `Autosave: ${s.autosave ? 'on' : 'off'}`, settingKey: 'autosave', type: 'settings-toggle', icon: s.autosave ? '\u2713' : '\u2717', currentValue: String(s.autosave) },
        { id: `Line wrap: ${s.lineWrap ? 'on' : 'off'}`, settingKey: 'lineWrap', type: 'settings-toggle', icon: s.lineWrap ? '\u2713' : '\u2717', currentValue: String(s.lineWrap) },
        { id: `Max lines: ${s.maxVisibleLines || 'unlimited'}`, settingKey: 'maxVisibleLines', type: 'settings-input', icon: '\u2195', currentValue: String(s.maxVisibleLines || '') },
        { id: `Line numbers: ${s.showLineNumbers ? 'on' : 'off'}`, settingKey: 'showLineNumbers', type: 'settings-toggle', icon: s.showLineNumbers ? '\u2713' : '\u2717', currentValue: String(s.showLineNumbers) },
        { id: `Fold gutter: ${s.showFoldGutter ? 'on' : 'off'}`, settingKey: 'showFoldGutter', type: 'settings-toggle', icon: s.showFoldGutter ? '\u2713' : '\u2717', currentValue: String(s.showFoldGutter) },
        { id: `Auto-hide toolbar: ${s.autoHideToolbar ? 'on' : 'off'}`, settingKey: 'autoHideToolbar', type: 'settings-toggle', icon: s.autoHideToolbar ? '\u2713' : '\u2717', currentValue: String(s.autoHideToolbar) },
        { id: `AI agent: ${agentUrlLabels[s.agentUrl] || s.agentUrl || 'Off'}`, settingKey: 'agentUrl', type: 'settings-cycle', icon: s.agentUrl ? '\u2713' : '\u2717', currentValue: s.agentUrl },
        { id: `AI model: ${aiModelLabels[s.aiModel] || s.aiModel}`, settingKey: 'aiModel', type: 'settings-cycle', icon: '\u2699', currentValue: s.aiModel },
        { id: 'Clear filesystem', settingKey: 'clearFilesystem', type: 'settings-action', icon: '\u2717', currentValue: '' },
    ];
    if (!filter) return entries;
    const lf = filter.toLowerCase();
    return entries.filter(e => e.id.toLowerCase().includes(lf));
}

function handleCMSettingsEntry(view: EditorView, entry: SettingsEntry) {
    const s = view.state.field(settingsField);
    if (entry.type === 'settings-toggle') {
        const key = entry.settingKey as keyof EditorSettings;
        const newValue = !s[key];
        const effects: StateEffect<any>[] = [updateSettingsEffect.of({ [key]: newValue })];
        if (key === 'lineWrap') effects.push(lineWrappingCompartment.reconfigure(newValue ? EditorView.lineWrapping : []));
        if (key === 'showLineNumbers') effects.push(lineNumbersCompartment.reconfigure(newValue ? [lineNumbers(), highlightActiveLineGutter()] : []));
        if (key === 'showFoldGutter') effects.push(foldGutterCompartment.reconfigure(newValue ? [foldGutter()] : []));
        // autoHideToolbar handled in update cycle
        safeDispatch(view, { effects });
    } else if (entry.type === 'settings-cycle') {
        if (entry.settingKey === 'theme') {
            const idx = themeCycleValues.indexOf(s.theme);
            const next = themeCycleValues[(idx + 1) % themeCycleValues.length];
            safeDispatch(view, { effects: [updateSettingsEffect.of({ theme: next }), setThemeEffect.of({ dark: resolveThemeDark(next) })] });
        } else if (entry.settingKey === 'fontFamily') {
            const idx = fontFamilyCycleValues.indexOf(s.fontFamily);
            safeDispatch(view, { effects: [updateSettingsEffect.of({ fontFamily: fontFamilyCycleValues[(idx + 1) % fontFamilyCycleValues.length] })] });
        } else if (entry.settingKey === 'agentUrl') {
            const idx = agentUrlCycleValues.indexOf(s.agentUrl);
            safeDispatch(view, { effects: [updateSettingsEffect.of({ agentUrl: agentUrlCycleValues[(idx + 1) % agentUrlCycleValues.length] })] });
        } else if (entry.settingKey === 'aiModel') {
            const idx = aiModelCycleValues.indexOf(s.aiModel);
            safeDispatch(view, { effects: [updateSettingsEffect.of({ aiModel: aiModelCycleValues[(idx + 1) % aiModelCycleValues.length] })] });
        }
    }
    // settings-input handled by confirmSettingsEdit — ToolbarCore shows inline input
}

function confirmCMSettingsEdit(view: EditorView, key: string, rawValue: string) {
    if (key === 'fontSize') {
        const size = Number(rawValue);
        if (!isNaN(size) && size >= 1 && size <= 128) safeDispatch(view, { effects: [updateSettingsEffect.of({ fontSize: size })] });
    } else if (key === 'maxVisibleLines') {
        const lines = rawValue === '' ? 0 : Number(rawValue);
        if (!isNaN(lines) && lines >= 0) safeDispatch(view, { effects: [updateSettingsEffect.of({ maxVisibleLines: Math.floor(lines) })] });
    }
}

// ---------------------------------------------------------------------------
// LSP log overlay
// ---------------------------------------------------------------------------
function createLspLogOverlay(): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "cm-settings-overlay";
    const content = document.createElement("div");
    content.className = "cm-lsp-log-content";
    overlay.appendChild(content);
    function render() {
        const fragment = document.createDocumentFragment();
        for (const entry of LspLog.entries()) {
            const div = document.createElement("div");
            div.className = `cm-lsp-log-entry cm-lsp-log-${entry.level}`;
            div.textContent = `[${new Date(entry.timestamp).toLocaleTimeString()}] [${entry.level}] ${entry.message}`;
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

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
const SPINNER_FADE_MS = 150;
function safeDispatch(view: EditorView, spec: any) {
    queueMicrotask(() => { try { view.dispatch(spec); } catch (e) { console.error(e); } });
}

// ---------------------------------------------------------------------------
// CM Panel
// ---------------------------------------------------------------------------
export const toolbarPanel = (view: EditorView): Panel => {
    let { filepath, language, index } = view.state.facet(CodeblockFacet);

    // --- Clear filesystem ---
    async function clearFilesystem() {
        const fs = view.state.facet(CodeblockFacet).fs;
        // Recursively collect all file paths first, then delete
        const filesToDelete: string[] = [];
        const dirsToDelete: string[] = [];
        async function collectEntries(dir: string) {
            try {
                const entries = await fs.readDir(dir);
                for (const [name, type] of entries) {
                    const fullPath = dir === '/' ? `/${name}` : `${dir}/${name}`;
                    if (type === 2 /* Directory */) {
                        await collectEntries(fullPath);
                        dirsToDelete.push(fullPath);
                    } else {
                        filesToDelete.push(fullPath);
                    }
                }
            } catch { /* empty or inaccessible directory */ }
        }
        await collectEntries('/');

        // Delete all files
        for (const path of filesToDelete) {
            await fs.unlink(path).catch(() => {});
        }
        // Delete directories deepest-first
        for (const dir of dirsToDelete.reverse()) {
            await fs.unlink(dir).catch(() => {});
        }

        // Clear search index
        if (index) {
            index.index.removeAll();
            if (index.savePath) {
                await fs.writeFile(index.savePath, '{}').catch(() => {});
            }
        }

        // Try to clear OPFS storage
        if (typeof navigator !== 'undefined' && 'storage' in navigator && 'getDirectory' in (navigator.storage ?? {})) {
            try {
                const root = await navigator.storage.getDirectory();
                // @ts-ignore - remove() may not be in all type defs
                for await (const [name] of root.entries()) {
                    await root.removeEntry(name, { recursive: true }).catch(() => {});
                }
            } catch { /* OPFS not available or permission denied */ }
        }

        // Reset editor to blank state
        safeDispatch(view, {
            changes: { from: 0, to: view.state.doc.length, insert: '' },
            effects: [
                openFileEffect.of({ path: '', skipSave: true }),
                setSearchResults.of([]),
            ]
        });
    }

    // --- Create ToolbarCore with CM host ---
    const core = new ToolbarCore({
        fs: view.state.facet(CodeblockFacet).fs,
        index,
        cwd: view.state.facet(CodeblockFacet).cwd,
        filepath,
        language,
        openFile(path, opts) {
            safeDispatch(view, { effects: [setSearchResults.of([]), openFileEffect.of({ path, skipSave: opts?.skipSave })] });
        },
        getDocContent() { return view.state.doc.toString(); },
        focusEditor() { view.focus(); },
        notifyFileChanged(path, type) { LSP.notifyFileChanged(path, type); },
        getCurrentFilePath() { return view.state.field(currentFileField).path; },
        isAutosaveEnabled() { return view.state.field(settingsField).autosave; },
        buildSettingsEntries(filter) { return buildCMSettingsEntries(view, filter); },
        handleSettingsEntry(entry) { handleCMSettingsEntry(view, entry); },
        confirmSettingsEdit(key, rawValue) { confirmCMSettingsEdit(view, key, rawValue); },
        fileActions: fileActionRegistry.map(fa => ({
            extensions: fa.extensions,
            label: fa.label,
            icon: fa.icon,
            action: () => fa.action(view),
        })),
        hasTerminal: !!view.state.facet(CodeblockFacet).jswasi,
        onEnterTerminal() { enterTerminalMode(); },
        onClearFilesystem: clearFilesystem,
        goBack() { return goBack(view); },
        goForward() { return goForward(view); },
        canGoBack() { return canGoBack(view); },
        canGoForward() { return canGoForward(view); },
        async classifyIntent(query, context): Promise<ToolbarIntent | null> {
            const agentUrl = view.state.field(settingsField).agentUrl;
            if (!agentUrl) return null;
            const model = view.state.field(settingsField).aiModel || 'haiku';
            const url = agentUrl.replace(/\/+$/, '') + '/api/ai/edit';
            const systemPrompt = [
                'You are a toolbar intent classifier. Given the user\'s toolbar query, respond with EXACTLY one word — the intent category.',
                'Categories: file-search, file-create, file-action, browse, settings, command, language, unknown',
                'file-search: looking for an existing file by name/path',
                'file-create: wants to create a new file',
                'file-action: wants to rename, save-as, or perform an action on a file',
                'browse: wants to explore directory structure',
                'settings: wants to change editor settings, theme, font, etc.',
                'command: wants to run a command like import, terminal, etc.',
                'language: typed a programming language name',
                'unknown: can\'t determine intent',
                'Respond with only the category name, nothing else.',
            ].join('\n');
            const prompt = `Current file: ${context.currentFile || '(none)'}\nToolbar query: "${query}"`;
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ prompt, selection: '', codeBefore: '', codeAfter: '', model, systemPrompt }),
                });
                if (!res.ok) return null;
                const text = (await res.text()).trim().toLowerCase();
                const valid: ToolbarIntent[] = ['file-search', 'file-create', 'file-action', 'browse', 'settings', 'command', 'language', 'unknown'];
                return valid.includes(text as ToolbarIntent) ? text as ToolbarIntent : null;
            } catch { return null; }
        },
    } satisfies ToolbarHost);

    const dom = core.dom;

    // --- LSP log button ---
    const lspLogBtn = document.createElement("button");
    lspLogBtn.className = "cm-toolbar-lsp-log";
    lspLogBtn.style.fontFamily = 'var(--cm-icon-font-family)';
    let lspLogOverlay: HTMLElement | null = null;
    let lspLogSavedInputValue: string | null = null;

    function updateLspLogIcon() {
        const filePath = view.state.field(currentFileField).path;
        if (filePath) { const icon = getFileIcon(filePath); lspLogBtn.textContent = icon.glyph; lspLogBtn.style.color = icon.color || ''; }
        else { lspLogBtn.textContent = DEFAULT_FILE_ICON; lspLogBtn.style.color = ''; }
    }
    function updateLspLogVisibility() {
        lspLogBtn.style.display = view.state.field(settingsField).lspLogEnabled ? '' : 'none';
    }
    updateLspLogIcon();
    updateLspLogVisibility();

    function openLspLogOverlay() {
        lspLogSavedInputValue = core.input.value;
        core.input.value = 'lsp.log';
        lspLogOverlay = createLspLogOverlay();
        const panelsTop = view.dom.querySelector('.cm-panels-top');
        if (panelsTop) lspLogOverlay.style.top = `${panelsTop.getBoundingClientRect().height}px`;
        view.dom.appendChild(lspLogOverlay);
    }
    function closeLspLogOverlay() {
        if (!lspLogOverlay) return;
        (lspLogOverlay as any)._lspLogUnsub?.();
        lspLogOverlay.remove();
        lspLogOverlay = null;
        if (lspLogSavedInputValue !== null) { core.input.value = lspLogSavedInputValue; lspLogSavedInputValue = null; }
    }
    lspLogBtn.addEventListener("click", () => { lspLogOverlay ? closeLspLogOverlay() : openLspLogOverlay(); });
    // LSP log button hidden — feature non-functional. Keeping code for future use.
    // dom.appendChild(lspLogBtn);

    // --- Terminal mode (CM-specific) ---
    let terminalMode = { active: false };
    let terminalResizeObserver: ResizeObserver | null = null;

    const terminalWrapper = document.createElement("div");
    terminalWrapper.className = "cm-terminal-wrapper";
    terminalWrapper.style.display = 'none';
    dom.appendChild(terminalWrapper);

    terminalWrapper.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); exitTerminalMode(); }
    }, { capture: true });

    function handleTerminalClickOutside(event: Event) {
        if (!terminalMode.active) return;
        if (!dom.contains(event.target as Node)) exitTerminalMode();
    }

    function syncTerminalWrapperHeight() {
        const cmEditor = terminalWrapper.querySelector('.cm-editor') as HTMLElement | null;
        if (!cmEditor) return;
        const minPx = dom.offsetHeight;
        terminalWrapper.style.height = `${Math.min(Math.max(cmEditor.scrollHeight, minPx), window.innerHeight * 0.5)}px`;
    }

    async function enterTerminalMode() {
        terminalMode.active = true;
        view.dom.style.setProperty('--cm-gutter-width', '0px');
        view.dom.style.setProperty('--cm-gutter-lineno-width', '0px');
        core.stateIconContainer.style.visibility = 'hidden';
        core.inputContainer.style.visibility = 'hidden';
        terminalWrapper.style.display = '';
        safeDispatch(view, { effects: setSearchResults.of([]) });
        document.addEventListener("click", handleTerminalClickOutside);
        const termMod = await import('./terminal');
        const terminalEl = await termMod.ensureTerminalElement(view);
        if (!terminalWrapper.contains(terminalEl)) terminalWrapper.appendChild(terminalEl);
        termMod.setHeightCallback(() => { if (terminalMode.active) syncTerminalWrapperHeight(); });
        terminalResizeObserver = new ResizeObserver(() => {
            termMod.handleTerminalResize(view.state.field(settingsField).fontSize);
        });
        terminalResizeObserver.observe(terminalWrapper);
        requestAnimationFrame(() => { termMod.focusTerminalEl(); syncTerminalWrapperHeight(); });
    }

    function exitTerminalMode() {
        if (!terminalMode.active) return;
        terminalMode.active = false;
        updateGutterWidthVariables();
        core.stateIconContainer.style.visibility = '';
        core.inputContainer.style.visibility = '';
        terminalWrapper.style.display = 'none';
        core.stateIcon.textContent = SEARCH_ICON;
        core.resetInputToCurrentFile();
        import('./terminal').then(({ setHeightCallback }) => setHeightCallback(null));
        terminalResizeObserver?.disconnect();
        terminalResizeObserver = null;
        document.removeEventListener("click", handleTerminalClickOutside);
    }

    // --- System theme listener ---
    const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
    function handleSystemThemeChange() {
        if (view.state.field(settingsField).theme === 'system') {
            safeDispatch(view, { effects: setThemeEffect.of({ dark: systemThemeQuery.matches }) });
        }
    }
    systemThemeQuery.addEventListener('change', handleSystemThemeChange);

    // --- Apply settings ---
    function applySettings() {
        const s = view.state.field(settingsField);
        view.dom.style.setProperty('--cm-font-size', `${s.fontSize}px`);
        if (s.fontFamily) view.dom.style.setProperty('--cm-font-family', s.fontFamily);
        else view.dom.style.removeProperty('--cm-font-family');
        const scroller = view.dom.querySelector('.cm-scroller') as HTMLElement;
        if (scroller) {
            scroller.style.maxHeight = s.maxVisibleLines > 0 ? `${s.maxVisibleLines * s.fontSize * 1.5}px` : '';
        }
    }
    applySettings();

    const initialSettings = view.state.field(settingsField);
    view.dom.setAttribute('data-theme', resolveThemeDark(initialSettings.theme) ? 'dark' : 'light');
    let autoHidePendingInit = initialSettings.autoHideToolbar;

    // --- Gutter width ---
    function updateGutterWidthVariables() {
        const chWidth = view.defaultCharacterWidth;
        const iconColWidth = Math.ceil(2 * chWidth);
        view.dom.style.setProperty('--cm-icon-col-width', `${iconColWidth}px`);
        const gutters = view.dom.querySelector('.cm-gutters');
        if (gutters) {
            view.dom.style.setProperty('--cm-gutter-width', `${gutters.getBoundingClientRect().width}px`);
            const numberGutter = gutters.querySelector('.cm-lineNumbers');
            view.dom.style.setProperty('--cm-gutter-lineno-width', numberGutter ? `${numberGutter.getBoundingClientRect().width}px` : `${iconColWidth}px`);
        } else {
            view.dom.style.setProperty('--cm-gutter-width', `${iconColWidth}px`);
            view.dom.style.setProperty('--cm-gutter-lineno-width', `${iconColWidth}px`);
        }
    }
    let gutterObserver: ResizeObserver | null = null;
    function setupGutterObserver() {
        const gutters = view.dom.querySelector('.cm-gutters');
        if (gutters && window.ResizeObserver) {
            gutterObserver = new ResizeObserver(() => updateGutterWidthVariables());
            gutterObserver.observe(gutters);
        }
    }
    updateGutterWidthVariables();
    setupGutterObserver();

    // --- Auto-hide ---
    let autoHideEnabled = false;
    let panelsTopEl: HTMLElement | null = null;
    function getPanelsTop(): HTMLElement | null { if (!panelsTopEl) panelsTopEl = dom.parentElement as HTMLElement | null; return panelsTopEl; }
    function retractToolbar() { const pt = getPanelsTop(); if (pt && autoHideEnabled) pt.classList.add('cm-toolbar-retracted'); }
    function expandToolbar() { const pt = getPanelsTop(); if (pt) pt.classList.remove('cm-toolbar-retracted'); }
    function isToolbarInteractive() { return dom.contains(document.activeElement); }

    function handleEditorMouseMove(e: MouseEvent) {
        if (!autoHideEnabled) return;
        const pt = getPanelsTop(); if (!pt) return;
        if (dom.contains(e.target as Node) || pt.contains(e.target as Node)) return;
        const scroller = view.dom.querySelector('.cm-scroller');
        if (scroller) {
            const r = scroller.getBoundingClientRect();
            if (e.clientY >= r.top && e.clientY < r.top + view.defaultLineHeight) { expandToolbar(); return; }
        }
        if (!isToolbarInteractive()) retractToolbar();
    }
    function handleEditorMouseLeave() { if (autoHideEnabled && !isToolbarInteractive()) retractToolbar(); }
    function handleInputBlur() { if (!autoHideEnabled) return; setTimeout(() => { if (autoHideEnabled && !isToolbarInteractive()) retractToolbar(); }, 100); }

    function enableAutoHide() {
        autoHideEnabled = true;
        view.dom.addEventListener('mousemove', handleEditorMouseMove);
        view.dom.addEventListener('mouseleave', handleEditorMouseLeave);
        core.input.addEventListener('blur', handleInputBlur);
        retractToolbar();
    }
    function disableAutoHide() {
        autoHideEnabled = false;
        view.dom.removeEventListener('mousemove', handleEditorMouseMove);
        view.dom.removeEventListener('mouseleave', handleEditorMouseLeave);
        core.input.removeEventListener('blur', handleInputBlur);
        expandToolbar();
    }

    // --- Panel lifecycle ---
    return {
        dom,
        top: true,
        update(update) {
            // Settings changes
            const prevSettings = update.startState.field(settingsField);
            const nextSettings = update.state.field(settingsField);
            if (prevSettings.fontSize !== nextSettings.fontSize || prevSettings.fontFamily !== nextSettings.fontFamily || prevSettings.maxVisibleLines !== nextSettings.maxVisibleLines) applySettings();
            if (prevSettings.lspLogEnabled !== nextSettings.lspLogEnabled) { updateLspLogVisibility(); if (!nextSettings.lspLogEnabled && lspLogOverlay) closeLspLogOverlay(); }
            if (prevSettings.autoHideToolbar !== nextSettings.autoHideToolbar) { if (nextSettings.autoHideToolbar) enableAutoHide(); else disableAutoHide(); }
            if (autoHidePendingInit && getPanelsTop()) { autoHidePendingInit = false; enableAutoHide(); }
            if (prevSettings.showLineNumbers !== nextSettings.showLineNumbers || prevSettings.showFoldGutter !== nextSettings.showFoldGutter) queueMicrotask(() => updateGutterWidthVariables());
            if (core.isSettingsModeActive() && prevSettings !== nextSettings) core.refreshSettingsEntries();

            // Loading spinner
            const prevFile = update.startState.field(currentFileField);
            const nextFile = update.state.field(currentFileField);
            if (prevFile.loading !== nextFile.loading) {
                if (nextFile.loading) {
                    core.stateIcon.style.display = 'none';
                    core.stateIcon.style.opacity = '0';
                    if (!core.stateIconContainer.querySelector('.cm-loading')) {
                        const spinner = document.createElement('div');
                        spinner.className = 'cm-loading';
                        core.stateIconContainer.appendChild(spinner);
                    }
                } else {
                    const spinner = core.stateIconContainer.querySelector('.cm-loading') as HTMLElement | null;
                    if (spinner) {
                        spinner.style.opacity = '0';
                        setTimeout(() => {
                            spinner.remove();
                            if (!view.state.field(currentFileField).loading) {
                                core.stateIcon.style.display = '';
                                core.stateIcon.offsetHeight;
                                core.stateIcon.style.opacity = '1';
                            }
                        }, SPINNER_FADE_MS);
                    } else {
                        core.stateIcon.style.display = '';
                        core.stateIcon.style.opacity = '1';
                    }
                }
            }

            // Sync file path
            if (prevFile.path !== nextFile.path) {
                updateLspLogIcon();
                if (!core.isNamingModeActive() && !lspLogOverlay && !core.isSettingsModeActive() && !terminalMode.active) {
                    core.setFilePath(nextFile.path);
                }
            }
        },
        destroy() {
            core.destroy();
            document.removeEventListener("click", handleTerminalClickOutside);
            systemThemeQuery.removeEventListener('change', handleSystemThemeChange);
            if (autoHideEnabled) disableAutoHide();
            closeLspLogOverlay();
            exitTerminalMode();
            gutterObserver?.disconnect();
        }
    };
};
