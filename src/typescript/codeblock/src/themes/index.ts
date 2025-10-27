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
                padding: '0 3px 0 5px',
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
        padding: '0 3px 0 5px',
        color: 'var(--cm-foreground)',
        width: 'var(--cm-gutter-lineno-width)'
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
    }
});
