import { SlashCommand } from '../extensions/slash-commands'

/**
 * Default slash-command palette for the markdown editor.
 *
 * Each command first deletes the typed "/query" range, then runs an
 * editor command chain. Everything here drives built-in editor commands
 * (no app-specific UI), so the palette ships with the library and works
 * for any consumer.
 */
export const defaultSlashCommands: SlashCommand[] = [
    {
        title: 'Heading 1',
        description: 'Large section heading',
        icon: 'H1',
        command: ({ editor, range }) =>
            editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
    },
    {
        title: 'Heading 2',
        description: 'Medium section heading',
        icon: 'H2',
        command: ({ editor, range }) =>
            editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
    },
    {
        title: 'Heading 3',
        description: 'Small section heading',
        icon: 'H3',
        command: ({ editor, range }) =>
            editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
    },
    {
        title: 'Bullet list',
        description: 'An unordered list',
        icon: '•',
        command: ({ editor, range }) =>
            editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
        title: 'Numbered list',
        description: 'An ordered list',
        icon: '1.',
        command: ({ editor, range }) =>
            editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
        title: 'Task list',
        description: 'A checklist of to-dos',
        icon: '☐',
        command: ({ editor, range }) =>
            editor.chain().focus().deleteRange(range).toggleTaskList().run(),
    },
    {
        title: 'Code block',
        description: 'A formatted block of code',
        icon: '</>',
        command: ({ editor, range }) =>
            editor
                .chain()
                .focus()
                .deleteRange(range)
                .insertContent({ type: 'ezcodeBlock', attrs: { language: '' } })
                .run(),
    },
    {
        title: 'Quote',
        description: 'Capture a quotation',
        icon: '“',
        command: ({ editor, range }) =>
            editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
        title: 'Table',
        description: 'Insert a 3×3 table',
        icon: '⊞',
        command: ({ editor, range }) =>
            editor
                .chain()
                .focus()
                .deleteRange(range)
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run(),
    },
    {
        title: 'Divider',
        description: 'A horizontal rule',
        icon: '—',
        command: ({ editor, range }) =>
            editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
]
