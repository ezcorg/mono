import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { SuggestionMenu, type SuggestionItem } from '../ui/suggestion-menu'

export interface SlashCommand {
    title: string
    description: string
    icon?: string
    command: ({ editor, range }: { editor: any; range: any }) => void
}

export interface SlashCommandsOptions {
    commands: SlashCommand[]
    char: string
    allowSpaces: boolean
    startOfLine: boolean
}

export const SlashCommands = Extension.create<SlashCommandsOptions>({
    name: 'slashCommands',

    addOptions() {
        return {
            commands: [],
            char: '/',
            allowSpaces: false,
            startOfLine: false,
        }
    },

    addProseMirrorPlugins() {
        let slashView: SlashCommandsView | null = null

        return [
            new Plugin({
                key: new PluginKey('slashCommands'),
                view: (view) => {
                    slashView = new SlashCommandsView({
                        editor: this.editor,
                        view,
                        commands: this.options.commands,
                        char: this.options.char,
                        allowSpaces: this.options.allowSpaces,
                        startOfLine: this.options.startOfLine,
                    })
                    return slashView
                },
                props: {
                    handleKeyDown: (_, event) => {
                        if (slashView) {
                            // Mark when "/" is typed so we only open on a
                            // freshly-typed slash (not when the cursor merely
                            // lands after an existing "/"). Crucially we do
                            // NOT reset this on other keys: typing the query
                            // after "/" must keep the session alive so the
                            // menu filters live instead of vanishing on the
                            // first character. `selectionUpdate` clears the
                            // flag when the slash context actually ends (a
                            // space, deleting past the "/", moving away).
                            if (event.key === '/') {
                                slashView.lastInputWasSlash = true
                            }

                            return slashView.handleKeyDown(event)
                        }
                        return false
                    }
                }
            }),
        ]
    },
})

/**
 * The `/` menu: the commands whose title or description holds what was
 * typed after a freshly typed slash on a word boundary. The list itself
 * (rows, keys, the popover) is a `SuggestionMenu`; this finds the slash,
 * filters the commands and runs the one chosen over the typed range.
 */
class SlashCommandsView {
    public editor: any
    public commands: SlashCommand[]
    public char: string
    public allowSpaces: boolean
    public startOfLine: boolean
    public menu: SuggestionMenu
    public range: { from: number; to: number } | null = null
    public query: string = ''
    public lastInputWasSlash: boolean = false

    constructor({
        editor,
        view,
        commands,
        char,
        allowSpaces,
        startOfLine,
    }: {
        editor: any
        view: EditorView
        commands: SlashCommand[]
        char: string
        allowSpaces: boolean
        startOfLine: boolean
    }) {
        this.editor = editor
        this.commands = commands
        this.char = char
        this.allowSpaces = allowSpaces
        this.startOfLine = startOfLine
        // Under the typed `/query`. ArrowUp on the first row leaves the menu
        // (the caret stays); Tab is the editor's.
        this.menu = new SuggestionMenu({
            view,
            range: () => this.range,
            className: 'ezco-mde-slash-menu',
            atTop: 'close',
            onClose: () => this.hideSuggestions(),
        })

        // Bound once: what `destroy` takes off must be what went on.
        this.selectionUpdate = this.selectionUpdate.bind(this)
        this.editor.on('selectionUpdate', this.selectionUpdate)
        this.editor.on('update', this.selectionUpdate)
    }

    selectionUpdate() {
        const { selection } = this.editor.state
        const { $from } = selection

        // Get text before cursor in current node
        const currentNode = $from.parent
        const currentNodeText = currentNode.textContent
        const posInNode = $from.parentOffset
        const textBeforeCursor = currentNodeText.slice(0, posInNode)

        // Look for slash command pattern
        const match = textBeforeCursor.match(new RegExp(`${this.char}([^\\s${this.char}]*)$`))

        // Only trigger when the slash sits on a word boundary: the char
        // immediately before the slash must be whitespace (or the slash
        // is at the start of the block), AND the cursor must be at the end
        // of the block or sitting on whitespace. This avoids firing when
        // typing "/" mid-word (e.g. "TCP/IP" or URLs).
        let onWordBoundary = false
        if (match) {
            const matchStart = posInNode - match[0].length
            const charBefore = matchStart > 0 ? currentNodeText[matchStart - 1] : ''
            const charAfter = posInNode < currentNodeText.length ? currentNodeText[posInNode] : ''
            const beforeOk = matchStart === 0 || /\s/.test(charBefore)
            const afterOk = posInNode === currentNodeText.length || /\s/.test(charAfter)
            onWordBoundary = beforeOk && afterOk
        }

        if (match && onWordBoundary && this.lastInputWasSlash) {
            const query = match[1]
            const from = $from.pos - match[0].length
            const to = $from.pos

            this.range = { from, to }
            this.query = query
            this.showSuggestions()
        } else {
            this.hideSuggestions()
            // Reset the flag when we're not in a slash command context
            if (!match || !onWordBoundary) {
                this.lastInputWasSlash = false
            }
        }
    }

    handleKeyDown(event: KeyboardEvent): boolean {
        return this.menu.handleKeyDown(event)
    }

    showSuggestions() {
        // Drawn afresh on every change of the query, the first row selected.
        const items: SuggestionItem[] = this.getFilteredCommands().map((command) => ({
            icon: command.icon,
            title: command.title,
            description: command.description,
            onSelect: () => this.selectCommand(command),
        }))
        this.menu.show(items, this.query ? `No commands matching “${this.query}”` : 'No commands available')
    }

    hideSuggestions() {
        this.menu.hide()
        this.range = null
        this.query = ''
        this.lastInputWasSlash = false
    }

    getFilteredCommands(): SlashCommand[] {
        if (!this.query) {
            return this.commands
        }

        return this.commands.filter(command =>
            command.title.toLowerCase().includes(this.query.toLowerCase()) ||
            command.description.toLowerCase().includes(this.query.toLowerCase())
        )
    }

    selectCommand(command: SlashCommand) {
        if (this.range) {
            // Store the range before hiding suggestions, as hideSuggestions() clears it
            const range = this.range
            // Hide suggestions first to ensure dropdown closes
            this.hideSuggestions()
            // Then execute the command with the stored range
            command.command({ editor: this.editor, range })
        }
    }

    destroy() {
        this.hideSuggestions()
        this.editor.off('selectionUpdate', this.selectionUpdate)
        this.editor.off('update', this.selectionUpdate)
    }
}
