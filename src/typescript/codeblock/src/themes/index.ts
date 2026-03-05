import { EditorView } from '@codemirror/view';

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
        fontSize: '16px',
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
        '&.cm-command-result': {
            color: 'var(--cm-command-result-color)'
        },
        '& > .cm-search-result-icon-container': {
            width: 'var(--cm-gutter-width)',

            '& > .cm-search-result-icon': {
                fontSize: '16px',
                textAlign: 'right',
                boxSizing: 'border-box',
                width: 'var(--cm-gutter-lineno-width)',
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
    },
    '.cm-toolbar-state-icon': {
        fontSize: '16px',
        textAlign: 'right',
        boxSizing: 'border-box',
        color: 'var(--cm-foreground)',
        width: 'var(--cm-gutter-lineno-width)',
        fontFamily: 'var(--cm-icon-font-family)',
    },
    '.cm-content': {
        padding: 0,
    },
    '.cm-tooltip': {
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'var(--cm-font-family)',
        boxShadow: '-12px 12px 1px rgba(0,0,0,0.3)',
        fontSize: '1rem',
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
        fontSize: '1rem',
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
        fontSize: '1rem',
        listStyleType: 'none',
        width: '100%',
        maxHeight: '25vh',
        overflowY: 'auto',
    },
    '.cm-gutters': {
        borderRight: 'none',
    },
    '.cm-panels-top': {
        borderBottom: 'none'
    },
    '.cm-loading': {
        animation: 'cm-pulse 1.2s ease-in-out infinite',
    },
    '@keyframes cm-pulse': {
        '0%, 100%': { opacity: '1' },
        '50%': { opacity: '0.4' },
    },
    // Footer panel
    '.cm-footer-panel': {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--cm-toolbar-background)',
        color: 'var(--cm-toolbar-color)',
        height: '22px',
        padding: '0 4px',
        fontSize: '12px',
        fontFamily: 'var(--cm-font-family)',
    },
    '.cm-footer-left, .cm-footer-right': {
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
    },
    '.cm-footer-toggle-container': {
        width: 'var(--cm-gutter-width)',
    },
    '.cm-footer-theme-toggle': {
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        padding: 0,
        fontSize: '14px',
        lineHeight: '22px',
        textAlign: 'right',
        boxSizing: 'border-box',
        width: 'var(--cm-gutter-lineno-width)',
        display: 'block',
    },
    '.cm-footer-settings-cog, .cm-footer-lsp-log': {
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        padding: '0 4px',
        fontSize: '14px',
        lineHeight: '22px',
    },
    '.cm-panels-bottom': {
        borderTop: 'none',
    },
    // Settings overlay — full editor cover
    '.cm-settings-overlay': {
        position: 'absolute',
        inset: 0,
        overflowY: 'auto',
        background: 'var(--cm-toolbar-background)',
        color: 'var(--cm-toolbar-color)',
        zIndex: 100,
        fontFamily: 'var(--cm-font-family)',
        fontSize: '13px',
    },
    '.cm-settings-header': {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '8px 12px',
        fontWeight: 'bold',
        borderBottom: '1px solid var(--cm-tooltip-border)',
    },
    '.cm-settings-close': {
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '14px',
    },
    '.cm-settings-section': {
        padding: '8px 12px',
    },
    '.cm-settings-section-title': {
        fontWeight: 'bold',
        marginBottom: '6px',
        fontSize: '12px',
        textTransform: 'uppercase',
        opacity: '0.7',
    },
    '.cm-settings-row': {
        display: 'flex',
        justifyContent: 'space-between',
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
    '.cm-settings-value': {
        minWidth: '36px',
        textAlign: 'right',
        fontSize: '12px',
    },
    '.cm-settings-select': {
        background: 'var(--cm-background)',
        color: 'inherit',
        border: '1px solid var(--cm-tooltip-border)',
        borderRadius: '2px',
        padding: '2px 4px',
        fontSize: '12px',
        fontFamily: 'var(--cm-font-family)',
    },
    '.cm-settings-radio-group': {
        display: 'flex',
        gap: '4px',
        alignItems: 'center',
        fontSize: '12px',
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
        fontSize: '12px',
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
        fontSize: '12px',
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
        fontSize: '12px',
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
});
