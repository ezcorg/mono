import { StyleModule } from 'style-mod';

const darkModeStyles: Record<string, string> = {
    '--ezco-mde-code-bg': 'var(--ezco-mde-code-bg-dark)',
    '--ezco-mde-bg': 'var(--ezco-mde-bg-dark)',
    '--ezco-mde-table-bg': 'var(--cm-toolbar-bg-dark)',
    // Toolbar variables (shared with @joinezco/codeblock ToolbarCore)
    '--cm-toolbar-background': '#2a2a2f',
    '--cm-toolbar-color': '#ffffff',
    '--cm-foreground': '#9cdcfe',
    '--cm-search-result-color': '#9cdcfe',
    '--cm-search-result-color-hover': '#ffffff',
    '--cm-search-result-bg-hover': 'rgba(36, 144, 233, 0.31)',
    '--cm-search-result-color-selected': '#ffffff',
    '--cm-search-result-select-bg': '#2490e9',
    '--cm-command-result-color': '#ffffff',
    '--cm-tooltip-border': '#000000',
}
export const styleModule: StyleModule = new StyleModule({
    ':root[data-theme="dark"], [data-theme="dark"] .ezco-mde, .ezco-mde[data-theme="dark"]': darkModeStyles,
    '@media (prefers-color-scheme: dark)': {
        'div.ezco-mde': darkModeStyles
    },
    ':root, :root[data-theme="light"], [data-theme="light"] .ezco-mde, .ezco-mde[data-theme="light"]': {
        // Light/dark mode vars
        '--ezco-mde-code-bg-light': '#f1f1f1',
        '--ezco-mde-code-bg-dark': '#2c2c2c',
        '--ezco-mde-bg-light': '#ffffff',
        '--ezco-mde-bg-dark': '#1e1e1e',
        '--ezco-mde-link-color': '#5861ff',
        '--ezco-mde-link-color-hover': '#383ea3',
        '--ezco-mde-block-indicator-color': 'rgba(160, 160, 160, 0.45)',
        '--ezco-mde-block-action-btn-color': 'rgba(245, 245, 245, 0.6)',
        '--ezco-mde-block-action-btn-bg': 'rgba(245, 245, 245, 0.05)',
        '--ezco-mde-block-action-btn-bg-hover': 'rgba(245, 245, 245, 0.12)',
        // Context-menu theming — dedicated variables (rather than
        // reusing `--cm-toolbar-*` from the codeblock package) so the
        // rich-text editor's menus can have their own visual identity:
        // black background, light text, sans-serif, no monospace font.
        '--ezco-mde-context-menu-bg': '#000000',
        '--ezco-mde-context-menu-color': '#f5f5f5',
        '--ezco-mde-context-menu-border': 'rgba(245, 245, 245, 0.16)',
        '--ezco-mde-context-menu-item-bg-hover': 'rgba(245, 245, 245, 0.1)',
        '--ezco-mde-context-menu-item-color-muted': 'rgba(245, 245, 245, 0.55)',

        // Typography scale based on perfect fourth ratio (1.333)
        '--ezco-mde-type-ratio': '1.25',
        '--ezco-mde-base-font-size': '1.25rem',
        '--ezco-mde-base-line-height': '1.5',
        
        // Font sizes using modular scale
        '--ezco-mde-text-xs': 'calc(var(--ezco-mde-base-font-size) / var(--ezco-mde-type-ratio))',
        '--ezco-mde-text-sm': 'calc(var(--ezco-mde-text-xs) * var(--ezco-mde-type-ratio))',
        '--ezco-mde-text-base': 'var(--ezco-mde-base-font-size)',
        '--ezco-mde-text-lg': 'calc(var(--ezco-mde-text-base) * var(--ezco-mde-type-ratio))',
        '--ezco-mde-text-xl': 'calc(var(--ezco-mde-text-lg) * var(--ezco-mde-type-ratio))',
        '--ezco-mde-text-2xl': 'calc(var(--ezco-mde-text-xl) * var(--ezco-mde-type-ratio))',
        '--ezco-mde-text-3xl': 'calc(var(--ezco-mde-text-2xl) * var(--ezco-mde-type-ratio))',
        '--ezco-mde-text-4xl': 'calc(var(--ezco-mde-text-3xl) * var(--ezco-mde-type-ratio))',
        
        // Line heights based on modular scale - inversely related to font size for better readability
        '--ezco-mde-line-ratio': '1', // Smaller ratio for line height progression
        '--ezco-mde-leading-loose': 'calc(var(--ezco-mde-base-line-height) * var(--ezco-mde-line-ratio))',
        '--ezco-mde-leading-relaxed': 'var(--ezco-mde-base-line-height)',
        '--ezco-mde-leading-normal': 'calc(var(--ezco-mde-base-line-height) / var(--ezco-mde-line-ratio))',
        '--ezco-mde-leading-snug': 'calc(var(--ezco-mde-leading-normal) / var(--ezco-mde-line-ratio))',
        '--ezco-mde-leading-tight': 'calc(var(--ezco-mde-leading-snug) / var(--ezco-mde-line-ratio))',

        // Default to light mode, overridden by media query
        '--ezco-mde-code-bg': 'var(--ezco-mde-code-bg-light)',
        '--ezco-mde-bg': 'var(--ezco-mde-bg-light)',
        '--ezco-mde-table-bg': 'var(--cm-toolbar-bg-light)',

        // Toolbar variables (shared with @joinezco/codeblock ToolbarCore)
        '--cm-font-family': 'Menlo, Monaco, Consolas, "Andale Mono", "Ubuntu Mono", "Courier New", monospace',
        '--cm-icon-font-family': '"UbuntuMono NF", var(--cm-font-family)',
        '--cm-toolbar-bg-light': '#f3f3f3',
        '--cm-toolbar-bg-dark': '#2a2a2f',
        '--cm-toolbar-background': 'var(--cm-toolbar-bg-light)',
        '--cm-toolbar-color': '#000000',
        '--cm-foreground': '#383a42',
        '--cm-search-result-color': '#383a42',
        '--cm-search-result-color-hover': '#000000',
        '--cm-search-result-bg-hover': 'rgba(36, 144, 233, 0.31)',
        '--cm-search-result-color-selected': '#ffffff',
        '--cm-search-result-select-bg': '#2490e9',
        '--cm-command-result-color': '#000000',
        '--cm-tooltip-border': '#c8c8c8',
    },
    '.ezco-mde': {

        // Base editor styles
        'background': 'transparent',

        '& a': {
            color: 'var(--ezco-mde-link-color)',
            'text-decoration': 'inherit',
        },

        '& a:hover': {
            color: 'var(--ezco-mde-link-color-hover)',
            cursor: 'pointer',
        },

        // Block-level vertical rhythm uses *top-only* margins driven by
        // the `& .ProseMirror > * + *` rules near the bottom of this
        // block: each element declares its own size/weight/font here,
        // but spacing between two adjacent blocks is owned by the
        // *transition* (the `+` rule), not by either block alone.
        // That means converting a paragraph to a list, a heading to a
        // paragraph, etc. doesn't shift surrounding layout, and the
        // last block always sits flush at the document's bottom edge.
        '& h1': {
            'font-size': 'var(--ezco-mde-text-4xl)',
            'line-height': 'var(--ezco-mde-leading-tight)',
            margin: 0,
            'font-weight': 'bold',
        },
        '& h2': {
            'font-size': 'var(--ezco-mde-text-3xl)',
            'line-height': 'var(--ezco-mde-leading-tight)',
            margin: 0,
            'font-weight': 'bold',
        },
        '& h3': {
            'font-size': 'var(--ezco-mde-text-2xl)',
            'line-height': 'var(--ezco-mde-leading-snug)',
            margin: 0,
            'font-weight': 'bold',
        },
        '& h4': {
            'font-size': 'var(--ezco-mde-text-xl)',
            'line-height': 'var(--ezco-mde-leading-snug)',
            margin: 0,
            'font-weight': 'bold',
        },
        '& h5': {
            'font-size': 'var(--ezco-mde-text-lg)',
            'line-height': 'var(--ezco-mde-leading-normal)',
            margin: 0,
            'font-weight': 'bold',
        },
        '& h6': {
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-normal)',
            margin: 0,
            'font-weight': 'bold',
        },
        '& p': {
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-relaxed)',
            margin: 0,
        },
        '& blockquote': {
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-relaxed)',
            margin: 0,
            padding: '0 1em',
            'border-left': '4px solid #ddd',
        },
        // Multi-paragraph quotes: keep the inter-paragraph rhythm.
        '& blockquote > * + *': {
            'margin-top': '1em',
        },
        '& small': {
            'font-size': 'var(--ezco-mde-text-sm)',
            'line-height': 'var(--ezco-mde-leading-normal)',
        },

        // Codeblock styles
        '& .cm-editor': {
            margin: 0,
            border: '2px solid var(--ezco-mde-table-bg)'
        },

        // Inline code styles
        '& > :not(.cm-editor) code': {
            'font-family': 'monospace',
            background: 'var(--ezco-mde-code-bg)',
            padding: '0.1em 0.3em',
            'border-radius': '3px',
            '-webkit-box-decoration-break': 'clone',
            'box-decoration-break': 'clone',
        },
        // Table styles. (The `tableWrapper` selector was previously
        // written `&.tableWrapper`, which compounds on `.ezco-mde`
        // itself and never matches the ProseMirror-emitted wrapper —
        // fixed here to `& .tableWrapper`.)
        '& .tableWrapper': {
            margin: 0,
            'overflow-x': 'auto'
        },
        '& table': {
            "border-collapse": "collapse",
            "width": "100%",
            margin: 0,
            border: '2px solid var(--ezco-mde-table-bg)',
            overflow: 'hidden',
            'table-layout': 'fixed',

            '& > .column-resize-handle': {
                'background-color': 'red',
                bottom: '-2px',
                'pointer-events': 'none',
                position: 'absolute',
                right: '-2px',
                top: 0,
                width: '4px',
            },
            '& th': {
                'font-weight': 'bold',
                'background-color': 'var(--ezco-mde-table-bg)',
                'text-align': 'left',
            },
            '& th, & td': {
                border: 'none',
                padding: '0.5em',
                'vertical-align': 'top',
                position: 'relative',
            },
        },
        '& .selectedCell::after': {
            'z-index': 2,
            position: 'absolute',
            content: '""',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            background: 'rgba(0, 123, 255, 0.1)',
            'pointer-events': 'none',
        },
        '&.resize-cursor': {
            '&': {
                cursor: 'ew-resize',
            },
            cursor: 'col-resize',
        },
        // Tight list horizontal indent. No vertical margin here —
        // top-level spacing is owned by the `.ProseMirror > * + *`
        // rules, nested spacing by the `li > ul/ol/menu` rule below.
        '& .tight': {
            'margin-left': '18px',
            'margin-right': '18px',
            '& li': {
                'padding-left': '2px',
            },
        },
        // List base — zero margin; vertical rhythm comes from the
        // sibling `+` rules. Font-size matches `& p` so converting a
        // paragraph to a list doesn't shift layout (also dodges the
        // browser default `margin-block-start: 1em` and the fact that
        // `1em` resolves differently on `<ul>` vs `<p>` when they
        // have different inherited font-sizes).
        '& ul, & ol, & menu': {
            padding: 0,
            margin: 0,
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-relaxed)',
        },
        // Multi-paragraph list items: keep the inter-paragraph rhythm.
        '& li > p + p': {
            'margin-top': '1em',
        },
        // Only target rich-text lists — exclude anything nested inside
        // a CodeMirror editor (the codeblock's search-results dropdown
        // is a `<ul>` inside `.cm-editor`, and was getting the same
        // top margin and rendering as overly spaced rows).
        '& ul:not(.cm-editor *) > li + li, & ol:not(.cm-editor *) > li + li, & menu:not(.cm-editor *) > li + li':
            {
                'margin-top': '1em',
            },
        // Nested non-task lists: top margin so the nested list doesn't
        // sit flush against the parent item's paragraph.
        '& li > ul, & li > ol, & li > menu': {
            'margin-top': '1em',
        },
        // Task list styles
        '& li[data-checked="true"]>div>p': {
            "text-decoration": "line-through",
            "color": "#888",
        },
        '& ul[data-type="taskList"]': {
            'list-style': 'none',
            'padding': 0,
            margin: 0,
            'margin-top': '1em',

            '& p + ul[data-type="taskList"]': {
                'margin-top': '0.75em'
            },

            '& p + p': {
                'margin-top': '0.75em',
            },

            '& li': {
                display: 'flex',
                'align-items': 'flex-start',
            },

            '& li + li': {
                'margin-top': '0.75em'
            },

            '& li > label': {
                'margin-right': '1ch',
                'margin-top': '4px'
            },
            '& li > label > input': {
                margin: 0,
                width: '1em',
                height: '1em',
            },
            '& li > div': {
                flex: 1
            }
        },
        // Make task checkboxes visible when selected (Ctrl-A)
        // Checkboxes don't natively show selection highlighting,
        // so add an outline using the system Highlight color
        '& ul[data-type="taskList"] li > label > input[type="checkbox"]': {
            '&::selection': {
                background: 'Highlight',
            },
        },

        // ─────────────────────────────────────────────────────────────
        // Top-only block spacing.
        //
        // Every block-level element above has `margin: 0`; this is
        // where the visible vertical rhythm of the document is
        // actually defined. The pattern: the gap between two adjacent
        // blocks is a property of the *transition*, not of either
        // block. So we set `margin-top` on the *following* sibling,
        // varied by what each side is.
        //
        // Selectors use `& > …` directly: `editor.view.dom` is the
        // ProseMirror element, and `createEditor` adds the `.ezco-mde`
        // class onto that same element — so `.ezco-mde` and
        // `.ProseMirror` always live on one element, not nested. A
        // descendant selector like `.ezco-mde .ProseMirror > h2` would
        // match nothing.
        //
        // Benefits: no margin-collapsing surprises, `:last-child`
        // resets become unnecessary, the document hugs its bottom
        // edge, and converting a paragraph ↔ heading ↔ list ↔ quote
        // doesn't shift the document below.
        // ─────────────────────────────────────────────────────────────
        '& > * + *': { 'margin-top': '1em' },
        // Body content that immediately follows a heading hugs it — a
        // heading "owns" its body, so the intro paragraph / list / etc.
        // should feel attached, not floating below. Scoped to non-heading
        // followers so a sub-heading after a heading still gets its full
        // top margin from the `* + h*` rules below.
        '& > :is(h1, h2, h3, h4, h5, h6) + :not(h1, h2, h3, h4, h5, h6)':
            {
                'margin-top': '1em',
            },
        // Inset blocks want extra breathing room above (overrides the
        // base 1em — these read as standalone surfaces).
        '& > * + .cm-editor, & > * + .tableWrapper, & > * + blockquote':
            {
                'margin-top': '1.5em',
            },
        // Headings always claim their own top margin, even when
        // following another heading. Declared last so they win over
        // the `h* + *` tightening (same specificity, later cascade).
        '& > * + h1': { 'margin-top': '1.5em' },
        '& > * + h2': { 'margin-top': '1.2em' },
        '& > * + h3': { 'margin-top': '1em' },
        '& > * + h4, & > * + h5, & > * + h6': { 'margin-top': '0.8em' },
    },
    // Block-action overlay — a tall narrow button that spans the full
    // height of the active block. Its right border is the visible
    // indicator line; the icon sits near the top (vertically aligned
    // with the first line of the block via `--icon-offset-y`, set in
    // JS); clicking anywhere on the button opens the action menu (so
    // the whole indicator area is interactive, not just the icon).
    '.ezco-mde-block-action-btn': {
        width: '34px',
        display: 'flex',
        'align-items': 'flex-start',
        'justify-content': 'center',
        // Inner padding leaves breathing room between the icon and the
        // right-edge border (the indicator line), even for the widest
        // glyphs we render (e.g. `</>`).
        'padding-top': 'var(--ezco-mde-block-action-icon-offset-y, 6px)',
        'padding-right': '8px',
        'padding-left': '2px',
        background: 'transparent',
        color: 'var(--ezco-mde-block-action-btn-color)',
        border: 'none',
        'border-right': '2px solid var(--ezco-mde-block-indicator-color)',
        cursor: 'pointer',
        'font-family': 'var(--cm-font-family)',
        'font-size': '13px',
        'line-height': 1,
        transition:
            'top 120ms ease-out, height 120ms ease-out, opacity 120ms ease-out, background-color 120ms ease-out, padding-top 120ms ease-out',
        'z-index': 5,
    },
    '.ezco-mde-block-action-btn:hover': {
        // No background change on hover — the indicator stays unobtrusive.
        // Brighten the indicator line and icon glyph instead so there's
        // still some visual feedback that the button is interactive.
        'border-right-color': 'rgba(220, 220, 220, 0.7)',
        color: 'rgba(245, 245, 245, 0.95)',
    },
    '.ezco-mde-block-action-btn-icon': {
        'pointer-events': 'none',
        // The icon stretches/squeezes its own width so multi-character
        // glyphs like `</>` don't push outside the padded area.
        'max-width': '100%',
        'text-align': 'center',
    },
    // Generic context-menu component (also used by future menus —
    // slash commands, link previews, etc.). Themed for a rich-text
    // editor surface — sans-serif throughout, decoupled from the
    // codeblock package's monospace toolbar vars.
    '.ezco-mde-context-menu': {
        display: 'flex',
        'flex-direction': 'column',
        'min-width': '200px',
        padding: '4px',
        background: 'var(--ezco-mde-context-menu-bg)',
        color: 'var(--ezco-mde-context-menu-color)',
        border: '1px solid var(--ezco-mde-context-menu-border)',
        'border-radius': '6px',
        'box-shadow': '0 8px 24px rgba(0, 0, 0, 0.45)',
        outline: 'none',
        // Sans-serif for the menu surface — the metaphor here is the
        // rich-text editor's affordances, not the code editor's.
        'font-family': 'Inter, system-ui, -apple-system, sans-serif',
    },
    '.ezco-mde-context-menu-item': {
        display: 'flex',
        'align-items': 'center',
        gap: '10px',
        padding: '7px 10px',
        background: 'transparent',
        color: 'inherit',
        border: 'none',
        'border-radius': '4px',
        cursor: 'pointer',
        'font-family': 'inherit',
        'font-size': '13px',
        'line-height': 1.3,
        'text-align': 'left',
        outline: 'none',
    },
    '.ezco-mde-context-menu-item:hover, .ezco-mde-context-menu-item:focus, .ezco-mde-context-menu-item:focus-visible': {
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        outline: 'none',
    },
    '.ezco-mde-context-menu-item[aria-disabled="true"]': {
        opacity: 0.4,
        cursor: 'default',
    },
    '.ezco-mde-context-menu-item-icon': {
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        width: '20px',
        // No monospace — keep the icon glyphs in the same family as
        // the menu's labels for a coherent typographic feel.
        'font-family': 'inherit',
        'font-size': '12px',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        flex: 'none',
    },
    '.ezco-mde-context-menu-item:hover .ezco-mde-context-menu-item-icon, .ezco-mde-context-menu-item:focus .ezco-mde-context-menu-item-icon, .ezco-mde-context-menu-item:focus-visible .ezco-mde-context-menu-item-icon': {
        color: 'inherit',
    },
    '.ezco-mde-context-menu-item-label': {
        flex: 1,
    },
    '.tippy-box[data-theme~="ezco-mde-block-actions"]': {
        background: 'transparent',
        'box-shadow': 'none',
        padding: 0,
    },
    '.tippy-box[data-theme~="ezco-mde-block-actions"] .tippy-content': {
        padding: 0,
    },
    // Toolbar layout is provided by ToolbarCore's own StyleModule.
    // Only override the codeblock editor margin within the markdown editor.

})