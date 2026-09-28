import { StyleModule } from 'style-mod';

const darkModeStyles: Record<string, string> = {
    '--ezco-mde-code-bg': 'var(--ezco-mde-code-bg-dark)',
    '--ezco-mde-bg': 'var(--ezco-mde-bg-dark)',
    '--ezco-mde-fg': '#e4e4e7',
    '--ezco-mde-table-bg': 'var(--cm-toolbar-bg-dark)',
    '--ezco-mde-divider': 'rgba(255, 255, 255, 0.14)',
    // Popover surface (block-action / selection menus, link popover, search
    // toolbar + its results). Dark mode keeps the charcoal palette; light mode
    // (in the `:root`/`[data-theme="light"]` block below) uses a light surface
    // so popovers match the editor + the titlebar search field.
    '--ezco-mde-context-menu-bg': '#26262c',
    '--ezco-mde-context-menu-bg-hover': '#34343c',
    '--ezco-mde-context-menu-color': '#f5f5f5',
    '--ezco-mde-context-menu-border': 'rgba(245, 245, 245, 0.16)',
    '--ezco-mde-context-menu-item-bg-hover': 'rgba(245, 245, 245, 0.1)',
    '--ezco-mde-context-menu-item-color-muted': 'rgba(245, 245, 245, 0.55)',
    // Toolbar variables (shared with @joinezco/codeblock ToolbarCore)
    '--cm-toolbar-background': '#2a2a2f',
    '--cm-toolbar-color': '#ffffff',
    '--cm-foreground': '#9cdcfe',
    '--cm-search-result-color': '#9cdcfe',
    '--cm-search-result-color-hover': '#ffffff',
    '--cm-search-result-bg-hover': 'rgba(59, 158, 239, 0.30)',
    '--cm-search-result-color-selected': '#ffffff',
    '--cm-search-result-select-bg': '#3b9eef',
    '--cm-command-result-color': '#ffffff',
    '--cm-tooltip-border': '#000000',
    // macOS-style accent blue — links and selected/hovered menu rows. A touch
    // brighter than the light-mode blue for contrast on dark surfaces. The
    // family matches the codeblock search dropdown's blue.
    '--ezco-mde-accent': '#3b9eef',
    '--ezco-mde-accent-fg': '#ffffff',
    '--ezco-mde-link-color': '#54a8f2',
    '--ezco-mde-link-color-hover': '#85c3f7',
    '--ezco-mde-chrome-shadow': '0 6px 20px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.3)',
    '--ezco-mde-danger': '#f07171',
}
export const styleModule: StyleModule = new StyleModule({
    ':root[data-theme="dark"], [data-theme="dark"] .ezco-mde, .ezco-mde[data-theme="dark"]': darkModeStyles,
    // `system` theme (no explicit `data-theme`): follow the OS. Apply to
    // `:root` as well as the editor so that chrome rendered OUTSIDE the editor
    // (block-action / selection menus, link popover — all appended to body)
    // and host containers (e.g. the demo window) pick up the dark vars too.
    // An explicit `[data-theme]` still wins by specificity.
    '@media (prefers-color-scheme: dark)': {
        // The base light vars live on `:root` and are declared *later* in this
        // module, so a plain `:root` selector here would lose the same-specificity
        // cascade tie and system dark mode would render light (white editor bg).
        // `:root:not([data-theme="light"])` outranks the base `:root` so the OS
        // preference wins — while still letting an explicit `data-theme="light"`
        // override the OS. The editor body and body-appended chrome (menus,
        // popovers) inherit these custom properties from :root.
        ':root:not([data-theme="light"])': darkModeStyles
    },
    // Width-constrained screens need every pixel of horizontal real
    // estate, so the editor's left gutter (which only exists to give
    // the block-action indicator a strip to live in) collapses to
    // zero. Above 640px it returns to the comfortable 4px breathing
    // room the indicator's rendering depends on for visual alignment.
    '@media (min-width: 640px)': {
        '.ezco-mde-body': {
            'padding-left': '4px',
        }
    },
    // ─────────────────────────────────────────────────────────────
    // Editor shell. `.ezco-mde` is the parent that lays out the default chrome:
    // a (stationary) toolbar slot above a content row of [navbar | block-action
    // gutter | editable]. Empty slots collapse (toolbar mounted elsewhere, or no
    // outline). A consumer bounds the height + makes `.ezco-mde-content` scroll
    // to pin the toolbar while only the body scrolls.
    // ─────────────────────────────────────────────────────────────
    // Both may shrink below their content's widest word (a long URL, a
    // package name in a heading): it wraps inside the column instead of
    // widening the editor past its host.
    '.ezco-mde': {
        display: 'flex',
        'flex-direction': 'column',
        'min-height': 0,
        'min-width': 0,
        flex: 1,
    },
    '.ezco-mde-content': {
        display: 'flex',
        'flex-direction': 'row',
        'align-items': 'stretch',
        'min-height': 0,
        'min-width': 0,
        flex: 1,
        // Establish a stacking context so embedded codeblocks' internal z-indexes
        // (their sticky panel header uses z-index: 200) stay confined to the
        // content region and can't paint over chrome pinned in the toolbar slot
        // above (e.g. the search results dropdown when the toolbar is pinned).
        position: 'relative',
        'z-index': 0,
    },
    // Sits above the content's stacking context so a pinned toolbar (and its
    // results dropdown) is never occluded by body content scrolling beneath it.
    '.ezco-mde-toolbar-slot': {
        flex: 'none',
        position: 'relative',
        'z-index': 1,
    },
    '.ezco-mde-nav': {
        flex: 'none',
    },
    // The rail (extensions/rail.ts): the column the outline and the file tree
    // share, the editor's or the host's. The rail is what stays in view as the
    // note scrolls, no taller than the scroll area it is in (the height is kept
    // by script); its panels stack inside it. Pinned on their own, the panels
    // would pin to the same place and cover each other.
    '.ezco-mde-rail': {
        flex: 'none',
        'align-self': 'flex-start',
        position: 'sticky',
        top: 0,
        'box-sizing': 'border-box',
        'max-height': 'var(--ezco-mde-rail-height, 100vh)',
        'overflow-y': 'auto',
    },
    '.ezco-mde-rail > .ezco-mde-sidebar, .ezco-mde-rail > .ezco-mde-files': {
        position: 'static',
        'max-height': 'none',
        'overflow-y': 'visible',
    },
    // A rail whose panels are all hidden (the tree closed, no outline) takes
    // no room: nothing shows until asked for.
    '.ezco-mde-rail:not(:has(> :not([hidden]))), .ezco-mde-files[hidden], .ezco-mde-links[hidden]': {
        display: 'none',
    },
    // The block-action indicator's column — a fixed width so the indicator never
    // overlaps the navbar or the prose; `position: relative` is the positioning
    // context for the absolutely-positioned button.
    '.ezco-mde-gutter': {
        flex: 'none',
        width: '48px',
        position: 'relative',
    },
    // A full-file code editor (a non-prose file swapped in by the filesystem
    // extension) carries its own line-number gutter, so the block-action gutter
    // is redundant — hide it while such a file is shown (the wrapper carries
    // `--code-file` for the duration).
    '.ezco-mde--code-file .ezco-mde-gutter': {
        display: 'none',
    },
    // Frame the embedded/standalone codeblock tooltips (LSP hover, autocomplete,
    // diagnostics) like the editor's own dropdowns (block-action / slash menus)
    // rather than the codeblock's default 2px-border look: a 1px themed border,
    // the menu's radius + shadow, and a touch of padding. Driven by the same
    // `--ezco-mde-context-menu-*` vars, so a consumer restyles tooltips + menus
    // together. The `--cm-tooltip-border` alias keeps the codeblock's own
    // tooltip parts (e.g. the pointer/arrow) on the same colour.
    '.ezco-mde .cm-tooltip': {
        border: '1px solid var(--ezco-mde-context-menu-border)',
        'border-radius': '6px',
        'box-shadow': 'var(--ezco-mde-chrome-shadow)',
        '--cm-tooltip-border': 'var(--ezco-mde-context-menu-border)',
    },
    // The codeblock's right-click menu (context-menu/menu.ts copies these
    // onto it, since it lives on <body>): the same frame as the editor's own
    // menus — surface, hairline, corners, inset, shadow, rounded rows — in
    // the codeblock's monospace, as its toolbar and dropdown are.
    '.ezco-mde .cm-editor': {
        '--cm-menu-background': 'var(--ezco-mde-context-menu-bg)',
        '--cm-menu-color': 'var(--ezco-mde-context-menu-color)',
        '--cm-menu-border': '1px solid var(--ezco-mde-context-menu-border)',
        '--cm-menu-radius': '6px',
        '--cm-menu-padding': '4px',
        '--cm-menu-shadow': 'var(--ezco-mde-chrome-shadow)',
        '--cm-menu-item-padding': '4px 8px',
        '--cm-menu-item-radius': '4px',
        '--cm-menu-divider': 'var(--ezco-mde-context-menu-border)',
        '--cm-menu-divider-margin': '4px 2px',
        '--cm-menu-divider-opacity': '1',
    },
    // Autocomplete list: inset its rows from the rounded frame like a menu, and
    // round the active row so it doesn't square off against the border.
    '.ezco-mde .cm-tooltip.cm-tooltip-autocomplete > ul': {
        padding: '4px',
    },
    '.ezco-mde .cm-tooltip.cm-tooltip-autocomplete > ul > li': {
        'border-radius': '4px',
    },
    '.ezco-mde-body-host': {
        flex: 1,
        'min-width': 0,
        // What floats over the note (a comment card, a model's answer) is
        // placed against the note's column.
        position: 'relative',
        // A flex column so the editable can grow to fill the host's height: that
        // gives a click target below a short document, so clicking the empty area
        // places the caret instead of only the lines of text being clickable.
        display: 'flex',
        'flex-direction': 'column',
    },
    // Empty slots take no space (toolbar mounted elsewhere; outline disabled).
    '.ezco-mde-nav:empty, .ezco-mde-toolbar-slot:empty': {
        display: 'none',
    },
    ':root, :root[data-theme="light"], [data-theme="light"] .ezco-mde, .ezco-mde[data-theme="light"]': {
        // Light/dark mode vars
        '--ezco-mde-code-bg-light': '#f1f1f1',
        '--ezco-mde-code-bg-dark': '#2c2c2c',
        '--ezco-mde-bg-light': '#ffffff',
        '--ezco-mde-bg-dark': '#1e1e1e',
        // macOS-style accent blue — links and selected/hovered menu rows,
        // matching the codeblock search dropdown's blue (was an indigo/purple).
        '--ezco-mde-accent': '#2490e9',
        '--ezco-mde-accent-fg': '#ffffff',
        '--ezco-mde-link-color': '#2490e9',
        '--ezco-mde-link-color-hover': '#1a6fbf',
        // The chrome's type and shadow: every panel, menu, card and popover
        // the editor draws around the note shares them, so a host retheming
        // one rethemes all.
        '--ezco-mde-chrome-font': 'Inter, system-ui, -apple-system, sans-serif',
        '--ezco-mde-chrome-shadow': '0 4px 16px rgba(0, 0, 0, 0.13), 0 1px 3px rgba(0, 0, 0, 0.07)',
        // Meaning colours: something wrong (a missing footnote, a deletion),
        // something to look at (a conflict, an orphaned comment; the
        // warning callout's colour), and commented text.
        '--ezco-mde-danger': '#d33',
        '--ezco-mde-warning': '#ff9100',
        '--ezco-mde-comment-color': '#f5b400',
        // List decoration gutter — the shared column every list item reserves
        // on its left for its marker/checkbox; text starts after it. Sized to
        // fit the checkbox with a small gap, kept tight to avoid excess space.
        // `list-line` is one text line's box height (used to vertically centre
        // the checkbox on the first line).
        '--ezco-mde-list-gutter': '1.05em',
        '--ezco-mde-list-line': 'calc(var(--ezco-mde-text-base) * var(--ezco-mde-leading-relaxed))',
        '--ezco-mde-checkbox-size': '0.9em',
        // Mid-grey so the indicator reads on both light and dark surfaces —
        // the block-action button renders OUTSIDE `.ezco-mde`, so it can't
        // pick up the editor's theme-scoped vars (the old near-white value
        // was invisible on a light editor).
        '--ezco-mde-block-indicator-color': 'rgba(120, 120, 120, 0.4)',
        '--ezco-mde-block-action-btn-color': 'rgba(120, 120, 120, 0.9)',
        '--ezco-mde-block-action-btn-bg': 'rgba(245, 245, 245, 0.05)',
        '--ezco-mde-block-action-btn-bg-hover': 'rgba(245, 245, 245, 0.12)',
        // Context-menu theming — the shared surface for every floating chrome
        // element: the block-action / selection menus, the link popover, the
        // selection affordance button, and the search toolbar + its results
        // dropdown. Light mode uses a light elevated surface with dark text (so
        // popovers match the editor + the titlebar search field); dark mode
        // (darkModeStyles, above) keeps the charcoal palette. Decoupled from
        // the codeblock's monospace toolbar vars.
        '--ezco-mde-context-menu-bg': '#ffffff',
        '--ezco-mde-context-menu-bg-hover': '#f0f0f3',
        '--ezco-mde-context-menu-color': '#1d1d1f',
        '--ezco-mde-context-menu-border': 'rgba(0, 0, 0, 0.12)',
        '--ezco-mde-context-menu-item-bg-hover': 'rgba(0, 0, 0, 0.06)',
        '--ezco-mde-context-menu-item-color-muted': 'rgba(0, 0, 0, 0.5)',

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
        '--ezco-mde-fg': '#1d1d1f',
        '--ezco-mde-table-bg': 'var(--cm-toolbar-bg-light)',
        '--ezco-mde-divider': 'rgba(0, 0, 0, 0.12)',

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
        '--cm-search-result-bg-hover': 'rgba(36, 144, 233, 0.30)',
        '--cm-search-result-color-selected': '#ffffff',
        '--cm-search-result-select-bg': '#2490e9',
        '--cm-command-result-color': '#000000',
        '--cm-tooltip-border': '#c8c8c8',
    },
    '.ezco-mde-body': {

        // Grow to fill the (flex-column) body host so the whole area is a click
        // target — clicking below a short document still lands the caret in it —
        // while never shrinking below the document's own height.
        flex: '1 0 auto',

        // Base editor styles. The background stays transparent (the host
        // container supplies `--ezco-mde-bg`), but we set the prose text
        // colour so it flips with the theme instead of inheriting the page's
        // — otherwise dark mode would be near-black text on a dark surface.
        'background': 'transparent',
        'color': 'var(--ezco-mde-fg)',

        // `break-spaces` preserves trailing whitespace at the end of a
        // line, where PM's default `pre-wrap` would otherwise collapse
        // it visually. This is load-bearing for the `InlineCodeExit`
        // extension's ArrowRight handler: when a code run is the last
        // thing in a paragraph, the handler inserts a plain space
        // outside the mark and parks the caret on it — but if the
        // browser collapses that space, the visible caret slips back
        // inside the `<code>` element and the next typed character is
        // absorbed into the code mark (because PM's DOM observer reads
        // marks straight off the resulting DOM node, not from
        // `storedMarks`).
        'white-space': 'break-spaces',

        '& a': {
            color: 'var(--ezco-mde-link-color)',
            'text-decoration': 'inherit',
        },

        '& a:hover': {
            color: 'var(--ezco-mde-link-color-hover)',
            cursor: 'pointer',
        },

        // Wikilinks (extensions/wikilink.ts): the link colour, and a link whose
        // note does not exist yet is dimmed with a dotted underline — still
        // followable (following it creates the note).
        '& .ezco-mde-wikilink': {
            color: 'var(--ezco-mde-link-color)',
            cursor: 'pointer',
            'border-radius': '3px',
        },
        '& .ezco-mde-wikilink.is-unresolved': {
            opacity: 0.6,
            'text-decoration': 'underline dotted',
            'text-underline-offset': '0.2em',
        },
        '& .ezco-mde-wikilink.ProseMirror-selectednode': {
            outline: '2px solid var(--ezco-mde-accent)',
            'outline-offset': '1px',
        },

        // Block-level vertical rhythm uses *top-only* margins driven by
        // the `& > * + *` rules near the bottom of this block: each
        // element declares its own size/weight/font here, but spacing
        // between two adjacent blocks is owned by the *transition*
        // (the `+` rule), not by either block alone. That means
        // converting a paragraph to a list, a heading to a paragraph,
        // etc. doesn't shift surrounding layout, and the last block
        // always sits flush at the document's bottom edge.
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

        // Codeblock styles. No box border — the code surface is set apart by
        // its own background + the surrounding vertical spacing, not a line.
        // `overflow: visible` (rather than hidden) lets the toolbar's search
        // dropdown extend past the bottom of a short codeblock instead of
        // being clipped to the editor box — the code itself still scrolls
        // within `.cm-scroller`, so nothing else spills.
        '& .cm-editor': {
            margin: 0,
            border: 'none',
            overflow: 'visible',
            outline: 'none',
        },
        // The codeblock toolbar + its results dropdown blend with the
        // codeblock's own background (`--cm-background`) in BOTH themes. The
        // codeblock's dark theme re-points `--cm-toolbar-background` to a
        // lighter grey *directly on* `[data-theme='dark'] .cm-toolbar-panel`
        // (specificity 0,2,0), which beats the value we set on `.cm-editor`
        // (it's a direct rule on the panel, not inheritance). The extra
        // `.cm-toolbar-panel` selector below (0,4,0) wins it back so dark
        // matches light; the dropdown (a child of the panel) inherits it.
        '& .cm-editor[data-theme], & .cm-editor[data-theme] .cm-toolbar-panel': {
            '--cm-toolbar-background': 'var(--cm-background)',
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
        // No outer table border — rows are separated by internal horizontal
        // dividers only (and the header by its weight), so the table reads as
        // content rather than a boxed grid.
        '& table': {
            "border-collapse": "collapse",
            "width": "100%",
            margin: 0,
            border: 'none',
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
                'text-align': 'left',
            },
            // Internal row dividers, no last-row line, no vertical lines.
            '& tr': {
                'border-bottom': '1px solid var(--ezco-mde-divider)',
            },
            '& tr:last-child': {
                'border-bottom': 'none',
            },
            '& th, & td': {
                border: 'none',
                padding: '0.4em 0.7em',
                'vertical-align': 'top',
                position: 'relative',
            },
            // Flush the first column with the text column to the left.
            '& th:first-child, & td:first-child': {
                'padding-left': 0,
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
        // ─────────────────────────────────────────────────────────────
        // Lists — one uniform model for every type so that, at every nesting
        // level, all decorations (bullet / number / dash / checkbox) share a
        // start-x and all item text shares a start-x. (See
        // list-alignment.test.ts, which pins this with adjacent + nested lists
        // of all four types.)
        //
        // Each item reserves a fixed decoration gutter on its left
        // (`--ezco-mde-list-gutter`, sized to fit the widest decoration — the
        // checkbox — kept as tight as possible to avoid "excess space" and to
        // minimise the shift when a typed "1. "/"- " becomes a list). The
        // decoration is pinned to the item's left edge: an absolutely
        // positioned `::before` for bullet/ordered/dash, the checkbox
        // `<label>` for tasks. Native `::marker` isn't used — `outside`
        // markers right-align to the text (so "•" and "10." get different
        // start-x) and `inside` markers shift the text.
        // ─────────────────────────────────────────────────────────────
        '& ul, & ol, & menu': {
            padding: 0,
            margin: 0,
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-relaxed)',
            'list-style': 'none',
        },
        // Gutter + hanging text indent (all list-item types).
        '& ul > li, & ol > li': {
            position: 'relative',
            'padding-left': 'var(--ezco-mde-list-gutter)',
        },
        // Decoration pinned to the item's left edge → identical start-x.
        '& ul > li::before, & ol > li::before': {
            position: 'absolute',
            left: 0,
            top: 0,
            'line-height': 'var(--ezco-mde-leading-relaxed)',
            color: 'inherit',
            content: '"•"',
        },
        '& ul[data-marker="dash"] > li::before': {
            content: '"–"',
        },
        // Ordered lists: number via a CSS counter (kept left-aligned in the
        // gutter). Every `<ol>` resets its own counter so nesting restarts;
        // a non-1 `start` is applied as an inline counter-reset by the
        // OrderedListStart plugin (extensions/lists.ts).
        '& ol': {
            'counter-reset': 'ezco-mde-ol',
        },
        '& ol > li': {
            'counter-increment': 'ezco-mde-ol',
        },
        '& ol > li::before': {
            content: 'counter(ezco-mde-ol) "."',
        },
        // Task lists: the checkbox is the decoration. Suppress the bullet
        // `::before` and park the checkbox at the item's left edge (same
        // start-x as the other decorations), centred on the first line.
        '& ul[data-type="taskList"] > li::before': {
            content: 'none',
        },
        '& ul[data-type="taskList"] > li > label': {
            position: 'absolute',
            left: 0,
            top: 0,
            height: 'var(--ezco-mde-list-line)',
            display: 'inline-flex',
            'align-items': 'center',
            margin: 0,
            'user-select': 'none',
        },
        '& ul[data-type="taskList"] > li > label > input': {
            margin: 0,
            width: 'var(--ezco-mde-checkbox-size)',
            height: 'var(--ezco-mde-checkbox-size)',
            cursor: 'pointer',
        },
        '& ul[data-type="taskList"] > li > div': {
            'min-width': 0,
        },
        // Completed task items: strike + mute the text.
        '& li[data-checked="true"]>div>p': {
            'text-decoration': 'line-through',
            color: '#888',
        },
        // Make task checkboxes visible when selected (Ctrl-A). Checkboxes
        // don't natively show selection highlighting, so add an outline
        // using the system Highlight color.
        '& ul[data-type="taskList"] li > label > input[type="checkbox"]::selection': {
            background: 'Highlight',
        },
        // Keep this model out of CodeMirror's own <ul>/<li> UI (autocomplete
        // tooltips, the codeblock toolbar) which lives inside `.cm-editor`.
        '& .cm-editor ul > li::before, & .cm-editor ol > li::before': {
            content: 'none',
        },
        '& .cm-editor ul > li, & .cm-editor ol > li': {
            position: 'static',
            'padding-left': 0,
        },
        // Likewise keep the editor's content typography (the `& p` / `& h1…`
        // font sizes below) from leaking into CodeMirror tooltips — LSP
        // hover docs and diagnostics render markdown as <p>/<h*>/<code>/<li>,
        // which would otherwise pick up the (much larger) prose sizes (the
        // reported `.cm-diagnosticText` "var(--ezco-mde-text-base)" bug). Reset
        // font-size/line-height to inherit so all tooltip text follows the
        // codeblock's own font size (`var(--cm-font-size)`, set per-codeblock
        // from settings); the codeblock's tooltip CSS can still size things
        // specifically. We deliberately do NOT touch font-weight, so a markdown
        // heading or **bold** in a hover doc keeps its emphasis.
        '& .cm-tooltip :is(p, h1, h2, h3, h4, h5, h6, blockquote, li, small, code, pre, ul, ol, table, th, td), & .cm-editor .cm-tooltip :is(p, h1, h2, h3, h4, h5, h6, blockquote, li, small, code, pre, ul, ol, table, th, td)': {
            'font-size': 'inherit',
            'line-height': 'inherit',
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
        '& > * + .cm-editor, & > * + .tableWrapper, & > * + blockquote, & > * + .ezco-mde-callout':
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
        // Codeblocks sit flush against the previous block unless that
        // previous block is a heading — a heading "introduces" the
        // code surface and earns the inset margin (kept at the
        // 1.5em set by the `& > * + .cm-editor` rule above). Other
        // adjacent blocks (paragraphs, lists, another codeblock)
        // pack against the codeblock without a gap.
        //
        // Specificity: `.ezco-mde` (0,1,0) + `:not(h*)` (0,0,1) +
        // `.cm-editor` (0,1,0) = 0,2,1, which beats the
        // `& > * + .cm-editor` rule's 0,2,0 — so this override
        // applies whenever the preceding sibling is *not* a heading.
        '& > :not(h1, h2, h3, h4, h5, h6) + .cm-editor': {
            'margin-top': 0,
        },
        // Front matter is the note's header, not a block before it: whatever
        // follows (usually the title) sits close under the properties.
        '& > .ezco-mde-front-matter + *': {
            'margin-top': '0.75rem',
        },
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
        // `border-box` so the JS-set `height` is the *total* rendered
        // height (including padding-top and padding-bottom) — without
        // it, the indicator's border-right would extend past the
        // block's bottom by the sum of top + bottom padding.
        'box-sizing': 'border-box',
        // Inner padding leaves breathing room between the icon and the
        // right-edge border (the indicator line), even for the widest
        // glyphs we render (e.g. `</>`).
        'padding-top': 'var(--ezco-mde-block-action-icon-offset-y, 6px)',
        // `padding-bottom` constrains the sticky icon's containing
        // block, so the icon stops sticking with a visible gap above
        // the block's bottom — symmetric with the `top: 6px` gap on
        // the sticky pin line. Without this the icon stays glued to
        // the block's bottom right up until detachment, giving a
        // cramped "icon flush against the next block" feel.
        'padding-bottom': '7px',
        'padding-right': '8px',
        'padding-left': '2px',
        background: 'transparent',
        color: 'var(--ezco-mde-block-action-btn-color)',
        border: 'none',
        'border-right': '2px solid var(--ezco-mde-block-indicator-color)',
        // The indicator is a flat vertical line — never a rounded control.
        // `appearance: none` also strips the platform <button> focus ring,
        // which renders with rounded corners on macOS WebKit.
        'border-radius': 0,
        appearance: 'none',
        '-webkit-appearance': 'none',
        cursor: 'pointer',
        'font-family': 'var(--cm-font-family)',
        'font-size': '13px',
        'line-height': 1,
        // `padding-top` is intentionally NOT in this transition list:
        // it drives the icon's natural flow position, which the
        // sticky child reads to compute its stuck/unstuck state.
        // Animating it would mean the sticky calculation is fed a
        // value that's mid-tween, causing visible "stutter" or the
        // icon to appear stuck on a stale value after a reposition.
        transition:
            'top 120ms ease-out, height 120ms ease-out, opacity 120ms ease-out, background-color 120ms ease-out',
        'z-index': 5,
    },
    '.ezco-mde-block-action-btn:hover': {
        // No background change on hover — the indicator stays unobtrusive.
        // Brighten the indicator line and icon glyph instead so there's
        // still some visual feedback that the button is interactive.
        'border-right-color': 'rgba(120, 120, 120, 0.7)',
        color: 'rgba(80, 80, 80, 1)',
    },
    '.ezco-mde-block-action-btn-icon': {
        'pointer-events': 'none',
        // The icon stretches/squeezes its own width so multi-character
        // glyphs like `</>` don't push outside the padded area.
        'max-width': '100%',
        'text-align': 'center',
        // Native sticky: the icon stays in its flow position (which
        // the button's `padding-top` sets to the first-text-line
        // baseline) until scrolling would push it above the sticky
        // top from the viewport, at which point the browser pins it
        // there. Once the indicator button's bottom approaches the
        // pin line, the icon detaches and scrolls off with the
        // block. This is GPU-compositor-accelerated; doing the same
        // thing in JS (measure → set CSS variable → reflow on every
        // scroll frame) is visibly choppy.
        position: 'sticky',
        top: '6px',
    },
    // Codeblocks have their own sticky toolbar at the top of the
    // block. Align the indicator icon's stuck position with that
    // toolbar so they read as a single horizontal band when both are
    // pinned at the viewport top.
    '.ezco-mde-block-action-btn[data-block-type="ezcodeBlock"] .ezco-mde-block-action-btn-icon, .ezco-mde-block-action-btn[data-block-type="codeBlock"] .ezco-mde-block-action-btn-icon': {
        top: '6px',
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
        'box-shadow': 'var(--ezco-mde-chrome-shadow)',
        outline: 'none',
        // Sans-serif for the menu surface — the metaphor here is the
        // rich-text editor's affordances, not the code editor's.
        'font-family': 'var(--ezco-mde-chrome-font)',
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
    // macOS-style single highlight: only the *focused* item is coloured.
    // Pointer hover doesn't get its own `:hover` rule — instead the menu
    // moves DOM focus to the hovered item (see ContextMenu.buildDom's
    // `mouseenter` handler), so there's only ever one accented row whether
    // the user is arrowing with the keyboard or pointing with the mouse.
    '.ezco-mde-context-menu-item:focus, .ezco-mde-context-menu-item:focus-visible': {
        background: 'var(--ezco-mde-accent)',
        color: 'var(--ezco-mde-accent-fg)',
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
    '.ezco-mde-context-menu-item:focus .ezco-mde-context-menu-item-icon, .ezco-mde-context-menu-item:focus-visible .ezco-mde-context-menu-item-icon': {
        color: 'var(--ezco-mde-accent-fg)',
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
    // ─────────────────────────────────────────────────────────────
    // Slash command menu ("/" in the editor).
    //
    // Shares the rich-text context-menu palette (dark surface, light
    // sans-serif text) so it reads as part of the same family as the
    // block-action menu — and, unlike the previous hand-rolled CSS that
    // only lived in the dev app's App.css, it now ships with the library
    // so consumers get a styled, visible menu out of the box.
    // ─────────────────────────────────────────────────────────────
    '.tippy-box[data-theme~="ezco-mde-slash"]': {
        background: 'transparent',
        'box-shadow': 'none',
        padding: 0,
    },
    '.tippy-box[data-theme~="ezco-mde-slash"] .tippy-content': {
        padding: 0,
    },
    // ── Emoji picker (`:` trigger) — an OS-style searchable grid ──
    // Transparent tippy box so our surface shows through; the surface + accent
    // use the same context-menu vars as the other menus.
    '.tippy-box[data-theme~="ezco-mde-emoji"]': {
        background: 'transparent',
        'box-shadow': 'none',
        padding: 0,
    },
    '.tippy-box[data-theme~="ezco-mde-emoji"] .tippy-content': {
        padding: 0,
    },
    '.ezco-mde-emoji-menu': {
        width: 'max-content',
        padding: '6px',
        background: 'var(--ezco-mde-context-menu-bg)',
        color: 'var(--ezco-mde-context-menu-color)',
        border: '1px solid var(--ezco-mde-context-menu-border)',
        'border-radius': '8px',
        'box-shadow': 'var(--ezco-mde-chrome-shadow)',
        outline: 'none',
        'font-family': 'var(--ezco-mde-chrome-font)',
    },
    '.ezco-mde-emoji-grid': {
        display: 'grid',
        // Must match COLUMNS in emoji-picker.ts (2-D arrow navigation).
        'grid-template-columns': 'repeat(9, 1fr)',
        gap: '2px',
        'max-height': '232px',
        'overflow-y': 'auto',
    },
    '.ezco-mde-emoji-cell': {
        display: 'flex',
        'align-items': 'center',
        'justify-content': 'center',
        width: '32px',
        height: '32px',
        padding: 0,
        border: 'none',
        background: 'transparent',
        'border-radius': '6px',
        'font-size': '20px',
        'line-height': 1,
        cursor: 'pointer',
        'font-family': '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
    },
    // One cell lit at a time: the pointer moves the selection (see
    // emoji-picker.ts), so there is no separate hover colour.
    '.ezco-mde-emoji-cell.is-selected': {
        background: 'var(--ezco-mde-accent)',
    },
    '.ezco-mde-emoji-footer': {
        display: 'flex',
        'align-items': 'center',
        gap: '8px',
        padding: '6px 4px 2px',
        'margin-top': '4px',
        'border-top': '1px solid var(--ezco-mde-context-menu-border)',
        'font-size': '12px',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        'max-width': '312px',
    },
    '.ezco-mde-emoji-footer-glyph': {
        'font-size': '18px',
        'line-height': 1,
        flex: 'none',
        'font-family': '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
    },
    '.ezco-mde-emoji-footer-name': {
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        'white-space': 'nowrap',
    },
    // A reaction is picked from one row: the common ones, the recent ones,
    // and "…" for the whole grid, which then takes the popover's place.
    '.ezco-mde-reactions': {
        display: 'flex',
        'flex-wrap': 'wrap',
        'align-items': 'center',
        gap: '2px',
        'max-width': '320px',
        padding: '4px',
        background: 'var(--ezco-mde-context-menu-bg)',
        color: 'var(--ezco-mde-context-menu-color)',
        border: '1px solid var(--ezco-mde-context-menu-border)',
        'border-radius': '8px',
        'box-shadow': 'var(--ezco-mde-chrome-shadow)',
    },
    '.ezco-mde-reactions.is-full': {
        display: 'block',
        padding: 0,
        border: 0,
        background: 'transparent',
        'box-shadow': 'none',
    },
    '.ezco-mde-emoji-row': {
        display: 'flex',
        'flex-wrap': 'wrap',
        gap: '2px',
        'margin-bottom': '4px',
    },
    '.ezco-mde-emoji-more': {
        font: 'inherit',
        padding: '0 8px',
        height: '28px',
        border: 0,
        'border-radius': '4px',
        background: 'transparent',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        cursor: 'pointer',
    },
    '.ezco-mde-emoji-more:hover, .ezco-mde-emoji-more:focus-visible': {
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        color: 'var(--ezco-mde-fg)',
        outline: 'none',
    },
    '.ezco-mde-emoji-heading': {
        'font-size': '11px',
        'text-transform': 'uppercase',
        'letter-spacing': '0.06em',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        padding: '2px 4px',
    },
    '.ezco-mde-emoji-search': {
        display: 'block',
        width: '100%',
        'box-sizing': 'border-box',
        margin: '0 0 4px',
        padding: '4px 6px',
        font: 'inherit',
        'font-size': '13px',
        border: '1px solid var(--ezco-mde-context-menu-border)',
        'border-radius': '4px',
        background: 'transparent',
        color: 'inherit',
        outline: 'none',
    },
    '.ezco-mde-emoji-note': {
        padding: '10px 12px',
        'font-size': '13px',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        'font-family': 'var(--ezco-mde-chrome-font)',
    },
    // The `[[` note menu (extensions/wikilink.ts) shares the slash menu's look.
    '.ezco-mde-slash-menu, .ezco-mde-wikilink-menu': {
        display: 'flex',
        'flex-direction': 'column',
        gap: '1px',
        'min-width': '260px',
        'max-width': '340px',
        'max-height': '320px',
        'overflow-y': 'auto',
        padding: '5px',
        background: 'var(--ezco-mde-context-menu-bg)',
        color: 'var(--ezco-mde-context-menu-color)',
        border: '1px solid var(--ezco-mde-context-menu-border)',
        'border-radius': '8px',
        'box-shadow': 'var(--ezco-mde-chrome-shadow)',
        outline: 'none',
        'font-family': 'var(--ezco-mde-chrome-font)',
    },
    '.ezco-mde-slash-item': {
        display: 'flex',
        'align-items': 'center',
        gap: '11px',
        width: '100%',
        padding: '7px 9px',
        background: 'transparent',
        color: 'inherit',
        border: 'none',
        'border-radius': '6px',
        cursor: 'pointer',
        'text-align': 'left',
        'font-family': 'inherit',
        outline: 'none',
    },
    // macOS-style single highlight: only `.is-selected` is coloured, with the
    // same solid accent blue as the other dropdowns (block-action menu, search
    // toolbar). Hovering doesn't get its own `:hover` rule — the menu sets
    // `selectedIndex` to the hovered row on `mouseenter` (see slash-commands.ts),
    // so the keyboard and the pointer drive the *same* single highlight.
    // Because the row is two-line (title + description + an icon chip), the
    // selected state recolours each part to read on the blue fill.
    '.ezco-mde-slash-item.is-selected': {
        background: 'var(--ezco-mde-accent)',
    },
    '.ezco-mde-slash-item.is-selected .ezco-mde-slash-item-title': {
        color: 'var(--ezco-mde-accent-fg)',
    },
    '.ezco-mde-slash-item.is-selected .ezco-mde-slash-item-desc': {
        // The secondary line stays legible but recedes — a translucent white
        // (rather than full white) keeps the title/description hierarchy.
        color: 'var(--ezco-mde-accent-fg)',
        opacity: 0.8,
    },
    '.ezco-mde-slash-item.is-selected .ezco-mde-slash-item-icon': {
        // A translucent-white chip + white glyph reads cleanly on the blue,
        // instead of the dark-on-dark the resting chip colours would give.
        background: 'rgba(255, 255, 255, 0.22)',
        color: 'var(--ezco-mde-accent-fg)',
    },
    '.ezco-mde-slash-item-icon': {
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        width: '28px',
        height: '28px',
        flex: 'none',
        'border-radius': '5px',
        background: 'rgba(245, 245, 245, 0.06)',
        'font-size': '14px',
        'line-height': 1,
        color: 'var(--ezco-mde-context-menu-color)',
    },
    '.ezco-mde-slash-item-body': {
        display: 'flex',
        'flex-direction': 'column',
        gap: '1px',
        'min-width': 0,
        flex: 1,
    },
    '.ezco-mde-slash-item-title': {
        'font-size': '13px',
        'font-weight': 500,
        'line-height': 1.3,
        color: 'var(--ezco-mde-context-menu-color)',
    },
    '.ezco-mde-slash-item-desc': {
        'font-size': '11.5px',
        'line-height': 1.3,
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        'white-space': 'nowrap',
    },
    '.ezco-mde-slash-empty': {
        padding: '10px 12px',
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': '12.5px',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    // ─────────────────────────────────────────────────────────────
    // Selection menu — a small icon button anchored at the end of a
    // non-empty text selection. Focusable (Tab from the editor), opens
    // the contextual action menu on activation.
    // ─────────────────────────────────────────────────────────────
    '.ezco-mde-selection-menu-btn': {
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        // A short, wide pill suits the horizontal three-dot glyph and sits
        // just below the selection's end (positioned in JS).
        width: '28px',
        height: '20px',
        padding: 0,
        // Shares the menu surface var so all the floating chrome stays in one
        // palette; uses the themed text/border vars so the glyph stays legible
        // on the light surface (light mode) as well as the dark one.
        background: 'var(--ezco-mde-context-menu-bg)',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        border: '1px solid var(--ezco-mde-context-menu-border)',
        'border-radius': '6px',
        'box-shadow': '0 1px 4px rgba(0, 0, 0, 0.12)',
        cursor: 'pointer',
        // Over a code block's pinned toolbar (401), under the comments (500):
        // a selection ending just above a block still gets its menu.
        'z-index': 450,
        transition: 'background-color 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out, box-shadow 120ms ease-out, opacity 120ms ease-out',
    },
    '.ezco-mde-selection-menu-btn:hover': {
        // Opaque lift + full-contrast themed glyph — a deliberate hover state
        // instead of the previous see-through look.
        background: 'var(--ezco-mde-context-menu-bg-hover)',
        'border-color': 'var(--ezco-mde-context-menu-border)',
        color: 'var(--ezco-mde-context-menu-color)',
        'box-shadow': '0 2px 6px rgba(0, 0, 0, 0.16)',
    },
    // Clear, visible focus ring so the Tab landing point is obvious.
    '.ezco-mde-selection-menu-btn:focus, .ezco-mde-selection-menu-btn:focus-visible': {
        outline: '2px solid var(--ezco-mde-link-color)',
        'outline-offset': '2px',
        color: 'var(--ezco-mde-context-menu-color)',
    },
    // ─────────────────────────────────────────────────────────────
    // Inline link popover (extensions/link-menu.ts) — the editable URL card
    // shown when the caret is in a link (input + Save + Remove). Shares the
    // dark context-menu palette so it reads as part of the same family as the
    // block-action / selection menus. Both buttons are neutral (no coloured
    // "primary" fill).
    // ─────────────────────────────────────────────────────────────
    '.ezco-mde-link-popover': {
        display: 'flex',
        'align-items': 'center',
        gap: '2px',
        'max-width': '400px',
        padding: '4px 5px',
        background: 'var(--ezco-mde-context-menu-bg)',
        color: 'var(--ezco-mde-context-menu-color)',
        border: '1px solid var(--ezco-mde-context-menu-border)',
        'border-radius': '8px',
        'box-shadow': 'var(--ezco-mde-chrome-shadow)',
        outline: 'none',
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': '13px',
    },
    '.ezco-mde-link-popover-divider': {
        width: '1px',
        'align-self': 'stretch',
        margin: '4px 3px',
        background: 'var(--ezco-mde-context-menu-border)',
    },
    '.ezco-mde-link-popover-btn': {
        appearance: 'none',
        '-webkit-appearance': 'none',
        background: 'transparent',
        color: 'inherit',
        border: 'none',
        padding: '5px 9px',
        'border-radius': '5px',
        cursor: 'pointer',
        'font-family': 'inherit',
        'font-size': '12.5px',
        'line-height': 1.2,
        'white-space': 'nowrap',
    },
    '.ezco-mde-link-popover-btn:hover, .ezco-mde-link-popover-btn:focus-visible': {
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        outline: 'none',
    },
    '.ezco-mde-link-popover-input': {
        width: '250px',
        padding: '6px 9px',
        'border-radius': '6px',
        border: 'none',
        // border: '1px solid var(--ezco-mde-context-menu-border)',
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        color: 'var(--ezco-mde-context-menu-color)',
        'font-family': 'inherit',
        'font-size': '13px',
        outline: 'none',
    },
    '.ezco-mde-link-popover-input:focus': {
        'border-color': 'var(--ezco-mde-link-color)',
    },
    '.ezco-mde-link-popover-input::placeholder': {
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    // ─────────────────────────────────────────────────────────────
    // File-search / command toolbar (tagged `.ezco-mde-toolbar`).
    //
    // It renders OUTSIDE the editor body (see extensions/toolbar.ts), and the
    // default presentation is a self-contained, centred "omnibar" — a
    // rounded, bordered search field (à la Spotlight / a command palette)
    // with a matching results popover dropping beneath it. Styling is a
    // consumer concern, so everything visual is driven by
    // `--ezco-mde-toolbar-*` custom properties: override the variables (or
    // add your own class via the toolbar's `className` option) to retheme it
    // without fighting these rules. The codeblock package's own toolbar
    // lacks this class, so it's untouched.
    // ─────────────────────────────────────────────────────────────
    // A floating pill that sticks to the top of the editor's scroll area,
    // sized to its content (grows with the input), left-aligned with
    // transparent surroundings. Dark, matching the block-action / selection
    // menus so the whole family reads consistently. Auto-hide (toolbar.ts)
    // toggles the `-retracted` class below.
    '.cm-toolbar-panel.ezco-mde-toolbar': {
        // Re-point the codeblock toolbar/result colour vars at the menu
        // palette so the dropdown's text + icons are light on the dark
        // surface (they default to dark `:root` values otherwise — the cause
        // of black, invisible command-menu text). Hover keeps the same text
        // colour (only the row background changes), so icons never black out
        // and behave consistently with the file-type icons.
        '--cm-toolbar-color': 'var(--ezco-mde-context-menu-color)',
        '--cm-foreground': 'var(--ezco-mde-context-menu-color)',
        '--cm-command-result-color': 'var(--ezco-mde-context-menu-color)',
        '--cm-search-result-color': 'var(--ezco-mde-context-menu-color)',
        '--cm-search-result-color-hover': 'var(--ezco-mde-context-menu-color)',
        '--cm-search-result-color-selected': 'var(--ezco-mde-context-menu-color)',
        '--cm-search-result-bg-hover': 'var(--ezco-mde-context-menu-item-bg-hover)',
        '--cm-search-result-select-bg': 'var(--ezco-mde-context-menu-item-bg-hover)',
        'box-sizing': 'border-box',
        position: 'sticky',
        top: 'var(--ezco-mde-toolbar-top, 8px)',
        'z-index': 4,
        display: 'flex',
        'align-items': 'center',
        width: 'fit-content',
        'min-width': 'var(--ezco-mde-toolbar-min-width, 200px)',
        'max-width': 'calc(100% - 12px)',
        margin: 'var(--ezco-mde-toolbar-margin, 0 0 0 4px)',
        background: 'var(--ezco-mde-toolbar-bg, var(--ezco-mde-context-menu-bg))',
        color: 'var(--ezco-mde-toolbar-fg, var(--ezco-mde-context-menu-color))',
        border: 'var(--ezco-mde-toolbar-border, 1px solid var(--ezco-mde-context-menu-border))',
        'border-radius': 'var(--ezco-mde-toolbar-radius, 9px)',
        'box-shadow': 'var(--ezco-mde-toolbar-shadow, var(--ezco-mde-chrome-shadow))',
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': 'var(--ezco-mde-toolbar-font-size, var(--ezco-mde-text-xs))',
        padding: 'var(--ezco-mde-toolbar-pad-y, 6px) var(--ezco-mde-toolbar-pad-x, 11px)',
        transition: 'transform 160ms ease, opacity 160ms ease',
    },
    // Auto-hidden: slide up out of the way (no reflow) and ignore the pointer.
    '.cm-toolbar-panel.ezco-mde-toolbar.ezco-mde-toolbar-retracted': {
        transform: 'translateY(calc(-100% - var(--ezco-mde-toolbar-top, 8px) - 8px))',
        opacity: 0,
        'pointer-events': 'none',
    },
    // Tight, left-aligned search glyph + filename.
    '.ezco-mde-toolbar .cm-toolbar-state-icon-container': {
        width: 'auto',
        'min-width': '0',
    },
    '.ezco-mde-toolbar .cm-toolbar-state-icon': {
        width: 'auto',
        'min-width': '0',
        'font-size': 'var(--ezco-mde-toolbar-font-size, var(--ezco-mde-text-xs))',
        color: 'var(--ezco-mde-toolbar-muted, var(--ezco-mde-context-menu-item-color-muted))',
        'padding-right': '8px',
        'text-align': 'left',
    },
    '.ezco-mde-toolbar .cm-toolbar-input': {
        // The toolbar reads as a file/command field, so its input + results use
        // the editor's monospace (filepaths/commands line up like code) rather
        // than inheriting the panel's sans-serif.
        'font-family': 'var(--cm-font-family)',
        'font-size': 'var(--ezco-mde-toolbar-font-size, var(--ezco-mde-text-xs))',
        'font-weight': 400,
        color: 'var(--ezco-mde-toolbar-fg, var(--ezco-mde-context-menu-color))',
        background: 'transparent',
        padding: '0',
    },
    '.ezco-mde-toolbar .cm-toolbar-input::placeholder': {
        color: 'var(--ezco-mde-toolbar-muted, var(--ezco-mde-context-menu-item-color-muted))',
    },
    // Results dropdown — styled like the block-action / selection context
    // menus (dark surface, soft hover rows), dropping beneath the pill and
    // growing with its content.
    '.ezco-mde-toolbar .cm-search-results': {
        'font-family': 'var(--cm-font-family)',
        background: 'var(--ezco-mde-toolbar-popover-bg, var(--ezco-mde-context-menu-bg))',
        color: 'var(--ezco-mde-toolbar-fg, var(--ezco-mde-context-menu-color))',
        border: 'var(--ezco-mde-toolbar-popover-border, 1px solid var(--ezco-mde-context-menu-border))',
        'border-radius': '8px',
        'box-shadow': 'var(--ezco-mde-chrome-shadow)',
        left: '0',
        right: 'auto',
        width: 'max-content',
        'min-width': '100%',
        'max-width': '420px',
        'margin-top': '6px',
        padding: '4px',
        'max-height': '320px',
        overflow: 'hidden auto',
    },
    '.ezco-mde-toolbar .cm-search-result': {
        'font-family': 'var(--cm-font-family)',
        'align-items': 'center',
        'border-radius': '6px',
        padding: '6px 9px',
        'line-height': '1.4',
        color: 'inherit',
    },
    '.ezco-mde-toolbar .cm-search-result > .cm-search-result-icon-container': {
        width: 'auto',
        'min-width': '0',
    },
    '.ezco-mde-toolbar .cm-search-result > .cm-search-result-icon-container > .cm-search-result-icon': {
        width: 'auto',
        'min-width': '0',
        // Roomier gap between the result icon and its label. 1.5ch of padding
        // lands the *visible* glyph about a character clear of the text once
        // the icon glyph's own right-side bearing is accounted for.
        'padding-right': '1.5ch',
        'font-size': 'var(--ezco-mde-toolbar-font-size, var(--ezco-mde-text-xs))',
        'text-align': 'left',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    '.ezco-mde-toolbar .cm-search-result > .cm-search-result-label': {
        'font-size': 'var(--ezco-mde-toolbar-font-size, var(--ezco-mde-text-xs))',
        padding: '0',
    },
    // macOS-style single highlight: only the `.selected` row is coloured
    // (solid accent blue, matching the codeblock search dropdown). No
    // `:hover` rule — the toolbar moves `.selected` to the pointed-at row
    // on `mouseenter` (toolbar-core.ts), so pointer + keyboard share one
    // highlight instead of lighting up two rows.
    '.ezco-mde-toolbar .cm-search-result.selected': {
        'background-color': 'var(--ezco-mde-accent)',
    },
    '.ezco-mde-toolbar .cm-search-result.selected > .cm-search-result-label, .ezco-mde-toolbar .cm-search-result.selected > .cm-search-result-icon-container > .cm-search-result-icon': {
        color: 'var(--ezco-mde-accent-fg)',
    },
    // ─────────────────────────────────────────────────────────────
    // Document outline sidebar (extensions/sidebar.ts).
    //
    // Rendered OUTSIDE the editor body; the host lays it out (a left column in
    // a flex row by default — the library only inserts the node + supplies this
    // look). Themed via the shared `--ezco-mde-*` vars so it follows the
    // editor's light/dark mode. `position: sticky` is harmless when the parent
    // isn't a scroller (it just behaves static).
    // ─────────────────────────────────────────────────────────────
    '.ezco-mde-sidebar': {
        'box-sizing': 'border-box',
        flex: 'none',
        width: '220px',
        'align-self': 'flex-start',
        position: 'sticky',
        top: 0,
        'max-height': '100vh',
        'overflow-y': 'auto',
        padding: '0.5rem 0 0.5rem 0.7rem',
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': 'var(--ezco-mde-text-xs, 13px)',
        color: 'var(--ezco-mde-fg)',
        'user-select': 'none',
    },
    // Nothing to outline → take up no space.
    '.ezco-mde-sidebar.ezco-mde-sidebar--empty': {
        display: 'none',
    },
    '.ezco-mde-sidebar-title': {
        'font-size': '11px',
        'font-weight': 600,
        'text-transform': 'uppercase',
        'letter-spacing': '0.06em',
        opacity: 0.5,
        padding: '0 8px 8px',
    },
    '.ezco-mde-sidebar-list': {
        'list-style': 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        'flex-direction': 'column',
        gap: '1px',
    },
    '.ezco-mde-sidebar-item': {
        margin: 0,
        // Indent by heading depth (the view sets `--depth` inline).
        'padding-left': 'calc(var(--depth, 0) * 0.75rem)',
    },
    '.ezco-mde-sidebar-link': {
        display: 'block',
        padding: '3px 8px',
        'border-radius': '5px',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        'text-decoration': 'none',
        'line-height': 1.35,
        'white-space': 'nowrap',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
        cursor: 'pointer',
        transition: 'color 120ms ease, background-color 120ms ease',
    },
    '.ezco-mde-sidebar-link:hover': {
        color: 'var(--ezco-mde-fg)',
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
    },
    // Top-level headings read a touch stronger than nested ones.
    '.ezco-mde-sidebar-link[data-level="1"]': {
        'font-weight': 600,
        color: 'var(--ezco-mde-fg)',
    },
    // Current section — solid accent fill (the scrolled-to anchor stays blue
    // independent of where the pointer is).
    '.ezco-mde-sidebar-link.is-active': {
        color: 'var(--ezco-mde-accent-fg, #fff)',
        background: 'var(--ezco-mde-accent, #2490e9)',
    },
    // Outline entries mirror a heading's inline marks: `<strong>`/`<em>`/`<s>`
    // render via their natural styling; inline `code` gets the editor's
    // monospace chip so an `H1` with `inline code` reads the same in the list.
    '.ezco-mde-sidebar-link code': {
        'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        'font-size': '0.92em',
        background: 'var(--ezco-mde-code-bg, rgba(127, 127, 127, 0.16))',
        padding: '0.05em 0.3em',
        'border-radius': '3px',
    },
    // Keep inline code legible on the active (accent-filled) row.
    '.ezco-mde-sidebar-link.is-active code': {
        background: 'rgba(255, 255, 255, 0.22)',
        color: 'var(--ezco-mde-accent-fg, #fff)',
    },
    // ─────────────────────────────────────────────────────────────
    // Source on focus (extensions/source-view.ts): a node shows its rendered
    // preview until the caret is in it (`is-editing`), then its source.
    // ─────────────────────────────────────────────────────────────
    '.ezco-mde-source-view:not(.is-editing) > .ezco-mde-source-text': {
        display: 'none',
    },
    '.ezco-mde-source-view.is-editing > .ezco-mde-source-preview': {
        display: 'none',
    },
    '.ezco-mde-source-preview': {
        cursor: 'text',
    },
    '.ezco-mde-source-preview.is-empty': {
        opacity: 0.5,
        'font-style': 'italic',
    },
    '.ezco-mde-source-preview.is-invalid': {
        color: 'var(--ezco-mde-danger)',
    },
    '.ezco-mde-source-text': {
        'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
        'font-size': '0.9em',
    },

    // Front matter (extensions/front-matter.ts): a properties table; the YAML
    // when the caret is in it.
    '.ezco-mde-body .ezco-mde-front-matter': {
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': '13px',
    },
    // One small line at the top of the note: "▸ 2 properties" opens the
    // table, "▾ 2 properties" closes it, "Edit YAML" beside it shows the
    // source. Muted, in the chrome's type, and nothing else in it is a
    // control.
    '.ezco-mde-props-bar': {
        display: 'flex',
        'align-items': 'baseline',
        gap: '12px',
        padding: '0 0 4px',
    },
    '.ezco-mde-props-toggle, .ezco-mde-props-edit': {
        margin: 0,
        padding: 0,
        border: 0,
        background: 'transparent',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        font: 'inherit',
        'font-size': '11px',
        'letter-spacing': '0.04em',
        cursor: 'pointer',
    },
    '.ezco-mde-props-toggle:hover, .ezco-mde-props-toggle:focus-visible, .ezco-mde-props-edit:hover, .ezco-mde-props-edit:focus-visible': {
        color: 'var(--ezco-mde-fg)',
        outline: 'none',
    },
    '.ezco-mde-props-edit[hidden]': {
        display: 'none',
    },
    '.ezco-mde-body .ezco-mde-front-matter.is-collapsed .ezco-mde-props-host': {
        display: 'none',
    },
    '.ezco-mde-body .ezco-mde-front-matter:not(.is-collapsed) > .ezco-mde-source-preview': {
        'padding-bottom': '0.6rem',
        'border-bottom': '1px solid var(--ezco-mde-divider)',
    },
    '.ezco-mde-body .ezco-mde-front-matter > pre.ezco-mde-source-text': {
        margin: 0,
        padding: '0.5em 0.7em',
        background: 'var(--ezco-mde-code-bg)',
        'border-radius': '6px',
        'white-space': 'pre-wrap',
    },
    '.ezco-mde-props': {
        display: 'grid',
        'grid-template-columns': 'minmax(6em, max-content) 1fr',
        'column-gap': '1.2em',
        'row-gap': '0.25em',
    },
    '.ezco-mde-prop': {
        display: 'contents',
    },
    '.ezco-mde-prop-key': {
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        'white-space': 'nowrap',
    },
    '.ezco-mde-prop-value': {
        'overflow-wrap': 'anywhere',
    },
    '.ezco-mde-prop-value.is-empty, .ezco-mde-props-empty': {
        opacity: 0.5,
    },
    '.ezco-mde-prop-chip': {
        display: 'inline-block',
        margin: '0 0.35em 0.2em 0',
        padding: '0 0.5em',
        'border-radius': '999px',
        background: 'var(--ezco-mde-code-bg)',
    },
    '.ezco-mde-props-error': {
        color: 'var(--ezco-mde-danger)',
        'margin-bottom': '0.3em',
    },
    '.ezco-mde-props-raw': {
        margin: 0,
        'white-space': 'pre-wrap',
    },

    // Math (extensions/math.ts): typeset, and its TeX between its dollars when
    // the caret is in it.
    '.ezco-mde-body .ezco-mde-math-inline > .ezco-mde-source-text': {
        background: 'var(--ezco-mde-code-bg)',
        padding: '0.1em 0.2em',
        'border-radius': '3px',
    },
    '.ezco-mde-body .ezco-mde-math-inline > .ezco-mde-source-text::before, .ezco-mde-body .ezco-mde-math-inline > .ezco-mde-source-text::after': {
        content: '"$"',
        opacity: 0.45,
    },
    '.ezco-mde-body .ezco-mde-math-block > .ezco-mde-source-preview': {
        'text-align': 'center',
        'overflow-x': 'auto',
        padding: '0.25em 0',
    },
    '.ezco-mde-body .ezco-mde-math-block > pre.ezco-mde-source-text': {
        margin: 0,
        padding: '0.5em 0.7em',
        background: 'var(--ezco-mde-code-bg)',
        'border-radius': '6px',
        'white-space': 'pre-wrap',
    },
    '.ezco-mde-body .ezco-mde-math-block > pre.ezco-mde-source-text::before, .ezco-mde-body .ezco-mde-math-block > pre.ezco-mde-source-text::after': {
        content: '"$$"',
        display: 'block',
        opacity: 0.45,
    },

    // Footnotes (extensions/footnote.ts): references numbered by first use;
    // a definition with its number in a gutter.
    '.ezco-mde-body .ezco-mde-footnote-ref': {
        color: 'var(--ezco-mde-link-color)',
        cursor: 'pointer',
        'font-size': '0.7em',
        'line-height': 0,
        padding: '0 0.1em',
    },
    '.ezco-mde-body .ezco-mde-footnote-ref.is-missing': {
        color: 'var(--ezco-mde-danger)',
    },
    '.ezco-mde-body .ezco-mde-footnote-def': {
        display: 'flex',
        gap: '0.6em',
        'font-size': '0.9em',
    },
    '.ezco-mde-body .ezco-mde-footnote-def.is-unreferenced': {
        opacity: 0.7,
    },
    '.ezco-mde-footnote-label': {
        flex: 'none',
        'min-width': '1.5em',
        color: 'var(--ezco-mde-link-color)',
        cursor: 'pointer',
        'user-select': 'none',
    },
    '.ezco-mde-footnote-label::after': {
        content: '"."',
    },
    '.ezco-mde-footnote-body': {
        flex: 1,
        'min-width': 0,
    },
    '.ezco-mde-footnote-body > * + *': {
        'margin-top': '0.5em',
    },

    // Callouts (extensions/callout.ts): a tinted box in the kind's colour with
    // its icon; the title in the colour; a collapsed callout shows only it.
    '.ezco-mde-body .ezco-mde-callout': {
        position: 'relative',
        padding: '0.6em 0.9em 0.6em 2.4em',
        'border-left': '3px solid var(--ezco-mde-callout-color, #448aff)',
        'border-radius': '6px',
        background: 'color-mix(in srgb, var(--ezco-mde-callout-color, #448aff) 9%, transparent)',
    },
    '.ezco-mde-callout[data-callout-type="note"]': { '--ezco-mde-callout-color': '#448aff' },
    '.ezco-mde-callout[data-callout-type="note"] > .ezco-mde-callout-icon::before': { content: '"✎"' },
    '.ezco-mde-callout[data-callout-type="abstract"]': { '--ezco-mde-callout-color': '#00b0ff' },
    '.ezco-mde-callout[data-callout-type="abstract"] > .ezco-mde-callout-icon::before': { content: '"☰"' },
    '.ezco-mde-callout[data-callout-type="info"]': { '--ezco-mde-callout-color': '#00b8d4' },
    '.ezco-mde-callout[data-callout-type="info"] > .ezco-mde-callout-icon::before': { content: '"ℹ"' },
    '.ezco-mde-callout[data-callout-type="todo"]': { '--ezco-mde-callout-color': '#448aff' },
    '.ezco-mde-callout[data-callout-type="todo"] > .ezco-mde-callout-icon::before': { content: '"☐"' },
    '.ezco-mde-callout[data-callout-type="tip"]': { '--ezco-mde-callout-color': '#00bfa5' },
    '.ezco-mde-callout[data-callout-type="tip"] > .ezco-mde-callout-icon::before': { content: '"✦"' },
    '.ezco-mde-callout[data-callout-type="success"]': { '--ezco-mde-callout-color': '#00c853' },
    '.ezco-mde-callout[data-callout-type="success"] > .ezco-mde-callout-icon::before': { content: '"✓"' },
    '.ezco-mde-callout[data-callout-type="question"]': { '--ezco-mde-callout-color': '#64dd17' },
    '.ezco-mde-callout[data-callout-type="question"] > .ezco-mde-callout-icon::before': { content: '"?"' },
    '.ezco-mde-callout[data-callout-type="warning"]': { '--ezco-mde-callout-color': '#ff9100' },
    '.ezco-mde-callout[data-callout-type="warning"] > .ezco-mde-callout-icon::before': { content: '"⚠"' },
    '.ezco-mde-callout[data-callout-type="failure"]': { '--ezco-mde-callout-color': '#ff5252' },
    '.ezco-mde-callout[data-callout-type="failure"] > .ezco-mde-callout-icon::before': { content: '"✗"' },
    '.ezco-mde-callout[data-callout-type="danger"]': { '--ezco-mde-callout-color': '#ff1744' },
    '.ezco-mde-callout[data-callout-type="danger"] > .ezco-mde-callout-icon::before': { content: '"⚡"' },
    '.ezco-mde-callout[data-callout-type="bug"]': { '--ezco-mde-callout-color': '#f50057' },
    '.ezco-mde-callout[data-callout-type="bug"] > .ezco-mde-callout-icon::before': { content: '"✱"' },
    '.ezco-mde-callout[data-callout-type="example"]': { '--ezco-mde-callout-color': '#7c4dff' },
    '.ezco-mde-callout[data-callout-type="example"] > .ezco-mde-callout-icon::before': { content: '"☷"' },
    '.ezco-mde-callout[data-callout-type="quote"]': { '--ezco-mde-callout-color': '#9e9e9e' },
    '.ezco-mde-callout[data-callout-type="quote"] > .ezco-mde-callout-icon::before': { content: '"❝"' },
    '.ezco-mde-callout-icon': {
        position: 'absolute',
        left: '0.55em',
        top: '0.55em',
        width: '1.4em',
        height: '1.4em',
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--ezco-mde-callout-color, #448aff)',
        cursor: 'pointer',
        font: 'inherit',
        'line-height': 1.4,
    },
    '.ezco-mde-callout-fold': {
        position: 'absolute',
        right: '0.5em',
        top: '0.55em',
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--ezco-mde-callout-color, #448aff)',
        cursor: 'pointer',
        transition: 'transform 120ms ease',
    },
    '.ezco-mde-callout-fold::before': {
        content: '"▾"',
    },
    '.ezco-mde-callout.is-collapsed > .ezco-mde-callout-fold': {
        transform: 'rotate(-90deg)',
    },
    '.ezco-mde-callout.is-collapsed > .ezco-mde-callout-content > :not(.ezco-mde-callout-title)': {
        display: 'none',
    },
    '.ezco-mde-body .ezco-mde-callout-title': {
        color: 'var(--ezco-mde-callout-color, #448aff)',
        'font-weight': 600,
    },
    '.ezco-mde-body .ezco-mde-callout-title:has(> br.ProseMirror-trailingBreak:only-child)::before': {
        content: 'var(--ezco-mde-callout-default-title)',
        opacity: 0.8,
        'pointer-events': 'none',
    },
    '.ezco-mde-callout-content > * + *': {
        'margin-top': '0.4em',
    },
    // Images (extensions/image.ts) and embeds (extensions/embed.ts).
    '.ezco-mde-image': {
        display: 'inline-block',
        'max-width': '100%',
        'vertical-align': 'bottom',
    },
    '.ezco-mde-image > img, .ezco-mde-embed--image > img': {
        display: 'block',
        'max-width': '100%',
        'border-radius': '4px',
    },
    '.ezco-mde-image.is-missing::before': {
        content: '"⚠ " attr(data-missing)',
        display: 'inline-block',
        padding: '0.3em 0.6em',
        'border-radius': '4px',
        'font-size': '0.85em',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        background: 'var(--ezco-mde-code-bg)',
    },
    '.ProseMirror-selectednode.ezco-mde-image > img, .ProseMirror-selectednode.ezco-mde-embed': {
        outline: '2px solid var(--ezco-mde-accent)',
        'outline-offset': '2px',
    },
    '.ezco-mde-embed': {
        display: 'inline-block',
        'max-width': '100%',
        'vertical-align': 'bottom',
    },
    '.ezco-mde-embed--note': {
        display: 'block',
        margin: '0.3em 0',
        padding: '0.4em 0 0.4em 0.9em',
        'border-left': '3px solid var(--ezco-mde-divider)',
    },
    // A quoted passage (what a comment is about): the passage in the
    // note's muted colour, its note named above it.
    '.ezco-mde-embed--passage .ezco-mde-embed-content': {
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    '.ezco-mde-embed--passage.is-orphaned .ezco-mde-embed-content': {
        'font-style': 'italic',
    },
    '.ezco-mde-embed-header': {
        display: 'block',
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': '12px',
        'margin-bottom': '0.3em',
    },
    '.ezco-mde-embed-open': {
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--ezco-mde-link-color)',
        font: 'inherit',
        cursor: 'pointer',
    },
    '.ezco-mde-embed-card': {
        display: 'inline-block',
        margin: 0,
        padding: '0.2em 0.6em',
        'border-radius': '4px',
        background: 'var(--ezco-mde-code-bg)',
    },
    '.ezco-mde-embed.is-missing .ezco-mde-embed-open': {
        opacity: 0.6,
    },
    '.ezco-mde-embed-content > * + *': {
        'margin-top': '0.6em',
    },
    '.ezco-mde-embed-content > :first-child': {
        'margin-top': 0,
    },
    // ─────────────────────────────────────────────────────────────
    // Controls shared by the chrome the note grows (the conflict notice,
    // comment cards, the prose-action panel): a quiet text button that
    // takes a fill on hover, `is-primary` filled with the accent for the one
    // thing a card is for, `is-quiet` in the muted colour, `is-danger` in the
    // danger colour; and a field, the note's surface inside a hairline that
    // takes the accent while it is written in.
    // ─────────────────────────────────────────────────────────────
    '.ezco-mde-comment-button, .ezco-mde-conflict-button, .ezco-mde-ai-button': {
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        font: 'inherit',
        'font-size': '12.5px',
        'font-weight': 500,
        'line-height': 1.2,
        padding: '5px 10px',
        border: '1px solid transparent',
        'border-radius': '5px',
        background: 'transparent',
        color: 'inherit',
        'white-space': 'nowrap',
        cursor: 'pointer',
        transition: 'background-color 120ms ease-out, color 120ms ease-out',
    },
    '.ezco-mde-comment-button:hover, .ezco-mde-conflict-button:hover, .ezco-mde-ai-button:hover': {
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        color: 'var(--ezco-mde-fg)',
    },
    '.ezco-mde-comment-button:focus-visible, .ezco-mde-conflict-button:focus-visible, .ezco-mde-ai-button:focus-visible': {
        outline: '2px solid var(--ezco-mde-accent)',
        'outline-offset': '1px',
    },
    '.ezco-mde-comment-button:disabled, .ezco-mde-conflict-button:disabled, .ezco-mde-ai-button:disabled': {
        opacity: 0.4,
        cursor: 'default',
        background: 'transparent',
        color: 'inherit',
    },
    '.ezco-mde-comment-button.is-quiet, .ezco-mde-conflict-button.is-quiet, .ezco-mde-ai-button.is-quiet': {
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    '.ezco-mde-comment-button.is-link, .ezco-mde-conflict-button.is-link, .ezco-mde-ai-button.is-link': {
        color: 'var(--ezco-mde-link-color)',
    },
    '.ezco-mde-comment-button.is-link:hover, .ezco-mde-conflict-button.is-link:hover, .ezco-mde-ai-button.is-link:hover': {
        color: 'var(--ezco-mde-link-color-hover)',
    },
    '.ezco-mde-comment-button.is-danger, .ezco-mde-conflict-button.is-danger, .ezco-mde-ai-button.is-danger': {
        color: 'var(--ezco-mde-danger)',
    },
    '.ezco-mde-comment-button.is-primary, .ezco-mde-conflict-button.is-primary, .ezco-mde-ai-button.is-primary': {
        background: 'var(--ezco-mde-accent)',
        color: 'var(--ezco-mde-accent-fg)',
    },
    '.ezco-mde-comment-button.is-primary:hover, .ezco-mde-conflict-button.is-primary:hover, .ezco-mde-ai-button.is-primary:hover': {
        background: 'color-mix(in srgb, var(--ezco-mde-accent) 86%, var(--ezco-mde-accent-fg))',
        color: 'var(--ezco-mde-accent-fg)',
    },
    '.ezco-mde-comment-button.is-primary:disabled, .ezco-mde-conflict-button.is-primary:disabled, .ezco-mde-ai-button.is-primary:disabled': {
        background: 'var(--ezco-mde-accent)',
        color: 'var(--ezco-mde-accent-fg)',
    },
    '.ezco-mde-comment-input, .ezco-mde-ai-ask': {
        'box-sizing': 'border-box',
        border: '1px solid var(--ezco-mde-divider)',
        'border-radius': '6px',
        background: 'var(--ezco-mde-bg)',
        color: 'var(--ezco-mde-fg)',
        transition: 'border-color 120ms ease-out, box-shadow 120ms ease-out',
    },
    '.ezco-mde-comment-input:focus-within, .ezco-mde-ai-ask:focus': {
        'border-color': 'var(--ezco-mde-accent)',
        'box-shadow': '0 0 0 3px color-mix(in srgb, var(--ezco-mde-accent) 18%, transparent)',
        outline: 'none',
    },
    // ─────────────────────────────────────────────────────────────
    // Prose actions (extensions/prose-ai.ts): the answer's panel, floated
    // under the text it is about in the chrome's look (the menus' surface,
    // border and shadow), and that text lit in the accent while it is
    // being worked on.
    // ─────────────────────────────────────────────────────────────
    '.ezco-mde-ai': {
        position: 'absolute',
        'z-index': 20,
        width: 'min(400px, 100%)',
        'box-sizing': 'border-box',
        padding: '10px 12px 12px',
        'border-radius': '8px',
        border: '1px solid var(--ezco-mde-context-menu-border)',
        background: 'var(--ezco-mde-context-menu-bg)',
        color: 'var(--ezco-mde-fg)',
        'box-shadow': 'var(--ezco-mde-chrome-shadow)',
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': '13px',
        'line-height': 1.5,
    },
    '.ezco-mde-ai[hidden]': {
        display: 'none',
    },
    // The action's name, as a panel names itself.
    '.ezco-mde-ai-title': {
        'font-size': '11px',
        'font-weight': 600,
        'text-transform': 'uppercase',
        'letter-spacing': '0.06em',
        opacity: 0.5,
        'margin-bottom': '6px',
    },
    '.ezco-mde-ai-ask': {
        display: 'block',
        width: '100%',
        margin: '0 0 8px',
        padding: '6px 9px',
        font: 'inherit',
    },
    '.ezco-mde-ai-ask[hidden]': {
        display: 'none',
    },
    '.ezco-mde-ai-ask::placeholder': {
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    '.ezco-mde-ai-output': {
        'white-space': 'pre-wrap',
        'overflow-wrap': 'anywhere',
        'max-height': '16em',
        overflow: 'auto',
        'font-size': '13.5px',
    },
    '.ezco-mde-ai-output:empty': {
        display: 'none',
    },
    '.ezco-mde-ai-note': {
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        'font-size': '12px',
        'margin-top': '4px',
    },
    '.ezco-mde-ai-note:empty': {
        display: 'none',
    },
    '.ezco-mde-ai-actions': {
        display: 'flex',
        'justify-content': 'flex-end',
        gap: '4px',
        'margin-top': '10px',
    },
    '.ezco-mde-ai-target': {
        background: 'color-mix(in srgb, var(--ezco-mde-accent) 16%, transparent)',
        'border-radius': '2px',
    },
    '.ezco-mde-ai-caret': {
        display: 'inline-block',
        width: '2px',
        height: '1em',
        'vertical-align': 'text-bottom',
        background: 'var(--ezco-mde-accent)',
    },
    // ─────────────────────────────────────────────────────────────
    // Conflict notice (extensions/conflict-notice.ts): one line above the
    // note in the chrome's type, tinted and ruled like a warning callout,
    // with the way to the copy as a text button.
    // ─────────────────────────────────────────────────────────────
    '.ezco-mde-conflict': {
        display: 'flex',
        'flex-wrap': 'wrap',
        'align-items': 'center',
        gap: '4px 12px',
        margin: '8px 0 12px',
        padding: '7px 6px 7px 12px',
        'border-left': '3px solid var(--ezco-mde-warning)',
        'border-radius': '6px',
        background: 'color-mix(in srgb, var(--ezco-mde-warning) 9%, transparent)',
        color: 'var(--ezco-mde-fg)',
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': '13px',
        'line-height': 1.45,
    },
    '.ezco-mde-conflict[hidden]': {
        display: 'none',
    },
    '.ezco-mde-conflict-message': {
        flex: '1 1 20em',
    },
    // ─────────────────────────────────────────────────────────────
    // Comments (extensions/comments.ts, comment-margin.ts): commented text,
    // and the cards beside or over the note.
    //
    // A card is chrome: the menus' type, surface and border, and over the
    // note their shadow too. The comment's text inside it is the note's
    // (its content styles and, from the host, its face) at a size for a
    // card, the same whether read or written.
    // ─────────────────────────────────────────────────────────────
    // ─────────────────────────────────────────────────────────────
    // Comments (extensions/comments.ts, comment-margin.ts): commented text
    // in the note, and the cards that show the comments, in the chrome's
    // type and palette; a comment's own text in the note's.
    // ─────────────────────────────────────────────────────────────
    // Commented text: a tint of the comment colour, deeper for the one
    // looked at, deeper again where two comments overlap.
    '.ezco-mde-comment': {
        background: 'color-mix(in srgb, var(--ezco-mde-comment-color) 22%, transparent)',
        'border-bottom': '2px solid color-mix(in srgb, var(--ezco-mde-comment-color) 55%, transparent)',
    },
    '.ezco-mde-comment-stack': {
        background: 'color-mix(in srgb, var(--ezco-mde-comment-color) 40%, transparent)',
    },
    '.ezco-mde-comment.is-active': {
        background: 'color-mix(in srgb, var(--ezco-mde-comment-color) 42%, transparent)',
    },
    '.ezco-mde-comment.is-active.ezco-mde-comment-stack': {
        background: 'color-mix(in srgb, var(--ezco-mde-comment-color) 60%, transparent)',
    },
    // A resolved comment keeps a quiet mark, so it can be found and reopened.
    '.ezco-mde-comment.is-resolved:not(.is-active)': {
        background: 'transparent',
        'border-bottom': '1px dotted var(--ezco-mde-context-menu-item-color-muted)',
    },
    // Text a comment is being written about: the accent. A draft's, the
    // accent dashed: only this browser has it.
    '.ezco-mde-comment.is-draft': {
        background: 'color-mix(in srgb, var(--ezco-mde-accent) 20%, transparent)',
        'border-bottom-color': 'var(--ezco-mde-accent)',
    },
    '.ezco-mde-comment.is-pending': {
        background: 'color-mix(in srgb, var(--ezco-mde-accent) 12%, transparent)',
        'border-bottom': '2px dashed color-mix(in srgb, var(--ezco-mde-accent) 70%, transparent)',
    },
    '.ezco-mde-comments': {
        flex: 'none',
        'min-width': 0,
        position: 'relative',
    },
    '.ezco-mde-comment-margin': {
        position: 'relative',
        width: '360px',
        'box-sizing': 'border-box',
        padding: '0 12px 24px 8px',
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': '13px',
        'line-height': 1.5,
        color: 'var(--ezco-mde-fg)',
    },
    '.ezco-mde-comment-margin[hidden]': {
        display: 'none',
    },
    // The column's head, as a panel's title.
    '.ezco-mde-comment-margin-head': {
        display: 'flex',
        'justify-content': 'space-between',
        'align-items': 'baseline',
        gap: '8px',
        padding: '4px 2px 8px',
    },
    '.ezco-mde-comment-margin-title': {
        'font-size': '11px',
        'font-weight': 600,
        'text-transform': 'uppercase',
        'letter-spacing': '0.06em',
        opacity: 0.5,
    },
    '.ezco-mde-comment-margin-head .ezco-mde-comment-link': {
        'font-size': '12px',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    '.ezco-mde-comment-margin-head .ezco-mde-comment-link:hover': {
        color: 'var(--ezco-mde-fg)',
    },
    // The note's drafts: how many, and the two things to do with them all.
    '.ezco-mde-comment-drafts': {
        display: 'flex',
        'align-items': 'center',
        gap: '4px',
        width: 'max-content',
        'max-width': '100%',
        'box-sizing': 'border-box',
        margin: '0 0 8px',
        padding: '3px 4px 3px 10px',
        'border-radius': '999px',
        border: '1px solid var(--ezco-mde-context-menu-border)',
        background: 'var(--ezco-mde-context-menu-bg)',
        'font-size': '12px',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    '.ezco-mde-comment-drafts[hidden]': {
        display: 'none',
    },
    '.ezco-mde-comment-drafts-count': {
        'font-weight': 500,
        color: 'var(--ezco-mde-fg)',
        'margin-right': '4px',
    },
    '.ezco-mde-comment-list': {
        position: 'relative',
    },
    // A card: the chrome's surface, holding one comment's messages.
    '.ezco-mde-comment-card': {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        display: 'flex',
        'flex-direction': 'column',
        'box-sizing': 'border-box',
        'border-radius': '10px',
        border: '1px solid var(--ezco-mde-context-menu-border)',
        background: 'var(--ezco-mde-context-menu-bg)',
        outline: 'none',
    },
    // The card's content, which scrolls when there is more than fits.
    '.ezco-mde-comment-inside': {
        flex: '1 1 auto',
        'min-height': 0,
        'overflow-y': 'auto',
        'overflow-x': 'hidden',
        padding: '10px 12px',
    },
    // The comment's text: the note's content styles, at a size for a card,
    // the same whether shown or being edited.
    '.ezco-mde-comment-card .ezco-mde-body': {
        flex: 'none',
        'font-size': '14px',
        'line-height': 1.5,
        padding: 0,
        margin: 0,
        'max-width': 'none',
        'min-height': 0,
    },
    '.ezco-mde-comment-card .ezco-mde-body > :first-child': {
        'margin-top': 0,
    },
    '.ezco-mde-comment-card .ezco-mde-body > :last-child': {
        'margin-bottom': 0,
    },
    '.ezco-mde-comment-card[hidden]': {
        display: 'none',
    },
    // In a column, the card being looked at is told from the others by a
    // border in the accent; over the note there is only one.
    '.ezco-mde-comment-card.is-active': {
        'z-index': 2,
    },
    '.ezco-mde-comment-margin:not(.is-floating) .ezco-mde-comment-card.is-active': {
        'border-color': 'color-mix(in srgb, var(--ezco-mde-accent) 55%, transparent)',
    },
    '.ezco-mde-comment-card.is-resolved:not(.is-active)': {
        opacity: 0.7,
    },
    '.ezco-mde-comment-card:focus-visible': {
        outline: '2px solid color-mix(in srgb, var(--ezco-mde-accent) 55%, transparent)',
        'outline-offset': '1px',
    },
    // A message: who and when, the bubble, the row under it, its thread.
    // The reader's own stand on the right, as a conversation's do.
    '.ezco-mde-comment-message': {
        position: 'relative',
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'flex-start',
        'min-width': 0,
    },
    '.ezco-mde-comment-message.is-mine': {
        'align-items': 'flex-end',
    },
    '.ezco-mde-comment-message + .ezco-mde-comment-message': {
        'margin-top': '10px',
    },
    '.ezco-mde-comment-context[hidden]': {
        display: 'none',
    },
    '.ezco-mde-comment-head': {
        display: 'flex',
        'align-items': 'baseline',
        'flex-wrap': 'wrap',
        gap: '2px 6px',
        margin: '0 8px 3px',
        'font-size': '12px',
        'line-height': 1.3,
    },
    '.ezco-mde-comment-author': {
        'font-weight': 600,
    },
    '.ezco-mde-comment-time': {
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    // "Resolved" and "Draft", as chips in the chrome's neutral fill; a
    // draft's in the accent, dashed, as its text in the note.
    '.ezco-mde-comment-status': {
        padding: '0 7px',
        'border-radius': '999px',
        'font-size': '11px',
        'font-weight': 500,
        'line-height': '17px',
        background: 'var(--ezco-mde-code-bg)',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    '.ezco-mde-comment-status.is-pending': {
        border: '1px dashed color-mix(in srgb, var(--ezco-mde-accent) 60%, transparent)',
        'line-height': '15px',
        background: 'color-mix(in srgb, var(--ezco-mde-accent) 10%, transparent)',
        color: 'var(--ezco-mde-fg)',
    },
    // The bubble: the text on the chrome's neutral fill, the reader's own
    // on the accent's; the corner by the byline squared a little.
    '.ezco-mde-comment-bubble': {
        'max-width': '100%',
        'box-sizing': 'border-box',
        padding: '7px 11px',
        'border-radius': '14px',
        'border-top-left-radius': '4px',
        background: 'var(--ezco-mde-code-bg)',
        'overflow-wrap': 'anywhere',
    },
    '.ezco-mde-comment-message.is-mine > .ezco-mde-comment-bubble': {
        'border-radius': '14px',
        'border-top-right-radius': '4px',
        background: 'color-mix(in srgb, var(--ezco-mde-accent) 14%, transparent)',
    },
    '.ezco-mde-comment-message.is-pending > .ezco-mde-comment-bubble': {
        border: '1px dashed color-mix(in srgb, var(--ezco-mde-accent) 60%, transparent)',
        background: 'color-mix(in srgb, var(--ezco-mde-accent) 8%, transparent)',
    },
    // Being edited: the composer stands where the bubble was.
    '.ezco-mde-comment-bubble.is-editing': {
        width: '100%',
        padding: 0,
        border: 0,
        background: 'transparent',
    },
    '.ezco-mde-comment-bubble.is-editing > .ezco-mde-comment-composer': {
        'margin-top': 0,
    },
    '.ezco-mde-comment-deleted': {
        'font-style': 'italic',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    // Under the bubble, one quiet row in the chrome's muted colour: the
    // reactions, React, how many replies, "…". A deletion is asked about
    // in the same row.
    '.ezco-mde-comment-under': {
        display: 'flex',
        'align-items': 'center',
        'flex-wrap': 'wrap',
        gap: '2px 4px',
        margin: '3px 4px 0',
        'min-height': '24px',
        'font-size': '12.5px',
    },
    '.ezco-mde-comment-action': {
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        font: 'inherit',
        'font-weight': 500,
        padding: '3px 6px',
        border: 0,
        'border-radius': '5px',
        background: 'transparent',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        cursor: 'pointer',
        transition: 'background-color 120ms ease-out, color 120ms ease-out',
    },
    '.ezco-mde-comment-action:hover, .ezco-mde-comment-action:focus-visible': {
        color: 'var(--ezco-mde-fg)',
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        outline: 'none',
    },
    '.ezco-mde-comment-action:disabled': {
        cursor: 'default',
        background: 'transparent',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    '.ezco-mde-comment-action.is-icon': {
        width: '24px',
        height: '24px',
        padding: 0,
    },
    '.ezco-mde-comment-action.is-icon > svg, .ezco-mde-comment-action.is-replies > svg': {
        display: 'block',
    },
    '.ezco-mde-comment-action.is-replies': {
        gap: '5px',
        padding: '3px 7px 3px 5px',
    },
    '.ezco-mde-comment-action.is-replies[aria-expanded="true"]': {
        color: 'var(--ezco-mde-fg)',
    },
    '.ezco-mde-comment-action.is-danger': {
        color: 'var(--ezco-mde-danger)',
    },
    '.ezco-mde-comment-action.is-primary': {
        background: 'var(--ezco-mde-accent)',
        color: 'var(--ezco-mde-accent-fg, #fff)',
    },
    '.ezco-mde-comment-action.is-primary:hover, .ezco-mde-comment-action.is-primary:focus-visible': {
        background: 'color-mix(in srgb, var(--ezco-mde-accent) 85%, var(--ezco-mde-fg))',
        color: 'var(--ezco-mde-accent-fg, #fff)',
    },
    '.ezco-mde-comment-question': {
        color: 'var(--ezco-mde-fg)',
        'margin-right': '4px',
    },
    // The way out of a floating card, in its corner, level with the byline.
    '.ezco-mde-comment-tool': {
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        font: 'inherit',
        padding: 0,
        border: 0,
        'border-radius': '5px',
        background: 'transparent',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        cursor: 'pointer',
        transition: 'background-color 120ms ease-out, color 120ms ease-out',
    },
    '.ezco-mde-comment-tool:hover, .ezco-mde-comment-tool:focus-visible': {
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        color: 'var(--ezco-mde-fg)',
        outline: 'none',
    },
    '.ezco-mde-comment-tool.is-close': {
        position: 'absolute',
        top: '7px',
        right: '7px',
        width: '24px',
        height: '24px',
        'z-index': 1,
    },
    '.ezco-mde-comment-tool.is-close > svg': {
        display: 'block',
    },
    // The first byline, and an orphan notice, keep clear of the close button.
    '.ezco-mde-comment-margin.is-floating .ezco-mde-comment-messages > .ezco-mde-comment-message > .ezco-mde-comment-head, .ezco-mde-comment-margin.is-floating .ezco-mde-comment-orphan, .ezco-mde-comment-margin.is-floating .ezco-mde-comment-card.is-draft .ezco-mde-comment-head': {
        'padding-right': '26px',
    },
    // The fold of a reply's answers, as a news site folds threads.
    '.ezco-mde-comment-fold': {
        font: 'inherit',
        'font-size': '11px',
        padding: '0 2px',
        border: 0,
        'border-radius': '3px',
        background: 'none',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        cursor: 'pointer',
    },
    '.ezco-mde-comment-fold:hover, .ezco-mde-comment-fold:focus-visible': {
        color: 'var(--ezco-mde-fg)',
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        outline: 'none',
    },
    '.ezco-mde-comment-body': {
        'overflow-wrap': 'anywhere',
    },
    '.ezco-mde-comment-body pre': {
        'white-space': 'pre-wrap',
        padding: '4px 6px',
        'border-radius': '4px',
        background: 'var(--ezco-mde-code-bg)',
    },
    '.ezco-mde-comment-body [data-wikilink]': {
        color: 'var(--ezco-mde-link-color)',
        cursor: 'pointer',
    },
    // The thread under a message: its replies, indented under a hairline,
    // then the field for the next.
    '.ezco-mde-comment-thread': {
        'align-self': 'stretch',
        display: 'flex',
        'flex-direction': 'column',
        gap: '10px',
        margin: '8px 0 0 10px',
        'padding-left': '10px',
        'border-left': '2px solid var(--ezco-mde-divider)',
    },
    '.ezco-mde-comment-thread > .ezco-mde-comment-message + .ezco-mde-comment-message': {
        'margin-top': 0,
    },
    '.ezco-mde-comment-thread > .ezco-mde-comment-composer': {
        'margin-top': 0,
    },
    // The field for the next reply: a bubble's shape, quiet until used.
    '.ezco-mde-comment-reply-field': {
        'align-self': 'stretch',
        'text-align': 'left',
        font: 'inherit',
        'font-size': '13px',
        padding: '6px 11px',
        border: '1px solid var(--ezco-mde-divider)',
        'border-radius': '14px',
        background: 'transparent',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        cursor: 'text',
        transition: 'border-color 120ms ease-out, color 120ms ease-out',
    },
    '.ezco-mde-comment-reply-field:hover, .ezco-mde-comment-reply-field:focus-visible': {
        'border-color': 'var(--ezco-mde-context-menu-item-color-muted)',
        color: 'var(--ezco-mde-fg)',
        outline: 'none',
    },
    // A reaction: a small pill, filled with the accent when it is the reader's.
    '.ezco-mde-comment-reaction': {
        display: 'inline-flex',
        'align-items': 'center',
        gap: '4px',
        height: '22px',
        font: 'inherit',
        'font-size': '12px',
        padding: '0 8px',
        'border-radius': '999px',
        border: '1px solid var(--ezco-mde-divider)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        transition: 'background-color 120ms ease-out, border-color 120ms ease-out',
    },
    '.ezco-mde-comment-reaction:hover:not(:disabled)': {
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
    },
    '.ezco-mde-comment-reaction:disabled': {
        cursor: 'default',
    },
    '.ezco-mde-comment-reaction[aria-pressed="true"]': {
        'border-color': 'color-mix(in srgb, var(--ezco-mde-accent) 60%, transparent)',
        background: 'color-mix(in srgb, var(--ezco-mde-accent) 14%, transparent)',
    },
    // The rest of the reactions, behind "+n".
    '.ezco-mde-comment-reaction.is-more': {
        'border-style': 'dashed',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    '.ezco-mde-comment-link': {
        font: 'inherit',
        padding: 0,
        border: 0,
        background: 'none',
        color: 'var(--ezco-mde-link-color)',
        cursor: 'pointer',
    },
    '.ezco-mde-comment-link:hover': {
        color: 'var(--ezco-mde-link-color-hover)',
    },
    // What an orphaned comment pointed at, no longer in the note: a warning
    // in the callouts' manner.
    '.ezco-mde-comment-orphan': {
        'margin-bottom': '10px',
        padding: '6px 10px',
        'border-left': '3px solid var(--ezco-mde-warning)',
        'border-radius': '6px',
        background: 'color-mix(in srgb, var(--ezco-mde-warning) 9%, transparent)',
        'font-size': '12.5px',
    },
    '.ezco-mde-comment-orphan .ezco-mde-comment-link': {
        display: 'block',
        'margin-top': '2px',
    },
    '.ezco-mde-comment-quote': {
        'font-style': 'italic',
    },
    // The composer: a small editor of the note's make, its text growing
    // with what is written; taller when asked for; in its corner, the way
    // to the editor itself. Under it, Cancel, Draft, and the one filled
    // button, at the right.
    '.ezco-mde-comment-composer': {
        display: 'flex',
        'flex-direction': 'column',
        gap: '8px',
        'margin-top': '10px',
        'align-self': 'stretch',
    },
    '.ezco-mde-comment-composer.is-compact': {
        gap: '6px',
        'margin-top': '4px',
    },
    '.ezco-mde-comment-composer-label': {
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        'font-size': '12px',
    },
    '.ezco-mde-comment-composer-label[hidden]': {
        display: 'none',
    },
    '.ezco-mde-comment-input': {
        position: 'relative',
    },
    '.ezco-mde-comment-expand': {
        position: 'absolute',
        top: '5px',
        right: '5px',
        width: '24px',
        height: '24px',
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        padding: 0,
        border: 0,
        'border-radius': '5px',
        background: 'transparent',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        cursor: 'pointer',
        'z-index': 1,
        transition: 'background-color 120ms ease-out, color 120ms ease-out',
    },
    '.ezco-mde-comment-expand:hover, .ezco-mde-comment-expand:focus-visible': {
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        color: 'var(--ezco-mde-fg)',
        outline: 'none',
    },
    '.ezco-mde-comment-expand > svg': {
        display: 'block',
    },
    '.ezco-mde-comment-card .ezco-mde-comment-input.has-expand .ezco-mde-body.ezco-mde-comment-text': {
        'padding-right': '34px',
    },
    '.ezco-mde-comment-card .ezco-mde-comment-input .ezco-mde-body.ezco-mde-comment-text': {
        'min-height': '38px',
        'max-height': '40vh',
        'overflow-y': 'auto',
        padding: '8px 10px',
        outline: 'none',
        'overflow-wrap': 'anywhere',
    },
    '.ezco-mde-comment-composer.is-full .ezco-mde-comment-input .ezco-mde-body.ezco-mde-comment-text': {
        'min-height': '120px',
    },
    '.ezco-mde-comment-input .ezco-mde-comment-text > p': {
        margin: 0,
    },
    '.ezco-mde-comment-input .ezco-mde-comment-text > p + p, .ezco-mde-comment-input .ezco-mde-comment-text > ul, .ezco-mde-comment-input .ezco-mde-comment-text > ol': {
        'margin-top': '0.3em',
    },
    '.ezco-mde-comment-input .ezco-mde-comment-text p.is-empty:first-child::before': {
        content: 'attr(data-placeholder)',
        float: 'left',
        height: 0,
        'pointer-events': 'none',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    '.ezco-mde-comment-composer-actions': {
        display: 'flex',
        'justify-content': 'flex-end',
        'align-items': 'center',
        gap: '4px',
    },
    // Floating (the default, or a column with no room): over the note, the
    // thread being looked at at the note's edge, just under its text, with
    // the chrome's shadow to lift it off; the composer for a new comment by
    // the end of its text; the drafts in the note's top corner.
    '.ezco-mde-comment-margin.is-floating': {
        position: 'absolute',
        top: 0,
        left: '8px',
        right: '8px',
        width: 'auto',
        padding: 0,
        // Over everything in the note, code blocks' pinned toolbars included.
        'z-index': 500,
        // Over the note: only the cards themselves take clicks.
        'pointer-events': 'none',
    },
    '.ezco-mde-comment-margin.is-floating .ezco-mde-comment-margin-head': {
        display: 'none',
    },
    '.ezco-mde-comment-margin.is-floating .ezco-mde-comment-drafts': {
        position: 'absolute',
        top: 0,
        right: 0,
        margin: 0,
        'z-index': 3,
        'pointer-events': 'auto',
        'box-shadow': 'var(--ezco-mde-chrome-shadow)',
    },
    '.ezco-mde-comment-margin.is-floating .ezco-mde-comment-card': {
        'pointer-events': 'auto',
        left: 'auto',
        right: 0,
        width: 'min(400px, 100%)',
        'max-height': '80vh',
        'box-shadow': 'var(--ezco-mde-chrome-shadow)',
    },
    '.ezco-mde-comment-margin.is-floating .ezco-mde-comment-card.is-draft': {
        width: 'min(340px, 100%)',
    },
    // ─────────────────────────────────────────────────────────────
    // File tree (extensions/file-tree.ts): the vault's folders and files,
    // in the outline's type and palette.
    // ─────────────────────────────────────────────────────────────
    '.ezco-mde-files': {
        'box-sizing': 'border-box',
        width: '220px',
        // Stays in view as the note scrolls (harmless where the parent is not
        // a scroller), like the outline.
        position: 'sticky',
        top: 0,
        'align-self': 'flex-start',
        'max-height': '100vh',
        'overflow-y': 'auto',
        padding: '0.5rem 0 0.5rem 0.7rem',
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': '13px',
        color: 'var(--ezco-mde-fg)',
    },
    '.ezco-mde-files-header': {
        display: 'flex',
        'align-items': 'center',
        gap: '2px',
        padding: '0 4px 6px 0',
    },
    // The header opens and closes the tree: a disclosure triangle before the title.
    '.ezco-mde-files-toggle': {
        flex: 1,
        display: 'flex',
        'align-items': 'center',
        gap: '4px',
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        // Out into the margin, so the triangle hangs there as the folders' do
        // and the title lines up with the outline's.
        padding: '2px 4px',
        'margin-left': '-10px',
        'border-radius': '4px',
        cursor: 'pointer',
        'text-align': 'left',
    },
    '.ezco-mde-files-toggle::before': {
        content: "'▾'",
        'font-size': '10px',
        opacity: 0.5,
        width: '10px',
    },
    '.ezco-mde-files.is-collapsed .ezco-mde-files-toggle::before': {
        content: "'▸'",
    },
    '.ezco-mde-files-toggle:hover, .ezco-mde-files-toggle:focus-visible': {
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        outline: 'none',
    },
    '.ezco-mde-files.is-collapsed .ezco-mde-files-header': {
        'padding-bottom': 0,
    },
    '.ezco-mde-files-actions[hidden], .ezco-mde-files-list[hidden], .ezco-mde-files-status[hidden]': {
        display: 'none',
    },
    '.ezco-mde-files-title': {
        flex: 1,
        'font-size': '11px',
        'font-weight': 600,
        'text-transform': 'uppercase',
        'letter-spacing': '0.06em',
        opacity: 0.5,
    },
    '.ezco-mde-files-actions': {
        display: 'inline-flex',
        gap: '2px',
    },
    '.ezco-mde-files-action': {
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        width: '20px',
        height: '20px',
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        opacity: 0.55,
        cursor: 'pointer',
        font: 'inherit',
        'border-radius': '4px',
    },
    '.ezco-mde-files-action > svg': {
        display: 'block',
        width: '13px',
        height: '13px',
    },
    '.ezco-mde-files-action:hover, .ezco-mde-files-action:focus-visible': {
        opacity: 1,
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        outline: 'none',
    },
    '.ezco-mde-files-list': {
        'list-style': 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        'flex-direction': 'column',
        gap: '1px',
    },
    '.ezco-mde-files-item': {
        display: 'flex',
        'align-items': 'center',
        padding: '3px 8px',
        'padding-left': 'calc(8px + var(--depth, 0) * 0.9rem)',
        'border-radius': '5px',
        cursor: 'pointer',
        'white-space': 'nowrap',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        outline: 'none',
    },
    '.ezco-mde-files-item:hover, .ezco-mde-files-item:focus-visible': {
        color: 'var(--ezco-mde-fg)',
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
    },
    '.ezco-mde-files-item.is-current': {
        color: 'var(--ezco-mde-accent-fg, #fff)',
        background: 'var(--ezco-mde-accent, #2490e9)',
    },
    '.ezco-mde-files-item.is-confirming': {
        color: 'var(--ezco-mde-danger)',
    },
    '.ezco-mde-files-item.is-folder::before': {
        content: '"▸"',
        display: 'inline-block',
        width: '1em',
        'margin-left': '-1em',
        opacity: 0.6,
        transition: 'transform 120ms ease',
    },
    '.ezco-mde-files-item.is-folder[aria-expanded="true"]::before': {
        transform: 'rotate(90deg)',
    },
    '.ezco-mde-files-name': {
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
    },
    '.ezco-mde-files-rename': {
        width: '100%',
        font: 'inherit',
        padding: '0 2px',
        border: '1px solid var(--ezco-mde-accent, #2490e9)',
        'border-radius': '3px',
        background: 'var(--ezco-mde-bg, #fff)',
        color: 'var(--ezco-mde-fg)',
    },
    '.ezco-mde-files-empty, .ezco-mde-files-status': {
        padding: '4px 8px',
        opacity: 0.6,
    },
    '.ezco-mde-files-status:empty': {
        display: 'none',
    },
    // ─────────────────────────────────────────────────────────────
    // Links panel (extensions/links-panel.ts): what links to the open note,
    // and its links to notes not written yet. By default a footer under the
    // note, its text flush with the note's and each row's hover fill hanging
    // into the margins; hosts may mount it in a column. Same type and
    // palette as the outline.
    // ─────────────────────────────────────────────────────────────
    '.ezco-mde-links': {
        'box-sizing': 'border-box',
        'margin-top': '2.5rem',
        'padding-top': '0.75rem',
        'border-top': '1px solid var(--ezco-mde-divider)',
        'font-family': 'var(--ezco-mde-chrome-font)',
        'font-size': '13px',
        'line-height': 1.4,
        color: 'var(--ezco-mde-fg)',
    },
    '.ezco-mde-links.ezco-mde-links--empty': {
        display: 'none',
    },
    '.ezco-mde-links-title': {
        'font-size': '11px',
        'font-weight': 600,
        'text-transform': 'uppercase',
        'letter-spacing': '0.06em',
        opacity: 0.5,
        padding: '0 0 6px',
    },
    '.ezco-mde-links-dangling': {
        'margin-top': '0.25rem',
    },
    '.ezco-mde-links-list': {
        'list-style': 'none',
        margin: '0 -8px 0.75rem',
        padding: 0,
        display: 'flex',
        'flex-direction': 'column',
        gap: '1px',
    },
    '.ezco-mde-links-link': {
        display: 'flex',
        'align-items': 'baseline',
        gap: '8px',
        width: '100%',
        'min-width': 0,
        padding: '4px 8px',
        border: 'none',
        'border-radius': '5px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        'text-align': 'left',
        cursor: 'pointer',
        transition: 'background-color 120ms ease',
    },
    '.ezco-mde-links-link:hover, .ezco-mde-links-link:focus-visible': {
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
        outline: 'none',
    },
    '.ezco-mde-links-name': {
        color: 'var(--ezco-mde-link-color)',
        'white-space': 'nowrap',
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
    },
    '.ezco-mde-links-link:hover .ezco-mde-links-name': {
        color: 'var(--ezco-mde-link-color-hover)',
    },
    '.ezco-mde-links-dangling .ezco-mde-links-name': {
        opacity: 0.7,
    },
    '.ezco-mde-links-folder, .ezco-mde-links-meta': {
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
        'font-size': '12px',
        'white-space': 'nowrap',
    },
    '.ezco-mde-links-folder': {
        overflow: 'hidden',
        'text-overflow': 'ellipsis',
    },
    '.ezco-mde-links-meta': {
        flex: 'none',
    },
    '.ezco-mde-links-empty': {
        padding: '4px 8px',
        color: 'var(--ezco-mde-context-menu-item-color-muted)',
    },
    // Host for the standalone code editor swapped in for a non-prose file
    // (extensions/filesystem.ts) — it replaces the rich-text editable in flow,
    // and the codeblock's own `.cm-editor` fills it.
    '.ezco-mde-code-host': {
        display: 'flex',
        flex: 1,
    },
    '.ezco-mde-code-host .cm-editor': {
        'max-width': '100%',
    },
})