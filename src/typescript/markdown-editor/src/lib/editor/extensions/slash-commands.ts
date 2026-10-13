import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Plugin } from '@tiptap/pm/state'
import { popover, rangeRect, type Popover } from '../ui/popover'

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
                view: () => {
                    slashView = new SlashCommandsView({
                        editor: this.editor,
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

                            if (slashView.dropdown) {
                                return slashView.handleKeyDown(event)
                            }
                        }
                        return false
                    }
                }
            }),
        ]
    },
})

class SlashCommandsView {
    public editor: any
    public commands: SlashCommand[]
    public char: string
    public allowSpaces: boolean
    public startOfLine: boolean
    public dropdown: HTMLElement | null = null
    public popup: Popover | null = null
    public range: any = null
    public query: string = ''
    public selectedIndex: number = 0
    public lastInputWasSlash: boolean = false

    constructor({
        editor,
        commands,
        char,
        allowSpaces,
        startOfLine,
    }: {
        editor: any
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
            this.selectedIndex = 0
            this.showSuggestions()
        } else {
            this.hideSuggestions()
            // Reset the flag when we're not in a slash command context
            if (!match || !onWordBoundary) {
                this.lastInputWasSlash = false
            }
        }
    }

    createDropdown(): HTMLElement {
        const dropdown = document.createElement('div')
        dropdown.className = 'ezco-mde-slash-menu'
        dropdown.setAttribute('role', 'listbox')

        const filteredCommands = this.getFilteredCommands()

        if (filteredCommands.length === 0) {
            const noResults = document.createElement('div')
            noResults.className = 'ezco-mde-slash-empty'
            noResults.textContent = this.query
                ? `No commands matching “${this.query}”`
                : 'No commands available'
            dropdown.appendChild(noResults)
        } else {
            filteredCommands.forEach((command, index) => {
                const item = document.createElement('button')
                item.type = 'button'
                item.className = 'ezco-mde-slash-item'
                item.setAttribute('role', 'option')
                if (index === this.selectedIndex) {
                    item.classList.add('is-selected')
                    item.setAttribute('aria-selected', 'true')
                }

                if (command.icon) {
                    const icon = document.createElement('span')
                    icon.className = 'ezco-mde-slash-item-icon'
                    icon.textContent = command.icon
                    item.appendChild(icon)
                }

                const body = document.createElement('span')
                body.className = 'ezco-mde-slash-item-body'

                const title = document.createElement('span')
                title.className = 'ezco-mde-slash-item-title'
                title.textContent = command.title
                body.appendChild(title)

                if (command.description) {
                    const desc = document.createElement('span')
                    desc.className = 'ezco-mde-slash-item-desc'
                    desc.textContent = command.description
                    body.appendChild(desc)
                }

                item.appendChild(body)

                // Keep editor focus/selection (the slash query) intact while
                // the user clicks an item — mousedown must not steal focus.
                item.addEventListener('mousedown', (e) => e.preventDefault())
                item.addEventListener('mouseenter', () => {
                    if (this.selectedIndex !== index) {
                        this.selectedIndex = index
                        this.updateSelection()
                    }
                })
                item.addEventListener('click', () => this.selectCommand(command))
                dropdown.appendChild(item)
            })
        }

        // Add keyboard event handling
        dropdown.addEventListener('keydown', this.handleKeyDown.bind(this))

        return dropdown
    }

    handleKeyDown(event: KeyboardEvent): boolean {
        const filteredCommands = this.getFilteredCommands()

        switch (event.key) {
            case 'ArrowUp':
                event.preventDefault()
                if (this.selectedIndex === 0) {
                    // Exit dropdown when at the start and pressing up
                    this.hideSuggestions()
                    return false // Let editor handle the event
                } else {
                    this.selectedIndex = this.selectedIndex - 1
                    this.updateSelection()
                }
                return true
            case 'ArrowDown':
                event.preventDefault()
                if (this.selectedIndex === filteredCommands.length - 1) {
                    // Cycle to start when at the end and pressing down
                    this.selectedIndex = 0
                } else {
                    this.selectedIndex = this.selectedIndex + 1
                }
                this.updateSelection()
                return true
            case 'Enter':
                event.preventDefault()
                const selectedCommand = filteredCommands[this.selectedIndex]
                if (selectedCommand) {
                    this.selectCommand(selectedCommand)
                }
                return true
            case 'Escape':
                event.preventDefault()
                this.hideSuggestions()
                return true
            default:
                return false
        }
    }

    updateSelection() {
        if (!this.dropdown) return

        const items = this.dropdown.querySelectorAll('.ezco-mde-slash-item')
        items.forEach((item, index) => {
            if (index === this.selectedIndex) {
                item.classList.add('is-selected')
                item.setAttribute('aria-selected', 'true')
                // Keep the active item in view when arrowing through a
                // long, scrollable list.
                ;(item as HTMLElement).scrollIntoView({ block: 'nearest' })
            } else {
                item.classList.remove('is-selected')
                item.removeAttribute('aria-selected')
            }
        })
    }

    showSuggestions() {
        // Always recreate the dropdown to ensure fresh content and event listeners
        this.dropdown = this.createDropdown()

        if (this.popup) {
            this.popup.instance.setContent(this.dropdown)
        } else {
            // Under the typed `/query`. A press in the editor is the editor's
            // (the selection then decides); one elsewhere closes it.
            this.popup = popover(this.editor.view.dom, this.dropdown, {
                rect: () => (this.range ? rangeRect(this.editor.view, this.range) : new DOMRect()),
                theme: 'ezco-mde-slash',
                maxWidth: 'none',
                onPressOutside: () => this.hideSuggestions(),
            })
            this.popup.show()
        }
    }

    hideSuggestions() {
        if (this.popup) {
            this.popup.destroy()
            this.popup = null
        }

        // Defensive cleanup of any *slash* popovers that escaped destroy()
        // (e.g. across HMR / re-init). This MUST stay scoped to our own
        // dropdown: a previous version removed every `[data-tippy-root]` in
        // the document, which — because this runs on every selection change —
        // wiped unrelated popovers (the inline link popover, the block-action
        // and selection menus) the instant the caret moved.
        document.querySelectorAll('[data-tippy-root]').forEach(root => {
            if (root.querySelector('.ezco-mde-slash-menu')) root.remove()
        })
        document.querySelectorAll('.ezco-mde-slash-menu').forEach(dropdown => {
            dropdown.remove()
        })

        this.dropdown = null
        this.range = null
        this.query = ''
        this.selectedIndex = 0
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
            // Store the range before hiding suggestions, as hideSuggestions() might clear it
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