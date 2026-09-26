/**
 * Where a comment is written: the editor itself, in small. The composer is
 * a Tiptap editor built from the extensions its host gives it (the note's
 * own `markdownSetup` without the chrome around the note, so code blocks
 * open and reference the same files, `[[links]]` resolve the same way,
 * `:emoji:` and slash commands work; `minimalSetup` when a host gives
 * none), with the note's content styles, so what is typed is Markdown
 * authored as in the note and what is posted is the Markdown the editor
 * would write. ⌘/Ctrl+Enter posts, Escape cancels. What is typed is
 * reported as it changes, so a host can keep a draft; "Open in editor"
 * hands the same draft to a full-size view.
 */
import { Editor, Extension, type AnyExtension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { minimalSetup } from '../minimal'

export interface ComposerOptions {
    /** The note's editor: the composer resolves and follows wikilinks as it does. */
    editor: Editor
    /** The extensions to build the composer from (see the module comment). */
    extensions?: AnyExtension[]
    placeholder: string
    submitLabel: string
    /** Text to start with (a kept draft, a message being edited). */
    initial?: string
    onSubmit: (markdown: string) => void
    onCancel: () => void
    /** What is typed, as it changes. */
    onChange?: (markdown: string) => void
    /** Asked for the full-size view; without it there is no such control. */
    onExpand?: () => void
    /** Taller from the start (the full-size view). */
    full?: boolean
}

/** A hint in an empty composer, as the styles show it. */
const placeholderPlugin = (text: string) =>
    new Plugin({
        key: new PluginKey('composerPlaceholder'),
        props: {
            decorations(state) {
                const { doc } = state
                const first = doc.firstChild
                if (doc.childCount !== 1 || !first || first.type.name !== 'paragraph' || first.content.size) return DecorationSet.empty
                return DecorationSet.create(doc, [Decoration.node(0, first.nodeSize, { class: 'is-empty', 'data-placeholder': text })])
            },
        },
    })

export class Composer {
    readonly dom: HTMLFormElement
    readonly editor: Editor
    private readonly label: HTMLElement
    private readonly field: HTMLElement

    constructor(private readonly options: ComposerOptions) {
        this.dom = document.createElement('form')
        this.dom.className = 'ezco-mde-comment-composer' + (options.full ? ' is-full' : '')
        this.label = document.createElement('div')
        this.label.className = 'ezco-mde-comment-composer-label'
        this.label.hidden = true
        this.field = document.createElement('div')
        this.field.className = 'ezco-mde-comment-input'

        const submit = () => this.submit()
        const keys = Extension.create({
            name: 'composerKeys',
            addKeyboardShortcuts() {
                return {
                    'Mod-Enter': () => (submit(), true),
                    Escape: () => (options.onCancel(), true),
                }
            },
            addProseMirrorPlugins() {
                return [placeholderPlugin(options.placeholder)]
            },
        })
        const wikilink = options.editor.extensionManager.extensions.find((e) => e.name === 'wikilink')
        const base =
            options.extensions ??
            minimalSetup({
                links: { resolver: wikilink?.options.resolver, open: wikilink?.options.open },
                frontMatter: false,
                footnotes: false,
                callouts: false,
            })
        this.editor = new Editor({
            element: this.field,
            // The keys last: an open menu (emoji, slash) takes Enter and Escape first.
            extensions: [...base, keys],
            content: options.initial ?? '',
            // The note's content styles apply (`ezco-mde-body`); the composer's
            // own rules size it down.
            editorProps: { attributes: { 'aria-label': 'Comment', class: 'ezco-mde-body ezco-mde-comment-text' } },
            onUpdate: () => options.onChange?.(this.value()),
        })

        const post = document.createElement('button')
        post.type = 'submit'
        post.className = 'ezco-mde-comment-button is-primary'
        post.textContent = options.submitLabel
        post.title = '⌘/Ctrl+Enter'
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.className = 'ezco-mde-comment-button'
        cancel.textContent = 'Cancel'
        cancel.addEventListener('click', () => options.onCancel())
        const actions = document.createElement('div')
        actions.className = 'ezco-mde-comment-composer-actions'
        if (options.onExpand) {
            const expand = document.createElement('button')
            expand.type = 'button'
            expand.className = 'ezco-mde-comment-action is-expand'
            expand.textContent = 'Open in editor'
            expand.title = 'Write this in a full-size editor, with the thread beside it'
            expand.addEventListener('click', () => options.onExpand?.())
            actions.append(expand)
        }
        actions.append(cancel, post)
        this.dom.append(this.label, this.field, actions)
        this.dom.addEventListener('submit', (e) => {
            e.preventDefault()
            this.submit()
        })
        // The composer's keys and clicks are its own: not the card's (which
        // would close on Escape or change what is looked at), nor the note's.
        for (const type of ['mousedown', 'click', 'keydown'] as const) this.dom.addEventListener(type, (e) => e.stopPropagation())
    }

    private submit() {
        const markdown = this.value().trim()
        if (markdown) this.options.onSubmit(markdown)
    }

    /** A line over the field: whom this answers, or that it edits. */
    say(label: string) {
        this.label.textContent = label
        this.label.hidden = !label
    }

    value(): string {
        return (this.editor.storage as any).markdown.getMarkdown() as string
    }

    set(markdown: string) {
        this.editor.commands.setContent(markdown)
    }

    focus() {
        requestAnimationFrame(() => {
            if (!this.editor.isDestroyed) this.editor.commands.focus('end')
        })
    }

    destroy() {
        this.editor.destroy()
        this.dom.remove()
    }
}
