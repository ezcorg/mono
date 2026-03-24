import { EditorView } from '@codemirror/view';

// Font size helpers — all relative to --cm-font-size so changing the
// base font size in settings automatically scales the entire UI.
const FS = 'var(--cm-font-size, 16px)';
const FS_75 = `calc(${FS} * 0.75)`;   // 12px at base 16
const FS_85 = `calc(${FS} * 0.85)`;   // ~14px at base 16
const FS_875 = `calc(${FS} * 0.875)`; // 14px at base 16

export const codeblockTheme = EditorView.theme({
    "&:not(.cm-focused)": {
        '& .cm-activeLine, & .cm-activeLineGutter': {
            color: 'inherit',
            backgroundColor: "transparent"
        }
    },
    '.cm-toolbar-input': {
        fontFamily: 'var(--cm-font-family)',
        lineHeight: 1.4,
        border: 'none',
        background: 'transparent',
        outline: 'none',
        fontSize: FS,
        color: 'var(--cm-toolbar-color)',
        padding: '0 2px 0 6px',
        width: '100%',
        flex: 1,
    },
    '.cm-toolbar-input-container': {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        flex: 1,
    },
    '.cm-toolbar-panel': {
        padding: 0,
        background: 'var(--cm-toolbar-background)',
        display: 'flex',
        alignItems: 'center',
    },
    '.cm-command-result > span': {
        color: 'var(--cm-command-result-color)'
    },
    '.cm-search-result': {
        color: 'var(--cm-search-result-color)',
        display: 'flex',
        cursor: 'pointer',
        lineHeight: 1.4,
        '&.cm-command-result': {
            color: 'var(--cm-command-result-color)'
        },
        '& > .cm-search-result-icon-container': {
            width: 'var(--cm-gutter-width)',
            minWidth: 'var(--cm-icon-col-width, 2ch)',

            '& > .cm-search-result-icon': {
                fontSize: FS,
                textAlign: 'right',
                paddingRight: 'calc(1ch + 3px)',
                boxSizing: 'border-box',
                width: 'var(--cm-gutter-lineno-width)',
                minWidth: 'var(--cm-icon-col-width, 2ch)',
            }
        },
        '&:hover': {
            '& div': {
                color: 'var(--cm-search-result-color-hover)',
            },
            backgroundColor: 'var(--cm-search-result-bg-hover)',
        },
        '&.selected': {
            '& div': {
                color: 'var(--cm-search-result-color-selected)',
            },
            backgroundColor: 'var(--cm-search-result-select-bg)',
        },
        '& > .cm-search-result-label': {
            flex: 1,
            padding: '0 2px 0 6px',
        },
    },
    '.cm-toolbar-state-icon-container': {
        width: 'var(--cm-gutter-width)',
        minWidth: 'var(--cm-icon-col-width, 2ch)',
        display: 'flex',
    },
    // Icon right-aligned to match CM's right-aligned line numbers.
    // padding-right: 3px matches CM's .cm-gutterElement right padding.
    '.cm-toolbar-state-icon': {
        fontSize: FS,
        color: 'var(--cm-foreground)',
        fontFamily: 'var(--cm-icon-font-family)',
        paddingRight: 'calc(1ch + 3px)',
        textAlign: 'right',
        boxSizing: 'border-box',
        width: 'var(--cm-gutter-lineno-width)',
        minWidth: 'var(--cm-icon-col-width, 2ch)',
        transition: 'opacity 0.15s ease',
    },
    '&': {
        fontSize: FS,
    },
    '.cm-content': {
        padding: 0,
    },
    '.cm-tooltip': {
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--cm-font-family)',
        boxShadow: '-12px 12px 1px rgba(0,0,0,0.3)',
        fontSize: FS,
        maxWidth: 'min(calc(100% - 2rem), 62ch)',
        border: '2px solid var(--cm-tooltip-border)',
        overflow: 'auto',
        background: 'var(--cm-tooltip-background)',
        color: 'var(--cm-tooltip-color)',
    },
    '.cm-tooltip a': {
        color: 'var(--cm-link)',
    },
    '.cm-tooltip-section:not(:first-child)': {
        borderTop: 'none',
    },
    '.cm-tooltip-lint': {
        order: -1,
    },
    '.cm-diagnostic': {
        padding: '3px 6px',
        whiteSpace: 'pre-wrap',
        marginLeft: 0,
        borderLeft: 'none',
    },
    '.cm-diagnostic-info': {
        backgroundColor: 'var(--cm-diagnostic-info-bg)',
        color: 'var(--cm-diagnostic-info-color)',
    },
    '.cm-diagnostic-error': {
        borderLeft: 'none',
        backgroundColor: 'var(--cm-diagnostic-error-bg)',
        color: 'var(--cm-diagnostic-error-color)',
    },
    '.cm-diagnosticSource': {
        display: 'none',
    },
    '.documentation': {
        padding: '2px',
    },
    '.documentation > *': {
        margin: 0,
        padding: '0.25rem 6px',
        fontSize: FS,
    },
    '.documentation > p > code': {
        backgroundColor: 'var(--cm-comment-bg)',
        padding: '2px 4px',
        margin: '2px 0',
        display: 'inline-block',
    },
    '.documentation > pre > code': {
        whiteSpace: 'break-spaces',
    },
    '.cm-diagnosticAction': {
        display: 'none',
    },
    '.cm-diagnosticText div': {
        display: 'flex',
        height: 'fit-content',
    },
    '.cm-diagnosticText p': {
        margin: 0,
    },
    '.cm-search-results': {
        position: 'absolute',
        top: '100%',
        margin: 0,
        padding: 0,
        background: 'var(--cm-toolbar-background)',
        fontFamily: 'var(--cm-font-family)',
        fontSize: FS,
        listStyleType: 'none',
        width: '100%',
        maxHeight: `calc(${FS} * 1.4 * 10)`,
        overflowY: 'auto',
        zIndex: 200,
    },
    '.cm-gutters': {
        borderRight: 'none',
    },
    '.cm-panels-top': {
        borderBottom: 'none',
        zIndex: 301,
    },
    // CSS border spinner for file loading indicator.
    // Rendered as a separate element inside .cm-toolbar-state-icon-container,
    // so it has fixed dimensions and doesn't inherit gutter-width sizing.
    '.cm-loading': {
        display: 'inline-block',
        width: FS,
        height: FS,
        border: '2px solid var(--cm-foreground, currentColor)',
        borderTopColor: 'transparent',
        borderRadius: '50%',
        boxSizing: 'border-box',
        animation: 'cm-spin 0.8s linear infinite',
        transition: 'opacity 0.15s ease-out',
        margin: 'auto',
    },
    '@keyframes cm-spin': {
        '0%': { transform: 'rotate(0deg)' },
        '100%': { transform: 'rotate(360deg)' },
    },
    // LSP log button in toolbar (far right)
    '.cm-toolbar-lsp-log': {
        border: 'none',
        background: 'transparent',
        color: 'var(--cm-toolbar-color)',
        cursor: 'pointer',
        padding: '0 6px',
        fontSize: FS_875,
        lineHeight: 'inherit',
        flexShrink: '0',
    },
    // Settings / log overlay — anchored at top, grows downward
    '.cm-settings-overlay': {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        overflowY: 'auto',
        background: 'var(--cm-background)',
        color: 'var(--cm-toolbar-color)',
        zIndex: 1000,
        fontFamily: 'var(--cm-font-family)',
        fontSize: FS,
    },
    '.cm-settings-section': {
        padding: '8px 6px',
    },
    '.cm-settings-section-title': {
        fontWeight: 'bold',
        marginBottom: '6px',
        fontSize: FS_85,
        opacity: '0.7',
    },
    '.cm-settings-row': {
        display: 'flex',
        alignItems: 'center',
        marginBottom: '6px',
        gap: '8px',
    },
    '.cm-settings-row > label': {
        flex: '0 0 auto',
        whiteSpace: 'nowrap',
    },
    '.cm-settings-control': {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
    },
    // Fixed pixel width so font-size changes don't relayout the slider
    '.cm-settings-font-size-range': {
        width: '120px',
        flexShrink: '0',
    },
    '.cm-settings-font-size-input': {
        background: 'var(--cm-background)',
        color: 'inherit',
        border: '1px solid var(--cm-tooltip-border)',
        borderRadius: '2px',
        padding: '2px 4px',
        fontSize: 'inherit',
        fontFamily: 'var(--cm-font-family)',
        width: '3em',
        textAlign: 'right',
    },
    '.cm-settings-select': {
        background: 'var(--cm-background)',
        color: 'inherit',
        border: '1px solid var(--cm-tooltip-border)',
        borderRadius: '2px',
        padding: '2px 4px',
        fontSize: 'inherit',
        fontFamily: 'var(--cm-font-family)',
    },
    '.cm-settings-radio-group': {
        display: 'flex',
        gap: '4px',
        alignItems: 'center',
    },
    '.cm-settings-radio-group label': {
        marginRight: '6px',
    },
    '.cm-settings-input': {
        background: 'var(--cm-background)',
        color: 'inherit',
        border: '1px solid var(--cm-tooltip-border)',
        borderRadius: '2px',
        padding: '2px 6px',
        fontSize: 'inherit',
        fontFamily: 'var(--cm-font-family)',
        flex: 1,
        minWidth: 0,
    },
    '.cm-settings-button': {
        background: 'var(--cm-background)',
        color: 'inherit',
        border: '1px solid var(--cm-tooltip-border)',
        borderRadius: '2px',
        padding: '4px 8px',
        fontSize: 'inherit',
        cursor: 'pointer',
    },
    '.cm-settings-button-disabled': {
        opacity: '0.5',
        cursor: 'not-allowed',
    },
    // LSP log content
    '.cm-lsp-log-content': {
        padding: '8px 12px',
        fontFamily: 'var(--cm-font-family)',
        fontSize: FS_75,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        overflowY: 'auto',
        flex: 1,
    },
    '.cm-lsp-log-entry': {
        padding: '1px 0',
    },
    '.cm-lsp-log-error': {
        color: 'var(--cm-diagnostic-error-bg)',
    },
    '.cm-lsp-log-warn': {
        color: '#e5a100',
    },
    '.cm-lsp-log-info': {
        opacity: '0.8',
    },
    '.cm-lsp-log-log': {
        opacity: '0.6',
    },
    // Terminal panel — fills available space when editor scroller is hidden
    '.cm-terminal-panel': {
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: '80px',
    },
    '.cm-terminal-container': {
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
    },
    // Ghostty creates a textarea for keyboard input capture.
    // Hide it so its native caret doesn't flash at the top-left
    // independently of the terminal's own cursor rendering.
    '.cm-terminal-container textarea': {
        opacity: '0',
        caretColor: 'transparent',
    },
    // When terminal is active, the editor scroller is hidden and
    // the bottom panel grows to fill the remaining space.
    '&.cm-terminal-active > .cm-panels-bottom': {
        flex: '1',
        display: 'flex',
        flexDirection: 'column',
    },
    // Auto-hide toolbar: JS manages retract/expand by toggling
    // .cm-toolbar-retracted on .cm-panels-top (see toolbar.ts).
    // The transition makes expand/retract feel smooth.
    '& .cm-panels-top.cm-toolbar-retracted': {
        maxHeight: '0px',
        overflow: 'hidden',
        transition: 'max-height 0.15s ease-out',
    },
});
