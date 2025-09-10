import { tags as t } from "@lezer/highlight";
import { createTheme, type CreateThemeOptions } from "./util";
import { StyleModule } from "style-mod";

export const variableSettings: CreateThemeOptions["settings"] = {
    background: "var(--cm-background)",
    foreground: "var(--cm-foreground)",
    caret: "var(--cm-caret)",
    selection: "var(--cm-selection)",
    selectionMatch: "var(--cm-selection-match)",
    lineHighlight: "var(--cm-line-highlight)",
    gutterBackground: "var(--cm-gutter-background)",
    gutterForeground: "var(--cm-gutter-foreground)",
    gutterActiveForeground: "var(--cm-gutter-active-foreground)",
    fontFamily: "var(--cm-font-family)",
};

export const variableStyles: CreateThemeOptions["styles"] = [
    {
        tag: [
            t.keyword,
            t.operatorKeyword,
            t.modifier,
            t.color,
            t.constant(t.name),
            t.standard(t.name),
            t.standard(t.tagName),
            t.special(t.brace),
            t.atom,
            t.bool,
            t.special(t.variableName),
        ],
        color: "var(--cm-keyword)",
    },
    { tag: [t.controlKeyword, t.moduleKeyword], color: "var(--cm-control)" },
    {
        tag: [
            t.name,
            t.deleted,
            t.character,
            t.macroName,
            t.propertyName,
            t.variableName,
            t.labelName,
            t.definition(t.name),
        ],
        color: "var(--cm-name)",
    },
    { tag: t.heading, fontWeight: "bold", color: "var(--cm-heading)" },
    {
        tag: [
            t.typeName,
            t.className,
            t.tagName,
            t.number,
            t.changed,
            t.annotation,
            t.self,
            t.namespace,
        ],
        color: "var(--cm-type)",
    },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--cm-function)" },
    { tag: [t.number], color: "var(--cm-number)" },
    {
        tag: [t.operator, t.punctuation, t.separator, t.url, t.escape, t.regexp],
        color: "var(--cm-operator)",
    },
    { tag: [t.regexp], color: "var(--cm-regexp)" },
    {
        tag: [t.special(t.string), t.processingInstruction, t.string, t.inserted],
        color: "var(--cm-string)",
    },
    { tag: [t.angleBracket], color: "var(--cm-angle-bracket)" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.meta, t.comment], color: "var(--cm-comment)" },
    { tag: t.link, color: "var(--cm-link)", textDecoration: "underline" },
    { tag: t.invalid, color: "var(--cm-invalid)" },
];

function vscodeLightDarkTheme(options?: Partial<CreateThemeOptions>) {
    const { theme = "light", settings = {}, styles = [] } = options || {};
    return createTheme({
        theme,
        settings: {
            ...variableSettings,
            ...settings,
        },
        styles: [...variableStyles, ...styles],
    });
}

export const vscodeLightDark = vscodeLightDarkTheme();
export const vscodeStyleMod = new StyleModule({
    ":root": {
        /* Shared */
        "--cm-font-family":
            'Menlo, Monaco, Consolas, "Andale Mono", "Ubuntu Mono", "Courier New", monospace',

        /* Defaults to light theme */
        "--cm-background": "#ffffff",
        "--cm-foreground": "#383a42",
        "--cm-caret": "#000000",
        "--cm-selection": "#add6ff",
        "--cm-selection-match": "#a8ac94",
        "--cm-line-highlight": "#99999926",
        "--cm-gutter-background": "#ffffff",
        "--cm-gutter-foreground": "#237893",
        "--cm-gutter-active-foreground": "#0b216f",

        /* Syntax colors */
        "--cm-keyword": "#0000ff",
        "--cm-control": "#af00db",
        "--cm-name": "#0070c1",
        "--cm-heading": "#0070c1",
        "--cm-type": "#267f99",
        "--cm-function": "#795e26",
        "--cm-number": "#098658",
        "--cm-operator": "#383a42",
        "--cm-regexp": "#af00db",
        "--cm-string": "#a31515",
        "--cm-angle-bracket": "#383a42",
        "--cm-comment": "#008000",
        "--cm-link": "#4078f2",
        "--cm-invalid": "#e45649",

        /* Additional UI colors */
        "--cm-search-result-color-hover": "var(--cm-background)",
        "--cm-search-result-select-bg": "#569cd6",

        "--cm-toolbar-color": "#000000",
        "--cm-toolbar-background": "#f3f3f3",
        "--cm-toolbar-foreground": "var(--cm-foreground)",

        "--cm-tooltip-color": "var(--cm-foreground)",
        "--cm-tooltip-background": "#ffffff",
        "--cm-tooltip-border": "#000000",

        "--cm-diagnostic-info-color": "white",
        "--cm-diagnostic-info-bg": "#545454",
        "--cm-diagnostic-error-color": "white",
        "--cm-diagnostic-error-bg": "#e45649",
        "--cm-comment-bg": "rgba(0,0,0,0.1)",
    },

    /* Dark-mode override */
    "@media (prefers-color-scheme: dark)": {
        ":root": {
            "--cm-background": "#1e1e1e",
            "--cm-foreground": "#9cdcfe",
            "--cm-caret": "#c6c6c6",
            "--cm-selection": "#6199ff2f",
            "--cm-selection-match": "#72a1ff59",
            "--cm-line-highlight": "#ffffff0f",
            "--cm-gutter-background": "#1e1e1e",
            "--cm-gutter-foreground": "#838383",
            "--cm-gutter-active-foreground": "#ffffff",

            "--cm-keyword": "#569cd6",
            "--cm-control": "#c586c0",
            "--cm-name": "#9cdcfe",
            "--cm-heading": "#9cdcfe",
            "--cm-type": "#4ec9b0",
            "--cm-function": "#dcdcaa",
            "--cm-number": "#b5cea8",
            "--cm-operator": "#d4d4d4",
            "--cm-regexp": "#d16969",
            "--cm-string": "#ce9178",
            "--cm-angle-bracket": "#808080",
            "--cm-comment": "#6a9955",
            "--cm-link": "#4078f2",
            "--cm-invalid": "#ff0000",

            "--cm-search-result-color-hover": "var(--cm-search-result-color)",
            "--cm-search-result-color": "var(--cm-toolbar-foreground)",

            "--cm-toolbar-color": "#ffffff",
            "--cm-toolbar-background": "#2a2a2f",
            "--cm-toolbar-foreground": "#ffffff",
            "--cm-tooltip-color": "var(--cm-gutter-active-foreground)",
            "--cm-tooltip-background": "var(--cm-toolbar-background)",
            "--cm-tooltip-border": "#000000",
            "--cm-diagnostic-error-bg": "#d11",
            "--cm-comment-bg": "rgba(0,0,0,0.32)",
        }
    }
});