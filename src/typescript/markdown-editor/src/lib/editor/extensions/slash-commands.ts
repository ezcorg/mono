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
            // Update existing popup content
            this.popup.setContent(this.dropdown)
        } else {
            // Create new popup. `tippy()` on a single element returns a
            // single Instance (not an array) — capturing `instances[0]`
            // left `this.popup` undefined, so every keystroke spawned a
            // fresh, never-destroyed tippy. Normalize both shapes.
            const created = tippy(document.body, {
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
                theme: 'ezco-mde-slash',
                maxWidth: 'none',
                onShow: () => {
                    // Add outside click handler when dropdown is shown
                    this.addOutsideClickHandler()
                },
                onHide: () => {
                    // Remove outside click handler when dropdown is hidden
                    this.removeOutsideClickHandler()
                }
            }) as TippyInstance | TippyInstance[]
            this.popup = Array.isArray(created) ? created[0] : created
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
        const existingDropdowns = document.querySelectorAll('.ezco-mde-slash-menu')
        existingDropdowns.forEach(dropdown => {
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
            // Hide suggestions first to ensure dropdown closes
            this.hideSuggestions()
            // Then execute the command with the stored range
            command.command({ editor: this.editor, range })
        }
    }

    destroy() {
        this.removeOutsideClickHandler()
        this.hideSuggestions()
        this.editor.off('selectionUpdate', this.selectionUpdate)
        this.editor.off('update', this.selectionUpdate)
    }
}