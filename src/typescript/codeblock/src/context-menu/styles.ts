import { StyleModule } from "style-mod";

const FS = 'var(--cm-font-size, 14px)';

// The menu's frame — surface, text colour, border, corners, inset, shadow
// and the rows' shape — reads `--cm-menu-*` first, so a host that embeds
// the editor (markdown-editor) can frame the menu like its own menus; the
// fallbacks are the codeblock's own look. menu.ts copies these from the
// editor element onto the menu, which lives on <body>.
export const contextMenuStyles = new StyleModule({
    '.cm-context-menu': {
        position: 'fixed',
        zIndex: '300',
        background: 'var(--cm-menu-background, var(--cm-toolbar-background))',
        color: 'var(--cm-menu-color, var(--cm-search-result-color))',
        border: 'var(--cm-menu-border, 2px solid var(--cm-tooltip-border))',
        borderRadius: 'var(--cm-menu-radius, 0)',
        padding: 'var(--cm-menu-padding, 0)',
        fontFamily: 'var(--cm-font-family)',
        fontSize: FS,
        boxShadow: 'var(--cm-menu-shadow, 0 4px 16px rgba(0, 0, 0, 0.18), 0 1px 4px rgba(0, 0, 0, 0.1))',
        minWidth: '180px',
        // Grow to fit the widest item (e.g. a long "Shift+Alt+F" shortcut)
        // instead of capping at a fixed width and letting it spill past the
        // border. Only when the menu would run off the viewport does it cap
        // there and expose a scrollbar (`overflow: auto`); the off-screen
        // positioning in menu.ts already clamps it back on-screen.
        maxWidth: 'calc(100vw - 8px)',
        maxHeight: 'calc(100vh - 8px)',
        overflow: 'auto',
        outline: 'none',
    },
    '.cm-context-menu-item': {
        display: 'flex',
        alignItems: 'center',
        padding: 'var(--cm-menu-item-padding, 0 6px)',
        borderRadius: 'var(--cm-menu-item-radius, 0)',
        cursor: 'pointer',
        gap: '6px',
        lineHeight: '1.4',
        whiteSpace: 'nowrap',
        // Keep each row at its natural width so the menu sizes to the widest
        // row (and, once the menu hits the viewport cap, the rows overflow
        // into the horizontal scroll rather than squashing label vs shortcut).
        minWidth: 'max-content',
        userSelect: 'none',
        // macOS-style single highlight: only the `.selected` row is coloured.
        // There's no `&:hover` rule — pointing at a row sets it as selected
        // (see menu.ts's `mouseenter` → updateSelection), so the pointer and
        // keyboard share one highlight instead of lighting up two rows.
        '&.selected': {
            '& span': { color: 'var(--cm-search-result-color-selected)' },
            backgroundColor: 'var(--cm-search-result-select-bg)',
        },
        '&.disabled': {
            opacity: '0.4',
            cursor: 'default',
            '&.selected': {
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
        flex: 1,
    },
    '.cm-context-menu-shortcut': {
        marginLeft: '2em',
        opacity: '0.5',
        fontSize: '0.9em',
        flexShrink: '0',
    },
    '.cm-context-menu-divider': {
        height: '1px',
        background: 'var(--cm-menu-divider, var(--cm-tooltip-border))',
        margin: 'var(--cm-menu-divider-margin, 2px 0)',
        opacity: 'var(--cm-menu-divider-opacity, 0.3)',
    },
    // While a context menu is open, hide hover tooltips anywhere in the
    // document. The `cm-context-menu-open` class lives on <html> (see
    // menu.ts), so this matches LSP/diagnostic hovers wherever CodeMirror
    // parents them — inside `.cm-editor` or reparented out to a fixed/sticky
    // ancestor — which an editor-scoped rule couldn't reach. `!important`
    // beats the codeblock theme's `.cm-tooltip { display: flex }`.
    'html.cm-context-menu-open .cm-tooltip-hover': {
        display: 'none !important',
    },
});

let mounted = false;
export function mountContextMenuStyles() {
    if (mounted) return;
    mounted = true;
    StyleModule.mount(document, contextMenuStyles);
}
