import { EditorView, Panel } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { setThemeEffect } from "../editor";
import { LspLog } from "../utils/lsp";

export interface EditorSettings {
    theme: 'light' | 'dark' | 'system';
    fontSize: number;
    fontFamily: string;
    autosave: boolean;
    lspLogEnabled: boolean;
    agentUrl: string;
    terminalEnabled: boolean;
}

const defaultSettings: EditorSettings = {
    theme: 'system',
    fontSize: 16,
    fontFamily: '',
    autosave: true,
    lspLogEnabled: false,
    agentUrl: '',
    terminalEnabled: false,
};

export const updateSettingsEffect = StateEffect.define<Partial<EditorSettings>>();

export const settingsField = StateField.define<EditorSettings>({
    create() {
        return { ...defaultSettings };
    },
    update(value, tr) {
        for (const e of tr.effects) {
            if (e.is(updateSettingsEffect)) {
                return { ...value, ...e.value };
            }
        }
        return value;
    }
});

function resolveThemeDark(theme: EditorSettings['theme']): boolean {
    if (theme === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return theme === 'dark';
}

const themeIcons: Record<EditorSettings['theme'], string> = {
    light: '\u2600\uFE0F',  // ☀️
    dark: '\uD83C\uDF19',   // 🌙
    system: '\uD83D\uDCBB', // 💻
};

const themeCycle: Record<EditorSettings['theme'], EditorSettings['theme']> = {
    light: 'dark',
    dark: 'system',
    system: 'light',
};

// Settings overlay component
function createSettingsOverlay(view: EditorView, onClose: () => void): HTMLElement {
    const settings = view.state.field(settingsField);

    const overlay = document.createElement("div");
    overlay.className = "cm-settings-overlay";

    // Header
    const header = document.createElement("div");
    header.className = "cm-settings-header";
    header.textContent = "Settings";
    const closeBtn = document.createElement("button");
    closeBtn.className = "cm-settings-close";
    closeBtn.textContent = "\u2715"; // ✕
    closeBtn.addEventListener("click", onClose);
    header.appendChild(closeBtn);
    overlay.appendChild(header);

    // Theme section
    const themeSection = document.createElement("div");
    themeSection.className = "cm-settings-section";

    const themeTitle = document.createElement("div");
    themeTitle.className = "cm-settings-section-title";
    themeTitle.textContent = "Theme";
    themeSection.appendChild(themeTitle);

    // Font size
    const fontSizeRow = document.createElement("div");
    fontSizeRow.className = "cm-settings-row";
    const fontSizeLabel = document.createElement("label");
    fontSizeLabel.textContent = "Font size";
    const fontSizeControl = document.createElement("div");
    fontSizeControl.className = "cm-settings-control";
    const fontSizeValue = document.createElement("span");
    fontSizeValue.className = "cm-settings-value";
    fontSizeValue.textContent = `${settings.fontSize}px`;
    const fontSizeRange = document.createElement("input");
    fontSizeRange.type = "range";
    fontSizeRange.min = "10";
    fontSizeRange.max = "24";
    fontSizeRange.step = "1";
    fontSizeRange.value = String(settings.fontSize);
    fontSizeRange.addEventListener("input", () => {
        const size = Number(fontSizeRange.value);
        fontSizeValue.textContent = `${size}px`;
        view.dispatch({ effects: updateSettingsEffect.of({ fontSize: size }) });
    });
    fontSizeControl.appendChild(fontSizeRange);
    fontSizeControl.appendChild(fontSizeValue);
    fontSizeRow.appendChild(fontSizeLabel);
    fontSizeRow.appendChild(fontSizeControl);
    themeSection.appendChild(fontSizeRow);

    // Font family
    const fontFamilyRow = document.createElement("div");
    fontFamilyRow.className = "cm-settings-row";
    const fontFamilyLabel = document.createElement("label");
    fontFamilyLabel.textContent = "Font family";
    const fontFamilySelect = document.createElement("select");
    fontFamilySelect.className = "cm-settings-select";
    const fontOptions = [
        { label: "System default", value: "" },
        { label: "UbuntuMono Nerd Font", value: '"UbuntuMono NF", monospace' },
    ];
    for (const opt of fontOptions) {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        if (settings.fontFamily === opt.value) option.selected = true;
        fontFamilySelect.appendChild(option);
    }
    fontFamilySelect.addEventListener("change", () => {
        view.dispatch({ effects: updateSettingsEffect.of({ fontFamily: fontFamilySelect.value }) });
    });
    fontFamilyRow.appendChild(fontFamilyLabel);
    fontFamilyRow.appendChild(fontFamilySelect);
    themeSection.appendChild(fontFamilyRow);

    // Color theme radio
    const colorThemeRow = document.createElement("div");
    colorThemeRow.className = "cm-settings-row";
    const colorThemeLabel = document.createElement("label");
    colorThemeLabel.textContent = "Color theme";
    const radioGroup = document.createElement("div");
    radioGroup.className = "cm-settings-radio-group";
    for (const t of ['light', 'dark', 'system'] as const) {
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "cm-color-theme";
        radio.value = t;
        radio.id = `cm-theme-${t}`;
        if (settings.theme === t) radio.checked = true;
        radio.addEventListener("change", () => {
            if (radio.checked) {
                view.dispatch({
                    effects: [
                        updateSettingsEffect.of({ theme: t }),
                        setThemeEffect.of({ dark: resolveThemeDark(t) }),
                    ]
                });
            }
        });
        const radioLabel = document.createElement("label");
        radioLabel.htmlFor = `cm-theme-${t}`;
        radioLabel.textContent = t.charAt(0).toUpperCase() + t.slice(1);
        radioGroup.appendChild(radio);
        radioGroup.appendChild(radioLabel);
    }
    colorThemeRow.appendChild(colorThemeLabel);
    colorThemeRow.appendChild(radioGroup);
    themeSection.appendChild(colorThemeRow);

    overlay.appendChild(themeSection);

    // Editor section
    const editorSection = document.createElement("div");
    editorSection.className = "cm-settings-section";
    const editorTitle = document.createElement("div");
    editorTitle.className = "cm-settings-section-title";
    editorTitle.textContent = "Editor";
    editorSection.appendChild(editorTitle);

    const autosaveRow = document.createElement("div");
    autosaveRow.className = "cm-settings-row";
    const autosaveLabel = document.createElement("label");
    autosaveLabel.textContent = "Autosave";
    autosaveLabel.htmlFor = "cm-autosave";
    const autosaveCheckbox = document.createElement("input");
    autosaveCheckbox.type = "checkbox";
    autosaveCheckbox.id = "cm-autosave";
    autosaveCheckbox.checked = settings.autosave;
    autosaveCheckbox.addEventListener("change", () => {
        view.dispatch({ effects: updateSettingsEffect.of({ autosave: autosaveCheckbox.checked }) });
    });
    autosaveRow.appendChild(autosaveLabel);
    autosaveRow.appendChild(autosaveCheckbox);
    editorSection.appendChild(autosaveRow);

    // LSP log toggle
    const lspLogRow = document.createElement("div");
    lspLogRow.className = "cm-settings-row";
    const lspLogLabel = document.createElement("label");
    lspLogLabel.textContent = "LSP server log";
    lspLogLabel.htmlFor = "cm-lsp-log";
    const lspLogCheckbox = document.createElement("input");
    lspLogCheckbox.type = "checkbox";
    lspLogCheckbox.id = "cm-lsp-log";
    lspLogCheckbox.checked = settings.lspLogEnabled;
    lspLogCheckbox.addEventListener("change", () => {
        view.dispatch({ effects: updateSettingsEffect.of({ lspLogEnabled: lspLogCheckbox.checked }) });
    });
    lspLogRow.appendChild(lspLogLabel);
    lspLogRow.appendChild(lspLogCheckbox);
    editorSection.appendChild(lspLogRow);

    overlay.appendChild(editorSection);

    // AI Agent section
    const aiSection = document.createElement("div");
    aiSection.className = "cm-settings-section";
    const aiTitle = document.createElement("div");
    aiTitle.className = "cm-settings-section-title";
    aiTitle.textContent = "AI Agent";
    aiSection.appendChild(aiTitle);

    const agentRow = document.createElement("div");
    agentRow.className = "cm-settings-row";
    const agentLabel = document.createElement("label");
    agentLabel.textContent = "Agent URL";
    const agentInput = document.createElement("input");
    agentInput.type = "text";
    agentInput.className = "cm-settings-input";
    agentInput.placeholder = "OpenAPI-compatible endpoint";
    agentInput.value = settings.agentUrl;
    agentInput.addEventListener("change", () => {
        view.dispatch({ effects: updateSettingsEffect.of({ agentUrl: agentInput.value }) });
    });
    agentRow.appendChild(agentLabel);
    agentRow.appendChild(agentInput);
    aiSection.appendChild(agentRow);
    // TODO: integrate via @marimo-team/codemirror-ai

    overlay.appendChild(aiSection);

    // Terminal section
    const termSection = document.createElement("div");
    termSection.className = "cm-settings-section";
    const termTitle = document.createElement("div");
    termTitle.className = "cm-settings-section-title";
    termTitle.textContent = "Terminal";
    termSection.appendChild(termTitle);

    const termRow = document.createElement("div");
    termRow.className = "cm-settings-row";
    const termBtn = document.createElement("button");
    termBtn.className = "cm-settings-button cm-settings-button-disabled";
    termBtn.textContent = "Terminal (coming soon)";
    termBtn.disabled = true;
    termRow.appendChild(termBtn);
    termSection.appendChild(termRow);
    // TODO: ghostty-web + wanix integration

    overlay.appendChild(termSection);

    return overlay;
}

// Footer Panel
export const footerPanel = (view: EditorView): Panel => {
    const dom = document.createElement("div");
    dom.className = "cm-footer-panel";

    const left = document.createElement("div");
    left.className = "cm-footer-left";

    // Mirror the toolbar gutter-width container so the toggle aligns with the state icon
    const toggleContainer = document.createElement("div");
    toggleContainer.className = "cm-footer-toggle-container";

    const right = document.createElement("div");
    right.className = "cm-footer-right";

    // Theme toggle button
    const themeToggle = document.createElement("button");
    themeToggle.className = "cm-footer-theme-toggle";
    const settings = view.state.field(settingsField);
    themeToggle.textContent = themeIcons[settings.theme];

    // System theme media query listener
    let mediaQuery: MediaQueryList | null = null;
    let mediaHandler: ((e: MediaQueryListEvent) => void) | null = null;

    function setupSystemThemeListener() {
        const currentSettings = view.state.field(settingsField);
        // Clean up previous listener
        if (mediaQuery && mediaHandler) {
            mediaQuery.removeEventListener('change', mediaHandler);
            mediaHandler = null;
        }
        if (currentSettings.theme === 'system') {
            mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            mediaHandler = (e: MediaQueryListEvent) => {
                view.dispatch({
                    effects: setThemeEffect.of({ dark: e.matches })
                });
            };
            mediaQuery.addEventListener('change', mediaHandler);
        }
    }

    setupSystemThemeListener();

    themeToggle.addEventListener("click", () => {
        const current = view.state.field(settingsField);
        const next = themeCycle[current.theme];
        view.dispatch({
            effects: [
                updateSettingsEffect.of({ theme: next }),
                setThemeEffect.of({ dark: resolveThemeDark(next) }),
            ]
        });
    });

    toggleContainer.appendChild(themeToggle);
    left.appendChild(toggleContainer);

    // Settings cog button
    const settingsCog = document.createElement("button");
    settingsCog.className = "cm-footer-settings-cog";
    settingsCog.textContent = "\u2699\uFE0F"; // ⚙️

    let overlayEl: HTMLElement | null = null;
    let activeOverlay: 'settings' | 'log' | null = null;

    function closeOverlay() {
        if (logUnsubscribe) {
            logUnsubscribe();
            logUnsubscribe = null;
        }
        if (overlayEl) {
            overlayEl.remove();
            overlayEl = null;
            activeOverlay = null;
        }
    }

    settingsCog.addEventListener("click", () => {
        if (activeOverlay === 'settings') {
            closeOverlay();
        } else {
            closeOverlay();
            overlayEl = createSettingsOverlay(view, closeOverlay);
            activeOverlay = 'settings';
            view.dom.appendChild(overlayEl);
        }
    });

    // LSP log button
    const lspLogBtn = document.createElement("button");
    lspLogBtn.className = "cm-footer-lsp-log";
    lspLogBtn.textContent = "\ueb9d"; // nf-cod-output
    lspLogBtn.title = "LSP Server Log";
    lspLogBtn.style.fontFamily = 'var(--cm-icon-font-family)';
    lspLogBtn.style.display = settings.lspLogEnabled ? '' : 'none';

    let logUnsubscribe: (() => void) | null = null;

    function openLogOverlay() {
        closeOverlay();
        activeOverlay = 'log';

        const el = document.createElement("div");
        el.className = "cm-settings-overlay";

        const header = document.createElement("div");
        header.className = "cm-settings-header";
        header.textContent = "LSP Server Log";
        const headerRight = document.createElement("div");
        headerRight.style.display = "flex";
        headerRight.style.gap = "8px";
        const clearBtn = document.createElement("button");
        clearBtn.className = "cm-settings-close";
        clearBtn.textContent = "Clear";
        clearBtn.addEventListener("click", () => LspLog.clear());
        const closeBtn = document.createElement("button");
        closeBtn.className = "cm-settings-close";
        closeBtn.textContent = "\u2715";
        closeBtn.addEventListener("click", closeOverlay);
        headerRight.appendChild(clearBtn);
        headerRight.appendChild(closeBtn);
        header.appendChild(headerRight);
        el.appendChild(header);

        const logContent = document.createElement("div");
        logContent.className = "cm-lsp-log-content";

        function renderLog() {
            const entries = LspLog.entries();
            logContent.textContent = '';
            if (entries.length === 0) {
                logContent.textContent = 'No log entries.';
                return;
            }
            for (const entry of entries) {
                const line = document.createElement("div");
                line.className = `cm-lsp-log-entry cm-lsp-log-${entry.level}`;
                const ts = new Date(entry.timestamp);
                const time = `${ts.getHours().toString().padStart(2, '0')}:${ts.getMinutes().toString().padStart(2, '0')}:${ts.getSeconds().toString().padStart(2, '0')}`;
                line.textContent = `[${time}] [${entry.level}] ${entry.message}`;
                logContent.appendChild(line);
            }
            logContent.scrollTop = logContent.scrollHeight;
        }

        renderLog();
        logUnsubscribe = LspLog.subscribe(renderLog);

        el.appendChild(logContent);
        overlayEl = el;
        view.dom.appendChild(el);
    }

    lspLogBtn.addEventListener("click", () => {
        if (activeOverlay === 'log') {
            closeOverlay();
        } else {
            openLogOverlay();
        }
    });

    right.appendChild(lspLogBtn);
    right.appendChild(settingsCog);

    dom.appendChild(left);
    dom.appendChild(right);

    return {
        dom,
        top: false,
        update(update) {
            const prev = update.startState.field(settingsField);
            const next = update.state.field(settingsField);
            if (prev !== next) {
                // Update theme toggle icon
                themeToggle.textContent = themeIcons[next.theme];

                // Update system theme listener
                if (prev.theme !== next.theme) {
                    setupSystemThemeListener();
                }

                // Apply font size
                if (prev.fontSize !== next.fontSize) {
                    view.dom.style.setProperty('--cm-font-size', `${next.fontSize}px`);
                }

                // Apply font family
                if (prev.fontFamily !== next.fontFamily) {
                    if (next.fontFamily) {
                        view.dom.style.setProperty('--cm-font-family', next.fontFamily);
                    } else {
                        view.dom.style.removeProperty('--cm-font-family');
                    }
                }

                // Show/hide LSP log button
                if (prev.lspLogEnabled !== next.lspLogEnabled) {
                    lspLogBtn.style.display = next.lspLogEnabled ? '' : 'none';
                    // Close log overlay if logging was disabled
                    if (!next.lspLogEnabled && activeOverlay === 'log') {
                        closeOverlay();
                    }
                }
            }
        },
        destroy() {
            if (logUnsubscribe) logUnsubscribe();
            closeOverlay();
            if (mediaQuery && mediaHandler) {
                mediaQuery.removeEventListener('change', mediaHandler);
            }
        }
    };
};
