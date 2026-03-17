import { EditorView } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import { setThemeEffect, lineWrappingCompartment } from "../editor";

export interface EditorSettings {
    theme: 'light' | 'dark' | 'system';
    fontSize: number;
    fontFamily: string;
    autosave: boolean;
    lineWrap: boolean;
    lspLogEnabled: boolean;
    agentUrl: string;
    terminalEnabled: boolean;
    maxVisibleLines: number; // 0 = unlimited
}

const defaultSettings: EditorSettings = {
    theme: 'system',
    fontSize: 16,
    fontFamily: '',
    autosave: true,
    lineWrap: false,
    lspLogEnabled: false,
    agentUrl: '',
    terminalEnabled: false,
    maxVisibleLines: 0,
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

export function resolveThemeDark(theme: EditorSettings['theme']): boolean {
    if (theme === 'system') {
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return theme === 'dark';
}

const themeIcons: Record<EditorSettings['theme'], string> = {
    light: '☀️',
    dark: '🌙',
    system: '🌓',
};

// Settings overlay component (no header — toolbar shows "settings.json" and cog becomes ✕)
export function createSettingsOverlay(view: EditorView): HTMLElement {
    const settings = view.state.field(settingsField);

    const overlay = document.createElement("div");
    overlay.className = "cm-settings-overlay";

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
    const fontSizeRange = document.createElement("input");
    fontSizeRange.type = "range";
    fontSizeRange.className = "cm-settings-font-size-range";
    fontSizeRange.min = "8";
    fontSizeRange.max = "48";
    fontSizeRange.step = "1";
    fontSizeRange.value = String(settings.fontSize);
    const fontSizeInput = document.createElement("input");
    fontSizeInput.type = "number";
    fontSizeInput.className = "cm-settings-font-size-input";
    fontSizeInput.min = "1";
    fontSizeInput.max = "128";
    fontSizeInput.value = String(settings.fontSize);
    const fontSizePx = document.createElement("span");
    fontSizePx.textContent = "px";
    // Use 'change' on the range (fires on mouseup) to avoid feedback loop:
    // dragging changes font size → overlay relayouts → slider thumb shifts
    // relative to pointer → triggers another input event → runaway resizing.
    fontSizeRange.addEventListener("change", () => {
        const size = Number(fontSizeRange.value);
        fontSizeInput.value = String(size);
        view.dispatch({ effects: updateSettingsEffect.of({ fontSize: size }) });
    });
    fontSizeInput.addEventListener("input", () => {
        let size = Number(fontSizeInput.value);
        if (isNaN(size) || size < 1) return;
        size = Math.min(128, size);
        fontSizeRange.value = String(size);
        view.dispatch({ effects: updateSettingsEffect.of({ fontSize: size }) });
    });
    fontSizeControl.appendChild(fontSizeRange);
    fontSizeControl.appendChild(fontSizeInput);
    fontSizeControl.appendChild(fontSizePx);
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

    // Color theme radio — with emoji icons
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
        radioLabel.textContent = themeIcons[t];
        radioLabel.title = t.charAt(0).toUpperCase() + t.slice(1);
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

    // Line wrap toggle
    const lineWrapRow = document.createElement("div");
    lineWrapRow.className = "cm-settings-row";
    const lineWrapLabel = document.createElement("label");
    lineWrapLabel.textContent = "Line wrap";
    lineWrapLabel.htmlFor = "cm-line-wrap";
    const lineWrapCheckbox = document.createElement("input");
    lineWrapCheckbox.type = "checkbox";
    lineWrapCheckbox.id = "cm-line-wrap";
    lineWrapCheckbox.checked = settings.lineWrap;
    lineWrapCheckbox.addEventListener("change", () => {
        view.dispatch({
            effects: [
                updateSettingsEffect.of({ lineWrap: lineWrapCheckbox.checked }),
                lineWrappingCompartment.reconfigure(lineWrapCheckbox.checked ? EditorView.lineWrapping : []),
            ]
        });
    });
    lineWrapRow.appendChild(lineWrapLabel);
    lineWrapRow.appendChild(lineWrapCheckbox);
    editorSection.appendChild(lineWrapRow);

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
