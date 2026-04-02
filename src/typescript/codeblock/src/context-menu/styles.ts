import { StyleModule } from "style-mod";

const FS = 'var(--cm-font-size, 14px)';

export const contextMenuStyles = new StyleModule({
    '.cm-context-menu': {
        position: 'fixed',
        zIndex: '300',
        background: 'var(--cm-toolbar-background)',
        color: 'var(--cm-search-result-color)',
        border: '2px solid var(--cm-tooltip-border)',
        borderRadius: '0',
        padding: '0',
        fontFamily: 'var(--cm-font-family)',
        fontSize: FS,
        boxShadow: '-12px 12px 0px rgba(0,0,0,0.3)',
        minWidth: '180px',
        maxWidth: '340px',
        outline: 'none',
    },
    '.cm-context-menu-item': {
        display: 'flex',
        alignItems: 'center',
        padding: '0 6px',
        cursor: 'pointer',
        gap: '6px',
        lineHeight: '1.4',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        '&:hover': {
            '& span': { color: 'var(--cm-search-result-color-hover)' },
            backgroundColor: 'var(--cm-search-result-bg-hover)',
        },
        '&.selected': {
            '& span': { color: 'var(--cm-search-result-color-selected)' },
            backgroundColor: 'var(--cm-search-result-select-bg)',
        },
        '&.disabled': {
            opacity: '0.4',
            cursor: 'default',
            '&:hover, &.selected': {
                backgroundColor: 'transparent',
                '& span': { color: 'inherit' },
            },
        },
    },
    '.cm-context-menu-icon': {
        width: '1.2em',
        textAlign: 'center',
        flexShrink: '0',
        fontFamily: 'system-ui, sans-serif',
    },
    '.cm-context-menu-label': {
        flex: '1',
    },
    '.cm-context-menu-shortcut': {
        marginLeft: '2em',
        opacity: '0.5',
        fontSize: '0.9em',
        flexShrink: '0',
    },
    '.cm-context-menu-divider': {
        height: '1px',
        background: 'var(--cm-tooltip-border)',
        margin: '2px 0',
        opacity: '0.3',
    },
});

let mounted = false;
export function mountContextMenuStyles() {
    if (mounted) return;
    mounted = true;
    StyleModule.mount(document, contextMenuStyles);
}
