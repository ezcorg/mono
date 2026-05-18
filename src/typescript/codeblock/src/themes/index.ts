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
    // Sized to `--cm-gutter-lineno-width` (NOT `--cm-gutter-width`) so
    // the container's right edge lines up with the right edge of
    // `.cm-lineNumbers` in the rows below. When a fold gutter is also
    // present, `--cm-gutter-width` is wider than `--cm-gutter-lineno-width`
    // by the fold gutter's width; using lineno-width here keeps the
    // toolbar's state-icon column and the gutter's line-number column
    // visually as one vertical strip. Tests enforce this alignment in
    // `markdown-editor/src/test/layout.test.ts`.
    '.cm-toolbar-state-icon-container': {
        width: 'var(--cm-gutter-lineno-width)',
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
        boxShadow: '-12px 12px 0px rgba(0,0,0,0.3)',
        fontSize: FS,
        maxWidth: 'min(100vw - 2rem, 80ch)',
        border: '2px solid var(--cm-tooltip-border)',
        overflow: 'auto',
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
        background: 'var(--cm-tooltip-background)',
        color: 'var(--cm-tooltip-color)',
    },
    // The autocomplete dropdown must allow overflow so the completion
    // info panel (detail/docs) can render beside it without clipping.
    '.cm-tooltip-autocomplete': {
        overflow: 'visible',
    },
    // CM6's default completion icons use Unicode glyphs that need a
    // system font — the monospace code font may not render them.
    '.cm-completionIcon': {
        fontFamily: 'system-ui, sans-serif',
    },
    // The default □ (U+25A1) doesn't render in many fonts — use ◆ instead.
    '.cm-completionIcon-property': {
        '&:after': { content: "'◇'" },
    },
    '.cm-tooltip a': {
        color: 'var(--cm-link)',
    },
    '.cm-tooltip-section': {
        overflowWrap: 'break-word',
        wordBreak: 'break-word',
        minWidth: '0',
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
    // When a codeblock's toolbar is in use, bump its panels-top above
    // the default 301 used by other codeblocks. Otherwise a later
    // codeblock's toolbar paints over this one's open dropdown — the
    // dropdown's own `z-index: 200` is confined to its panels-top
    // stacking context, and that stacking context's z-index loses to
    // any later sticky panels-top at the same z-index (document order
    // tie-break).
    //
    // We trigger this on two conditions:
    //   1. `:focus-within` — the user is interacting with the input.
    //   2. `:has(.cm-search-results:not(:empty))` — the dropdown is
    //      populated. This handles the case where focus has moved
    //      away (e.g. into the dropdown's hover target) but the
    //      dropdown is still visible and shouldn't be occluded.
    '.cm-panels-top:focus-within, .cm-panels-top:has(.cm-search-results:not(:empty))': {
        zIndex: 401,
    },
    // CSS border spinner for file loading indicator. Rendered as a
    // separate element inside .cm-toolbar-state-icon-container; the
    // container is a flex row so `margin-left: auto` pushes the
    // spinner against the container's right edge and `align-self:
    // center` centers it vertically within the toolbar row.
    //
    // No horizontal margin math: alignment with the line-number
    // column on the gutter row below is enforced by tests against
    // `.cm-lineNumbers` rather than precomputed pixel offsets here.
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
        marginLeft: 'auto',
        alignSelf: 'center',
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
    // Terminal wrapper — replaces the toolbar input with ghostty.
    // Starts at top: 0 to cover the hidden toolbar elements (filler),
    // then extends downward as content grows. Height set by JS.
    '.cm-terminal-wrapper': {
        position: 'absolute',
        top: '0',
        left: '0',
        right: '0',
        height: '0',
        maxHeight: '50vh',
        zIndex: 150,
        background: 'var(--cm-toolbar-background)',
    },
    '.cm-terminal-container': {
        overflow: 'hidden',
        position: 'relative',
        outline: 'none',
    },
    // Terminal cursor — block cursor rendered as a mark decoration
    '.cm-terminal-cursor': {
        background: 'var(--cm-foreground, #d4d4d4)',
        color: 'var(--cm-background, #1e1e1e)',
        animation: 'cm-terminal-blink 1s step-end infinite',
    },
    '@keyframes cm-terminal-blink': {
        '50%': { opacity: '0' },
    },
    // Auto-hide toolbar: JS manages retract/expand by toggling
    // .cm-toolbar-retracted on .cm-panels-top (see toolbar.ts).
    // The transition makes expand/retract feel smooth.
    '& .cm-panels-top.cm-toolbar-retracted': {
        maxHeight: '0px',
        overflow: 'hidden',
        transition: 'max-height 0.15s ease-out',
    },
    // ── Toolbar-mode copy affordance ────────────────────────────────
    // The state-icon's nerd-font glyph is hidden by setting
    // `color: transparent` (keeps the text node in the DOM — see the
    // comment in panels/copy-button.ts for why that matters) and
    // overlaid with an absolutely-positioned SVG. The state-icon's
    // own padding, width, display, and text-align are untouched,
    // so the toolbar row's height is identical between modes — no
    // codeblock-bounds shift, no block-action indicator drift.
    '.cm-toolbar-state-icon.cm-copy-icon-active': {
        color: 'transparent',
        cursor: 'pointer',
        position: 'relative',
    },
    '.cm-copy-icon-overlay': {
        // Center the SVG over the glyph's character cell rather than
        // right-aligning the box. The glyph sits in a `1ch`-wide cell
        // whose right edge is at `padding-right` (= `calc(1ch + 3px)`)
        // from the container's right; the cell's *center* is therefore
        // at `calc(1.5ch + 3px)` from the right. Anchor the SVG's
        // center there with `right` + `translateX(50%)`. This matters
        // because `1ch` is typically narrower than `1em` (nerd-font's
        // monospace `ch` ≈ 0.6em), so right-aligning a 1em-wide SVG
        // puts its visible *center* a few pixels left of the glyph's
        // visible center — exactly the offset users notice.
        position: 'absolute',
        top: '50%',
        // `calc(1.5ch + 3px)` puts the SVG center on the glyph cell's
        // center mathematically; the subtracted `2px` nudges it
        // slightly right to land on the nerd-font glyph's *visible*
        // center (the search icon's ink isn't perfectly centered in
        // its character cell — sits a touch left of geometric centre).
        right: 'calc(1.5ch + 1px)',
        transform: 'translate(50%, -50%)',
        width: '1em',
        height: '1em',
        display: 'block',
        color: 'var(--cm-foreground)',
        // The overlay paints, but doesn't capture clicks — the
        // state-icon parent owns the hit area, ensuring the click
        // handler also fires when the user clicks the (transparent)
        // text underneath the SVG.
        pointerEvents: 'none',
    },
    '.cm-copy-icon-overlay > svg': {
        width: '100%',
        height: '100%',
        display: 'block',
    },
    '.cm-toolbar-state-icon.cm-copy-icon-active:hover .cm-copy-icon-overlay': {
        color: 'var(--cm-search-result-color-hover, var(--cm-foreground))',
    },
    '.cm-toolbar-state-icon.cm-copy-icon-success .cm-copy-icon-overlay': {
        color: '#3fb950',
    },
    // ── Inline-mode copy button (no toolbar) ────────────────────────
    // Floating button positioned at the end of the first text line.
    // `top` and `left` are set inline by JS based on the line's
    // measured end-coordinates; CSS owns size, appearance, and the
    // hover-reveal transition.
    '.cm-copy-button-inline': {
        position: 'absolute',
        zIndex: 20,
        width: '24px',
        height: '24px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        padding: 0,
        border: '1px solid var(--cm-tooltip-border, rgba(128, 128, 128, 0.3))',
        borderRadius: '4px',
        background: 'var(--cm-toolbar-background, transparent)',
        color: 'var(--cm-toolbar-color, currentColor)',
        cursor: 'pointer',
        lineHeight: 1,
        opacity: '0',
        transition: 'opacity 120ms ease-out, color 120ms ease-out, background-color 120ms ease-out',
        // While hidden, click-through so the corner isn't a dead zone.
        pointerEvents: 'none',
    },
    '.cm-copy-button-inline > svg': {
        width: '13px',
        height: '13px',
        display: 'block',
        pointerEvents: 'none',
    },
    '&:hover .cm-copy-button-inline, &:focus-within .cm-copy-button-inline': {
        opacity: '1',
        pointerEvents: 'auto',
    },
    '.cm-copy-button-inline:hover': {
        background: 'var(--cm-search-result-bg-hover, rgba(128, 128, 128, 0.15))',
    },
    '.cm-copy-button-inline.cm-copy-button-success': {
        opacity: '1',
        pointerEvents: 'auto',
        color: '#3fb950',
    },
});
