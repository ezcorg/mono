import { EditorView } from '@codemirror/view';

export const codeblockTheme = EditorView.theme({
    '.cm-toolbar-input': {
        fontFamily: 'monospace',
        lineHeight: 1.4,
        border: 'none',
        background: 'transparent',
        outline: 'none',
        fontSize: '16px',
        color: 'white',
        padding: '0 30px 0 15px',
        width: '100%',
        flex: 1
    },
    '.cm-toolbar-input-container': {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        flex: 1
    },
    '.cm-toolbar-panel': {
        padding: '0',
        background: '#2a2a2f',
        display: 'flex',
        alignItems: 'center'
    },
    '.cm-content': {
        padding: 0
    },
    '.cm-tooltip': {
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'monospace',
        boxShadow: '-12px 12px 1px #0000004f',
        fontSize: '1rem',
        maxWidth: 'min(calc(100% - 2rem), 62ch)',
        border: '2px solid black',
        overflow: 'auto',
    },
    '.cm-tooltip a': {
        color: '#569cd6',
    },
    '.cm-tooltip-section': {
        // margin: '0.25rem 0.25rem'
    },
    '.cm-tooltip-lint': {
        order: -1,
    },
    '.cm-diagnostic': {
        padding: '3px 6px',
        whiteSpace: 'pre-wrap',
        marginLeft: 0,
        borderLeft: 'none'
    },
    '.cm-diagnostic-info': {
        backgroundColor: '#ffffff',
        color: 'black'
    },
    '.cm-diagnostic-error': {
        borderLeft: 'none',
        backgroundColor: '#d11',
    },
    '.cm-diagnosticSource': {
        display: 'none'
    },
    '.documentation': {
        padding: '2px'
    },
    '.documentation > * ': {
        margin: 0,
        padding: '0.25rem 6px',
        fontSize: '1rem',
        whiteSpace: 'pre-wrap',
    },
    '.documentation > p > code': {
        backgroundColor: '#00000052',
        padding: '2px 4px',
        margin: '2px 0',
        display: 'inline-block',
    },
    '.cm-diagnosticAction': {
        display: 'none'
    },
    '.cm-search-results': {
        position: 'absolute',
        top: '100%',
        margin: 0,
        padding: 0,
        background: '#2a2a2f',
        fontFamily: 'monospace',
        fontSize: '1rem',
        listStyleType: 'none',
        width: '100%',
        maxHeight: '25vh',
        overflowY: 'auto'
    },
    '.cm-search-result': {
        padding: '0px 0px 2px 14px',
        cursor: 'pointer',
    },
    '.cm-search-result:hover': {
        backgroundColor: '#569cd6c9',
    },
    '.cm-search-result.selected': {
        backgroundColor: '#569cd6'
    },
})