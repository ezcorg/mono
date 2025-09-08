import { StyleModule } from 'style-mod';

export const styleModule: StyleModule = new StyleModule({

    '@media (prefers-color-scheme: dark)': {
        'div.ezdev-mde': {
            '--ezdev-mde-code-bg': 'var(--ezdev-mde-code-bg-dark)',
            '--ezdev-mde-bg': 'var(--ezdev-mde-bg-dark)',
        }
    },
    '.ezdev-mde': {
        // Light/dark mode vars
        '--ezdev-mde-code-bg-light': '#f1f1f1',
        '--ezdev-mde-code-bg-dark': '#2c2c2c',
        '--ezdev-mde-bg-light': '#ffffff',
        '--ezdev-mde-bg-dark': '#1e1e1e',

        // Default to light mode, overridden by media query
        '--ezdev-mde-code-bg': 'var(--ezdev-mde-code-bg-light)',
        '--ezdev-mde-bg': 'var(--ezdev-mde-bg-light)',

        // Base editor styles
        'background': 'var(--ezdev-mde-bg)',

        // Inline code styles
        '& > :not(.cm-editor) code': {
            'font-family': 'monospace',
            background: 'var(--ezdev-mde-code-bg)',
            padding: '0.1em 0.3em',
            'border-radius': '3px',
        },

        // Table styles
        '&.tableWrapper': {
            margin: '1.5rem 0',
            'overflow-x': 'auto'
        },
        '& table': {
            "border-collapse": "collapse",
            "width": "100%",
            "margin": "1em 0",
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
            '& td': {
                border: '1px solid #2b2b2b',
                padding: '0.5em',
                'vertical-align': 'top',
                position: 'relative',
            },
            '& th': {
                'font-weight': 'bold',
                'background-color': '#2b2b2b',
                'text-align': 'left',
                'color': 'white',
            },
            '& th, & td': {
                border: '1px solid #2b2b2b',
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