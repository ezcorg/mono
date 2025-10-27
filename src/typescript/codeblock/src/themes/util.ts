import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { HighlightStyle, type TagStyle, syntaxHighlighting } from "@codemirror/language";
import type { StyleSpec } from "style-mod";

export interface CreateThemeOptions {
    theme: "light" | "dark";
    settings: Settings;
    styles: TagStyle[];
}

export interface Settings {
    background?: string;
    backgroundImage?: string;
    foreground?: string;
    caret?: string;
    selection?: string;
    selectionMatch?: string;
    lineHighlight?: string;
    gutterBackground?: string;
    gutterForeground?: string;
    gutterActiveForeground?: string;
    gutterBorder?: string;
    fontFamily?: string;
    fontSize?: StyleSpec["fontSize"];
}

export function createTheme({
    theme,
    settings = {},
    styles = [],
}: CreateThemeOptions): Extension {
    const themeOptions: Record<string, StyleSpec> = {
        ".cm-gutters": {},
    };

    const baseStyle: StyleSpec = {};
    if (settings.background) baseStyle.backgroundColor = settings.background;
    if (settings.backgroundImage) baseStyle.backgroundImage = settings.backgroundImage;
    if (settings.foreground) baseStyle.color = settings.foreground;
    if (settings.fontSize) baseStyle.fontSize = settings.fontSize;

    if (Object.keys(baseStyle).length > 0) {
        themeOptions["&"] = baseStyle;
    }

    if (settings.fontFamily) {
        themeOptions["&.cm-editor .cm-scroller"] = {
            fontFamily: settings.fontFamily,
        };
    }

    if (settings.gutterBackground) {
        themeOptions[".cm-gutters"].backgroundColor = settings.gutterBackground;
    }
    if (settings.gutterForeground) {
        themeOptions[".cm-gutters"].color = settings.gutterForeground;
    }
    if (settings.gutterBorder) {
        themeOptions[".cm-gutters"].borderRightColor = settings.gutterBorder;
    }

    if (settings.caret) {
        themeOptions[".cm-content"] = { caretColor: settings.caret };
        themeOptions[".cm-cursor, .cm-dropCursor"] = {
            borderLeftColor: settings.caret,
        };
    }

    const activeLineGutterStyle: StyleSpec = {};
    if (settings.gutterActiveForeground) {
        activeLineGutterStyle.color = settings.gutterActiveForeground;
    }
    if (settings.lineHighlight) {
        themeOptions[".cm-activeLine"] = {
            backgroundColor: settings.lineHighlight,
        };
        activeLineGutterStyle.backgroundColor = settings.lineHighlight;
    }
    themeOptions[".cm-activeLineGutter"] = activeLineGutterStyle;

    if (settings.selection) {
        themeOptions[
            "&.cm-focused .cm-selectionBackground, & .cm-line::selection, & .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection"
        ] = { background: `${settings.selection} !important` };
    }
    if (settings.selectionMatch) {
        themeOptions["& .cm-selectionMatch"] = {
            backgroundColor: settings.selectionMatch,
        };
    }
    const themeExtension = EditorView.theme(themeOptions, {
        dark: theme === "dark",
    });
    const highlightStyle = HighlightStyle.define(styles);

    return [themeExtension, syntaxHighlighting(highlightStyle)];
}
