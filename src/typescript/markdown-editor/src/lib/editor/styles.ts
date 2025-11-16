import { StyleModule } from 'style-mod';

const darkModeStyles = {
    '--ezco-mde-code-bg': 'var(--ezco-mde-code-bg-dark)',
    '--ezco-mde-bg': 'var(--ezco-mde-bg-dark)',
    '--ezco-mde-table-bg': 'var(--cm-toolbar-bg-dark)',
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

        // Typography scale based on perfect fourth ratio (1.333)
        '--ezco-mde-type-ratio': '1.25',
        '--ezco-mde-base-font-size': '1rem',
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

        // Typography styles for Markdown elements using modular scale
        '& h1': {
            'font-size': 'var(--ezco-mde-text-4xl)',
            'line-height': 'var(--ezco-mde-leading-tight)',
            'margin': '0.67em 0',
            'font-weight': 'bold',
        },
        '& h2': {
            'font-size': 'var(--ezco-mde-text-3xl)',
            'line-height': 'var(--ezco-mde-leading-tight)',
            'margin': '0.75em 0 0.5em 0',
            'font-weight': 'bold',
        },
        '& h3': {
            'font-size': 'var(--ezco-mde-text-2xl)',
            'line-height': 'var(--ezco-mde-leading-snug)',
            'margin': '0.83em 0 0.5em 0',
            'font-weight': 'bold',
        },
        '& h4': {
            'font-size': 'var(--ezco-mde-text-xl)',
            'line-height': 'var(--ezco-mde-leading-snug)',
            'margin': '1em 0 0.5em 0',
            'font-weight': 'bold',
        },
        '& h5': {
            'font-size': 'var(--ezco-mde-text-lg)',
            'line-height': 'var(--ezco-mde-leading-normal)',
            'margin': '1.17em 0 0.5em 0',
            'font-weight': 'bold',
        },
        '& h6': {
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-normal)',
            'margin': '1.33em 0 0.5em 0',
            'font-weight': 'bold',
        },
        '& p': {
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-relaxed)',
            'margin': '1em 0',
        },
        '& blockquote': {
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-relaxed)',
            'margin': '1.5em 0',
            'padding': '0 1em',
            'border-left': '4px solid #ddd',
        },
        '& small': {
            'font-size': 'var(--ezco-mde-text-sm)',
            'line-height': 'var(--ezco-mde-leading-normal)',
        },

        // Codeblock styles
        '& .cm-editor': {
            margin: '2rem 0',
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
        // Table styles
        '&.tableWrapper': {
            margin: '1.5rem 0',
            'overflow-x': 'auto'
        },
        '& table': {
            "border-collapse": "collapse",
            "width": "100%",
            "margin": "2em 0",
            border: '2px solid var(--ezco-mde-table-bg)',
            overflow: 'hidden',
            'table-layout': 'fixed',
            '& p': {
                margin: 0
            },

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
        // Tight list styles
        '& .tight': {
            margin: '0 18px',
            '& li': {
                'padding-left': '2px',
            }
        },
        // List styles
        '& ul, & ol, & menu': {
            padding: 0,
        },
        // List item styles
        '& li > p': {
            'margin-top': 0,
            'margin-bottom': 0,
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-relaxed)',
        },
        '& ol > li > p, & ul > li > p': {
            'font-size': 'var(--ezco-mde-text-base)',
            'line-height': 'var(--ezco-mde-leading-relaxed)',
        },
        // Task list styles
        '& li[data-checked="true"]>div>p': {
            "text-decoration": "line-through",
            "color": "#888",
        },
        '& ul[data-type="taskList"]': {
            'list-style': 'none',
            'padding': 0,
            'margin': 0,

            '& p': {
                'margin': 0,
            },
            '& p + ul[data-type="taskList"]': {
                'margin-top': '0.25em'
            },

            '& p + p': {
                'margin-top': '0.25em',
            },

            '& li': {
                display: 'flex',
                'align-items': 'flex-start',
            },

            '& li + li': {
                'margin-top': '0.25em'
            },

            '& li > label': {
                'margin-right': '6px'
            },
            '& li > label > input': {
                margin: 0
            },
            '& li > div': {
                flex: 1
            }
        },
    }
})