import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Plugin } from '@tiptap/pm/state'
import tippy, { Instance as TippyInstance } from 'tippy.js'

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
                            // Track when "/" is typed to distinguish from cursor movement
                            if (event.key === '/') {
                                slashView.lastInputWasSlash = true
                            } else {
                                slashView.lastInputWasSlash = false
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
    public popup: TippyInstance | null = null
    public range: any = null
    public query: string = ''
    public selectedIndex: number = 0
    public lastInputWasSlash: boolean = false
    private outsideClickHandler: ((event: MouseEvent) => void) | null = null

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

        this.editor.on('selectionUpdate', this.selectionUpdate.bind(this))
        this.editor.on('update', this.selectionUpdate.bind(this))
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

        if (match && this.lastInputWasSlash) {
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
            if (!match) {
                this.lastInputWasSlash = false
            }
        }
    }

    createDropdown(): HTMLElement {
        const dropdown = document.createElement('div')
        dropdown.className = 'slash-commands-dropdown'

        const filteredCommands = this.getFilteredCommands()

        if (filteredCommands.length === 0) {
            const noResults = document.createElement('div')
            noResults.className = 'slash-command-item'
            noResults.innerHTML = `
        <div class="slash-command-content">
          <div class="slash-command-text">
            <div class="slash-command-title">No results</div>
            <div class="slash-command-description">No commands found for "${this.query}"</div>
          </div>
        </div>
      `
            dropdown.appendChild(noResults)
        } else {
            filteredCommands.forEach((command, index) => {
                const item = document.createElement('button')
                item.className = `slash-command-item ${index === this.selectedIndex ? 'selected' : ''}`
                item.innerHTML = `
          <div class="slash-command-content">
            ${command.icon ? `<span class="slash-command-icon">${command.icon}</span>` : ''}
            <div class="slash-command-text">
              <div class="slash-command-title">${command.title}</div>
              <div class="slash-command-description">${command.description}</div>
            </div>
          </div>
        `

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

        const items = this.dropdown.querySelectorAll('.slash-command-item')
        items.forEach((item, index) => {
            if (index === this.selectedIndex) {
                item.classList.add('selected')
            } else {
                item.classList.remove('selected')
            }
        })
    }

    showSuggestions() {
        // Always recreate the dropdown to ensure fresh content and event listeners
        this.dropdown = this.createDropdown()

        if (this.popup) {
            // Update existing popup content
            this.popup.setContent(this.dropdown)
        } else {
            // Create new popup
            const instances = tippy(document.body, {
                getReferenceClientRect: () => {
                    if (!this.range) {
                        // Return a default rect if range is null
                        return new DOMRect(0, 0, 0, 0)
                    }
                    const { view } = this.editor
                    const { from } = this.range
                    const start = view.coordsAtPos(from)
                    const end = view.coordsAtPos(this.range.to)

                    return {
                        top: start.top,
                        bottom: end.bottom,
                        left: start.left,
                        right: end.right,
                        width: end.right - start.left,
                        height: end.bottom - start.top,
                        x: start.left,
                        y: start.top,
                        toJSON: () => ({
                            top: start.top,
                            bottom: end.bottom,
                            left: start.left,
                            right: end.right,
                            width: end.right - start.left,
                            height: end.bottom - start.top,
                            x: start.left,
                            y: start.top,
                        })
                    } as DOMRect
                },
                appendTo: () => document.body,
                content: this.dropdown,
                showOnCreate: true,
                interactive: true,
                trigger: 'manual',
                placement: 'bottom-start',
                theme: 'slash-commands',
                maxWidth: 'none',
                onShow: () => {
                    // Add outside click handler when dropdown is shown
                    this.addOutsideClickHandler()
                },
                onHide: () => {
                    // Remove outside click handler when dropdown is hidden
                    this.removeOutsideClickHandler()
                }
            }) as any
            this.popup = instances[0]
        }
    }

    hideSuggestions() {
        this.removeOutsideClickHandler()

        if (this.popup) {
            this.popup.destroy()
            this.popup = null
        }

        // Force cleanup of any remaining tippy instances
        const existingTippyInstances = document.querySelectorAll('[data-tippy-root]')
        existingTippyInstances.forEach(instance => {
            instance.remove()
        })

        // Also remove any dropdown elements that might be lingering
        const existingDropdowns = document.querySelectorAll('.slash-commands-dropdown')
        existingDropdowns.forEach(dropdown => {
            console.log('Force removing dropdown element')
            dropdown.remove()
        })

        this.dropdown = null
        this.range = null
        this.query = ''
        this.selectedIndex = 0
        this.lastInputWasSlash = false
    }

    addOutsideClickHandler() {
        if (this.outsideClickHandler) {
            this.removeOutsideClickHandler()
        }

        this.outsideClickHandler = (event: MouseEvent) => {
            const target = event.target as Element
            // Check if click is outside the dropdown and editor
            if (this.dropdown && !this.dropdown.contains(target) &&
                !this.editor.view.dom.contains(target)) {
                this.hideSuggestions()
            }
        }

        // Add listener with a slight delay to avoid immediate closure
        setTimeout(() => {
            document.addEventListener('click', this.outsideClickHandler!, true)
        }, 100)
    }

    removeOutsideClickHandler() {
        if (this.outsideClickHandler) {
            document.removeEventListener('click', this.outsideClickHandler, true)
            this.outsideClickHandler = null
        }
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
            console.log('Executing command, hiding suggestions first')
            // Hide suggestions first to ensure dropdown closes
            this.hideSuggestions()
            console.log('Suggestions hidden, executing command')
            // Then execute the command with the stored range
            command.command({ editor: this.editor, range })
            console.log('Command execution completed')
        }
    }

    destroy() {
        this.removeOutsideClickHandler()
        this.hideSuggestions()
        this.editor.off('selectionUpdate', this.selectionUpdate)
        this.editor.off('update', this.selectionUpdate)
    }
}