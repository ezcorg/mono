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
        '--ezco-mde-link-color': '#5861ff',
        '--ezco-mde-link-color-hover': '#383ea3',
        // Mid-grey so the indicator reads on both light and dark surfaces —
        // the block-action button renders OUTSIDE `.ezco-mde`, so it can't
        // pick up the editor's theme-scoped vars (the old near-white value
        // was invisible on a light editor).
        '--ezco-mde-block-indicator-color': 'rgba(120, 120, 120, 0.4)',
        '--ezco-mde-block-action-btn-color': 'rgba(120, 120, 120, 0.9)',
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
        // top-level spacing is owned by the `& > * + *` rules at the
        // bottom of this block.
        '& .tight': {
            'margin-left': '21px',
            'margin-right': '18px',
            '& li': {
                'padding-left': '2px',
            },
        },
        // List base — zero margin; vertical rhythm comes from the
        // sibling `+` rules. Font-size matches `& p` so converting a
        // paragraph to a list doesn't shift layout (also dodges the
        // browser default `margin-block-start: 1em` and the fact
        // that `1em` resolves differently on `<ul>` vs `<p>` when
        // they have different inherited font-sizes).
        '& ul, & ol, & menu': {
            padding: 0,
            margin: 0,
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-relaxed)',
        },
        // Dash lists (typed with `- `) render with a dash glyph instead of
        // the default disc, so they read distinctly from star lists
        // (`* `). Overriding the `::marker` content keeps the dash in the
        // same gutter the disc would occupy, auto-aligned with the first
        // line of each item.
        '& ul[data-marker="dash"] > li::marker': {
            content: '"–  "',
        },
        // Task list styles
        '& li[data-checked="true"]>div>p': {
            "text-decoration": "line-through",
            "color": "#888",
        },
        '& ul[data-type="taskList"]': {
            'list-style': 'none',
            'padding': 0,

            // Task-list items inherit the same "no inter-item margin"
            // baseline as bullet/ordered lists and paragraphs — the
            // top-only `& > * + *` rule below provides spacing where
            // it's needed (between top-level blocks). Within a list,
            // items stack with line-height rhythm.
            '& li': {
                display: 'flex',
                'align-items': 'flex-start',
            },

            '& li > label': {
                'margin-right': '6px',
            },
            '& li > label > input': {
                margin: 0,
                width: '0.8em',
                height: '0.8em',
            },
            '& li > div': {
                flex: 1
            }
        },
        // Make task checkboxes visible when selected (Ctrl-A).
        // Checkboxes don't natively show selection highlighting, so
        // add an outline using the system Highlight color.
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
        'box-shadow': '0 10px 28px rgba(0, 0, 0, 0.5)',
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
    // Selected (keyboard) and hover share one highlight so the active
    // row reads the same whether the user is arrowing or pointing.
    '.ezco-mde-slash-item.is-selected, .ezco-mde-slash-item:hover': {
        background: 'var(--ezco-mde-context-menu-item-bg-hover)',
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
        // Solid, slightly-lifted dark surface (not pure black) so hover can
        // read as a clear, opaque step up rather than a faint translucent
        // wash over nothing.
        background: '#1c1c20',
        color: 'rgba(245, 245, 245, 0.82)',
        border: '1px solid rgba(245, 245, 245, 0.18)',
        'border-radius': '6px',
        'box-shadow': '0 2px 8px rgba(0, 0, 0, 0.35)',
        cursor: 'pointer',
        'z-index': 6,
        transition: 'background-color 120ms ease-out, border-color 120ms ease-out, color 120ms ease-out, box-shadow 120ms ease-out, opacity 120ms ease-out',
    },
    '.ezco-mde-selection-menu-btn:hover': {
        // Opaque lift + brighter glyph/border — a deliberate hover state
        // instead of the previous see-through look.
        background: '#2c2c33',
        'border-color': 'rgba(245, 245, 245, 0.34)',
        color: '#ffffff',
        'box-shadow': '0 3px 10px rgba(0, 0, 0, 0.45)',
    },
    // Clear, visible focus ring so the Tab landing point is obvious.
    '.ezco-mde-selection-menu-btn:focus, .ezco-mde-selection-menu-btn:focus-visible': {
        outline: '2px solid #2490e9',
        'outline-offset': '2px',
        color: '#ffffff',
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
    '.cm-toolbar-panel.ezco-mde-toolbar': {
        // Centred rounded field.
        'box-sizing': 'border-box',
        width: '100%',
        'max-width': 'var(--ezco-mde-toolbar-max-width, 460px)',
        margin: 'var(--ezco-mde-toolbar-margin, 12px auto)',
        background: 'var(--ezco-mde-toolbar-bg, #ffffff)',
        color: 'var(--ezco-mde-toolbar-fg, #1a1a1a)',
        border: 'var(--ezco-mde-toolbar-border, 1px solid rgba(0, 0, 0, 0.14))',
        'border-radius': 'var(--ezco-mde-toolbar-radius, 12px)',
        'box-shadow': 'var(--ezco-mde-toolbar-shadow, 0 1px 2px rgba(0, 0, 0, 0.06))',
        'font-family': 'inherit',
        'font-size': 'var(--ezco-mde-toolbar-font-size, var(--ezco-mde-text-xs))',
        padding: 'var(--ezco-mde-toolbar-pad-y, 8px) var(--ezco-mde-toolbar-pad-x, 14px)',
    },
    // Collapse the wide CodeMirror gutter-sized icon column down to a tight,
    // left-aligned search glyph next to the filename.
    '.ezco-mde-toolbar .cm-toolbar-state-icon-container': {
        width: 'auto',
        'min-width': '0',
    },
    '.ezco-mde-toolbar .cm-toolbar-state-icon': {
        width: 'auto',
        'min-width': '0',
        'font-size': 'var(--ezco-mde-toolbar-font-size, var(--ezco-mde-text-xs))',
        color: 'var(--ezco-mde-toolbar-muted, rgba(0, 0, 0, 0.45))',
        'padding-right': '9px',
        'text-align': 'left',
    },
    '.ezco-mde-toolbar .cm-toolbar-input': {
        'font-family': 'inherit',
        'font-size': 'var(--ezco-mde-toolbar-font-size, var(--ezco-mde-text-xs))',
        'font-weight': 400,
        color: 'var(--ezco-mde-toolbar-fg, #1a1a1a)',
        padding: '0',
    },
    '.ezco-mde-toolbar .cm-toolbar-input::placeholder': {
        color: 'var(--ezco-mde-toolbar-muted, rgba(0, 0, 0, 0.4))',
    },
    // Results popover — a rounded panel matching the field width, dropping
    // just beneath it (left:0/right:0 keeps it aligned, not drifting right).
    '.ezco-mde-toolbar .cm-search-results': {
        'font-family': 'inherit',
        background: 'var(--ezco-mde-toolbar-popover-bg, #ffffff)',
        color: 'var(--ezco-mde-toolbar-fg, #1a1a1a)',
        border: 'var(--ezco-mde-toolbar-popover-border, 1px solid rgba(0, 0, 0, 0.14))',
        'border-radius': 'var(--ezco-mde-toolbar-radius, 12px)',
        'box-shadow': 'var(--ezco-mde-toolbar-popover-shadow, 0 10px 30px rgba(0, 0, 0, 0.16))',
        left: '0',
        right: '0',
        width: 'auto',
        'margin-top': '6px',
        padding: '6px',
        'max-height': '340px',
        overflow: 'hidden auto',
    },
    '.ezco-mde-toolbar .cm-search-result': {
        'font-family': 'inherit',
        'align-items': 'center',
        'border-radius': 'var(--ezco-mde-toolbar-item-radius, 8px)',
        padding: '7px 10px',
        'line-height': '1.4',
    },
    '.ezco-mde-toolbar .cm-search-result > .cm-search-result-icon-container': {
        width: 'auto',
        'min-width': '0',
    },
    '.ezco-mde-toolbar .cm-search-result > .cm-search-result-icon-container > .cm-search-result-icon': {
        width: 'auto',
        'min-width': '0',
        'padding-right': '9px',
        'font-size': 'var(--ezco-mde-toolbar-font-size, var(--ezco-mde-text-xs))',
        'text-align': 'left',
    },
    '.ezco-mde-toolbar .cm-search-result > .cm-search-result-label': {
        'font-size': 'var(--ezco-mde-toolbar-font-size, var(--ezco-mde-text-xs))',
        padding: '0',
    },
    '.ezco-mde-toolbar .cm-search-result:hover': {
        'background-color': 'var(--ezco-mde-toolbar-hover-bg, rgba(0, 0, 0, 0.05))',
    },
    '.ezco-mde-toolbar .cm-search-result.selected': {
        'background-color': 'var(--ezco-mde-toolbar-active-bg, rgba(0, 0, 0, 0.06))',
    },
    // The codeblock base styles paint hovered/selected row text + icons
    // white (meant for its solid-blue selection). On the omnibar's soft
    // light rows that makes labels/command-icons vanish — so keep them
    // legible by following the row's own colour (`active-fg`, default the
    // toolbar foreground) instead.
    '.ezco-mde-toolbar .cm-search-result:hover > .cm-search-result-label, .ezco-mde-toolbar .cm-search-result:hover > .cm-search-result-icon-container > .cm-search-result-icon': {
        color: 'inherit',
    },
    '.ezco-mde-toolbar .cm-search-result.selected > .cm-search-result-label, .ezco-mde-toolbar .cm-search-result.selected > .cm-search-result-icon-container > .cm-search-result-icon': {
        color: 'var(--ezco-mde-toolbar-active-fg, inherit)',
    },
})