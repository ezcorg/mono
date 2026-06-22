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
        '.ezco-mde': {
            'padding-left': '4px',
        }
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
    '.ezco-mde': {

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
        'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.13), 0 1px 3px rgba(0, 0, 0, 0.07)',
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
    '.ezco-mde-slash-menu': {
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
        'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.13), 0 1px 3px rgba(0, 0, 0, 0.07)',
        outline: 'none',
        'font-family': 'Inter, system-ui, -apple-system, sans-serif',
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
        'font-family': 'Inter, system-ui, -apple-system, sans-serif',
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
        'z-index': 6,
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
        'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.13), 0 1px 3px rgba(0, 0, 0, 0.07)',
        outline: 'none',
        'font-family': 'Inter, system-ui, -apple-system, sans-serif',
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
        border: '1px solid var(--ezco-mde-context-menu-border)',
        background: 'rgba(255, 255, 255, 0.06)',
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
        'box-shadow': 'var(--ezco-mde-toolbar-shadow, 0 4px 16px rgba(0, 0, 0, 0.13), 0 1px 3px rgba(0, 0, 0, 0.07))',
        'font-family': 'Inter, system-ui, -apple-system, sans-serif',
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
        'font-family': 'inherit',
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
        'font-family': 'inherit',
        background: 'var(--ezco-mde-toolbar-popover-bg, var(--ezco-mde-context-menu-bg))',
        color: 'var(--ezco-mde-toolbar-fg, var(--ezco-mde-context-menu-color))',
        border: 'var(--ezco-mde-toolbar-popover-border, 1px solid var(--ezco-mde-context-menu-border))',
        'border-radius': '8px',
        'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.13), 0 1px 3px rgba(0, 0, 0, 0.07)',
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
        'font-family': 'inherit',
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
        'font-family': 'Inter, system-ui, -apple-system, sans-serif',
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
        color: 'var(--ezco-mde-context-menu-item-color-muted, rgba(120, 120, 120, 0.9))',
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
        background: 'var(--ezco-mde-context-menu-item-bg-hover, rgba(127, 127, 127, 0.1))',
    },
    // Top-level headings read a touch stronger than nested ones.
    '.ezco-mde-sidebar-link[data-level="1"]': {
        'font-weight': 600,
        color: 'var(--ezco-mde-fg)',
    },
    // Current section — solid accent fill (matches the other menus' highlight).
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
    // Host for the standalone code editor swapped in for a non-prose file
    // (extensions/filesystem.ts) — it replaces the rich-text editable in flow,
    // and the codeblock's own `.cm-editor` fills it.
    '.ezco-mde-code-host': {
        display: 'block',
        width: '100%',
    },
    '.ezco-mde-code-host .cm-editor': {
        'max-width': '100%',
    },
})