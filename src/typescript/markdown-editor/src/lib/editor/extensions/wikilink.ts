/**
 * Wikilinks: `[[note]]`, `[[note|shown text]]`, `[[note#heading]]`,
 * `[[#heading]]` — an inline node that round-trips to exactly the text it
 * was parsed from (the grammar is `@joinezco/storage`'s, the same one the
 * vault's link index reads, so the editor and the index agree on what is a
 * link).
 *
 * What a link points at is the host's business: it supplies a
 * `LinkResolver` (a `Vault`'s `links`, or anything else). With one, each link
 * shows whether its note exists (an unresolved link is dimmed), a click
 * follows it through the filesystem extension's `loadFile` (creating a note
 * that does not exist yet) and reveals the heading, block or quoted text it
 * names, and typing `[[` offers the vault's notes. Without one, links still
 * parse, render and serialize, and a `[[#heading]]` still scrolls.
 *
 * Editing: typing `[[name]]` makes a link; Backspace just after a link turns
 * it back into its source text (minus the closing bracket) to edit; ⌘/Ctrl-
 * Enter follows a link beside or under the caret.
 */
import { Editor, InputRule, Node, mergeAttributes } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import tippy, { type Instance as TippyInstance } from 'tippy.js'
import {
    formatWikilink,
    isNote,
    matchWikilinkAt,
    normalizePath,
    parseWikilink,
    type LinkResolution,
    type LinkResolver,
    type LinkSuggestion,
    type LinkSyntax,
    type Wikilink as WikilinkParts,
} from '@joinezco/storage'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import { revealFragment } from './fragment'

export interface WikilinkOptions {
    /** Resolves links against the vault. Supplied by the host. */
    resolver?: LinkResolver
    /**
     * Open a resolved link. The default loads it through the filesystem
     * extension (creating a note that does not exist yet) and reveals the
     * fragment; a host with panes or tabs opens it its own way.
     */
    open?: (resolution: LinkResolution, fragment: string | null, editor: Editor) => void | Promise<void>
    HTMLAttributes: Record<string, unknown>
}

export interface WikilinkStorage {
    markdown: MarkdownNodeSpec
    /**
     * Follow a link from the open note: a wikilink target, or (with
     * `syntax: 'markdown'`) a Markdown link's destination. Resolves true when
     * something was opened or revealed.
     */
    follow: (target: string, fragment: string | null, syntax?: LinkSyntax) => Promise<boolean>
    /** Resolve a wikilink target from the open note (cached until the
     *  resolver reports a change). */
    resolve: (target: string) => Promise<LinkResolution | null>
    /** Resolve a target of either syntax from the open note; undefined when
     *  the host supplied no resolver. */
    resolveTarget: (target: string, syntax: LinkSyntax) => Promise<LinkResolution | null | undefined>
    /** Be told when cached resolutions were dropped. */
    onResolutionsChanged: (listener: () => void) => () => void
}

/** The text a link shows: its alias, else its target and fragment. */
export function wikilinkLabel({ target, fragment, alias }: WikilinkParts): string {
    if (alias) return alias
    if (fragment === null) return target
    let frag = fragment
    if (frag.startsWith(':~:text=')) {
        try {
            frag = `“${decodeURIComponent(frag.slice(':~:text='.length).split(',')[0].replace(/-$/, ''))}”`
        } catch {
            /* keep it as written */
        }
    }
    return target ? `${target} › ${frag}` : frag
}

/** The open note's vault path, as the filesystem extension knows it. */
function openPath(editor: Editor): string | null {
    const path = (editor.storage as any).persistence?.options?.filepath as string | undefined
    return path ? normalizePath(path) : null
}

const attrsOf = (node: PMNode): WikilinkParts => ({
    target: node.attrs.target ?? '',
    fragment: node.attrs.fragment ?? null,
    alias: node.attrs.alias ?? null,
})

/** A nullable string attribute carried in a `data-*` attribute, where absent
 *  and empty differ (`[[a|]]` is not `[[a]]`). */
const optionalData = (name: string) => ({
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`),
    renderHTML: (attrs: Record<string, unknown>) =>
        attrs[name] === null || attrs[name] === undefined ? {} : { [`data-${name}`]: attrs[name] },
})

function openInNewTab(url: string): void {
    if (typeof window === 'undefined') return
    // No window-features string: that makes it a popup, which blockers drop.
    const win = window.open(url, '_blank')
    if (win) win.opener = null
}

export const Wikilink = Node.create<WikilinkOptions, WikilinkStorage>({
    name: 'wikilink',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,

    addOptions() {
        return { resolver: undefined, open: undefined, HTMLAttributes: {} }
    },

    addAttributes() {
        return {
            target: {
                default: '',
                parseHTML: (el) => el.getAttribute('data-target') ?? '',
                renderHTML: (attrs) => ({ 'data-target': attrs.target }),
            },
            fragment: optionalData('fragment'),
            alias: optionalData('alias'),
        }
    },

    parseHTML() {
        // Above the link mark's `a[href]` rule, so a copied wikilink pastes
        // back as a wikilink.
        return [{ tag: 'span[data-wikilink]' }, { tag: 'a[data-wikilink]', priority: 60 }]
    },

    renderHTML({ node, HTMLAttributes }) {
        const parts = attrsOf(node)
        return [
            'a',
            mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
                'data-wikilink': '',
                class: 'ezco-mde-wikilink',
                href: parts.target + (parts.fragment !== null ? `#${parts.fragment}` : ''),
            }),
            wikilinkLabel(parts),
        ]
    },

    renderText({ node }) {
        return formatWikilink(attrsOf(node))
    },

    // The text a reader sees, as the node's `textContent`: without it a link
    // is empty to everything that reads text (a table cell holding only a
    // link would serialize as empty; an outline would drop a linked heading).
    extendNodeSchema(extension) {
        return extension.name === 'wikilink' ? { leafText: (node: PMNode) => wikilinkLabel(attrsOf(node)) } : {}
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: PMNode) {
                    // A table cell ends at a bare pipe, so the alias separator is escaped there.
                    state.write(formatWikilink(attrsOf(node), { inTable: !!state.inTable }))
                },
                parse: {
                    setup(markdownit: any) {
                        if (markdownit.__ezcoWikilink) return
                        markdownit.__ezcoWikilink = true
                        markdownit.inline.ruler.before('link', 'ezco_wikilink', (state: any, silent: boolean) => {
                            if (state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5b) return false
                            const m = matchWikilinkAt(state.src, state.pos)
                            if (!m || m.end > state.posMax) return false
                            if (!silent) state.push('ezco_wikilink', '', 0).meta = m.link
                            state.pos = m.end
                            return true
                        })
                        const esc = markdownit.utils.escapeHtml
                        markdownit.renderer.rules.ezco_wikilink = (tokens: any[], idx: number) => {
                            const link: WikilinkParts = tokens[idx].meta
                            let attrs = ` data-wikilink="" data-target="${esc(link.target)}"`
                            if (link.fragment !== null) attrs += ` data-fragment="${esc(link.fragment)}"`
                            if (link.alias !== null) attrs += ` data-alias="${esc(link.alias)}"`
                            return `<span${attrs}>${esc(wikilinkLabel(link))}</span>`
                        }
                    },
                },
            } as MarkdownNodeSpec,
            // Installed in onCreate, once the editor exists.
            follow: async () => false,
            resolve: async () => null,
            resolveTarget: async () => undefined,
            onResolutionsChanged: () => () => {},
        }
    },

    onCreate() {
        const editor = this.editor
        const storage = this.storage
        const resolver = this.options.resolver
        const open = this.options.open
        const cache = new Map<string, Promise<LinkResolution | null>>()
        const listeners = new Set<() => void>()
        const invalidate = () => {
            cache.clear()
            for (const listener of listeners) listener()
        }
        unsubscribers.set(editor, resolver?.subscribe?.(invalidate) ?? (() => {}))

        storage.onResolutionsChanged = (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        }

        storage.resolveTarget = (target, syntax) => {
            if (!resolver) return Promise.resolve(undefined)
            const from = openPath(editor)
            const key = `${syntax}\u0000${from ?? ''}\u0000${target}`
            let pending = cache.get(key)
            if (!pending) {
                pending = resolver.resolve(target, from, syntax).catch(() => null)
                cache.set(key, pending)
            }
            return pending
        }

        storage.resolve = async (target) => (await storage.resolveTarget(target, 'wikilink')) ?? null

        storage.follow = async (target, fragment, syntax = 'wikilink') => {
            const from = openPath(editor)
            if (!target.trim()) return revealFragment(editor, fragment)
            if (!resolver) return false
            const resolution = await storage.resolveTarget(target, syntax)
            if (!resolution) return false
            // Following a link creates a note, never another kind of file: a
            // Markdown link to a missing `www.example.com` means the site, and
            // one to a missing `report.pdf` has nothing to open.
            if (!resolution.exists && syntax === 'markdown' && !isNote(resolution.path)) {
                if (/^www\./i.test(target)) openInNewTab(`https://${target}`)
                return true
            }
            if (open) {
                await open(resolution, fragment, editor)
                return true
            }
            if (resolution.path === from) {
                revealFragment(editor, fragment)
                return true
            }
            const persistence = (editor.storage as any).persistence
            if (typeof persistence?.loadFile !== 'function' || !persistence.options?.fs) return false
            await persistence.loadFile(resolution.path, { create: !resolution.exists })
            if (!resolution.exists) invalidate()
            if (fragment) revealFragment(editor, fragment)
            return true
        }
    },

    onDestroy() {
        unsubscribers.get(this.editor)?.()
        unsubscribers.delete(this.editor)
    },

    addNodeView() {
        const storage = this.storage
        return ({ node }) => {
            let current = node
            const dom = document.createElement('a')
            dom.className = 'ezco-mde-wikilink'
            dom.setAttribute('data-wikilink', '')
            dom.setAttribute('role', 'link')
            dom.contentEditable = 'false'

            let token = 0
            const render = () => {
                const parts = attrsOf(current)
                dom.textContent = wikilinkLabel(parts)
                dom.title = formatWikilink(parts)
                const mine = ++token
                void storage.resolve(parts.target).then((resolution) => {
                    if (mine !== token) return
                    dom.classList.toggle('is-unresolved', !!resolution && !resolution.exists)
                    if (resolution) dom.setAttribute('data-path', resolution.path)
                    else dom.removeAttribute('data-path')
                })
            }
            render()
            const off = storage.onResolutionsChanged(render)

            // A click follows the link: an atom has no text to put a caret in,
            // so there is nothing else a click could mean. (Keep the mousedown
            // from moving the selection first.)
            dom.addEventListener('mousedown', (e) => {
                if (e.button === 0) e.preventDefault()
            })
            dom.addEventListener('click', (e) => {
                e.preventDefault()
                const parts = attrsOf(current)
                void storage.follow(parts.target, parts.fragment)
            })

            return {
                dom,
                update(next) {
                    if (next.type !== current.type) return false
                    current = next
                    render()
                    return true
                },
                stopEvent: (event) => event.type === 'mousedown' || event.type === 'click',
                ignoreMutation: () => true,
                destroy() {
                    token++
                    off()
                },
            }
        }
    },

    addInputRules() {
        return [
            new InputRule({
                // `[[…]]` just closed, not an embed (`![[`) or escaped (`\[[`).
                find: /(?<![!\\])\[\[([^[\]\n]+)\]\]$/,
                handler: ({ state, range, match }) => {
                    const link = parseWikilink(match[1])
                    if (!link) return null
                    const marks = state.doc.resolve(range.from).marks()
                    state.tr.replaceWith(range.from, range.to, this.type.create(link, null, marks))
                },
            }),
        ]
    },

    addKeyboardShortcuts() {
        const linkAt = (): PMNode | null => {
            const { selection } = this.editor.state
            if (selection instanceof NodeSelection) return selection.node.type === this.type ? selection.node : null
            if (!selection.empty) return null
            const { nodeBefore, nodeAfter } = selection.$from
            if (nodeBefore?.type === this.type) return nodeBefore
            if (nodeAfter?.type === this.type) return nodeAfter
            return null
        }
        return {
            // Just after a link: turn it back into its source to edit, less the
            // closing bracket (typing `]` makes it a link again).
            Backspace: () => {
                const { selection } = this.editor.state
                if (!selection.empty) return false
                const before = selection.$from.nodeBefore
                if (before?.type !== this.type) return false
                const source = formatWikilink(attrsOf(before)).slice(0, -1)
                const from = selection.from - before.nodeSize
                return this.editor
                    .chain()
                    .command(({ tr, state }) => {
                        tr.replaceWith(from, selection.from, state.schema.text(source, before.marks))
                        return true
                    })
                    .run()
            },
            'Mod-Enter': () => {
                const node = linkAt()
                if (!node) return false
                const parts = attrsOf(node)
                void this.storage.follow(parts.target, parts.fragment)
                return true
            },
        }
    },

    addProseMirrorPlugins() {
        const resolver = this.options.resolver
        if (!resolver?.suggest) return []
        const editor = this.editor
        const type = this.type
        let view: SuggestView | null = null
        return [
            new Plugin({
                key: new PluginKey('wikilinkSuggest'),
                view: () => (view = new SuggestView(editor, resolver, type)),
                props: {
                    handleKeyDown: (_, event) => view?.handleKeyDown(event) ?? false,
                },
            }),
        ]
    },
})

const unsubscribers = new WeakMap<Editor, () => void>()

interface Row {
    suggestion: LinkSuggestion
    isNew: boolean
}

/**
 * The `[[` menu: the vault's notes matching what follows the brackets, best
 * first, and a row to link a note that does not exist yet.
 */
class SuggestView {
    /** Set when an edit leaves the caret just after a new `[[`; landing the
     *  caret after an existing one does not open the menu. */
    private armed = false
    private menu: HTMLElement | null = null
    private popup: TippyInstance | null = null
    private range: { from: number; to: number } | null = null
    private rows: Row[] = []
    private selected = 0
    private token = 0
    private query: string | null = null

    constructor(
        private editor: Editor,
        private resolver: LinkResolver,
        private type: PMNode['type'],
    ) {
        this.onSelectionUpdate = this.onSelectionUpdate.bind(this)
        editor.on('selectionUpdate', this.onSelectionUpdate)
    }

    private onSelectionUpdate({ transaction }: { transaction: { docChanged: boolean } }) {
        const { selection } = this.editor.state
        const { $from } = selection
        const inCode = $from.parent.type.spec.code || $from.marks().some((m) => m.type.spec.code)
        const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
        // The name being typed: after `[[`, before any `#` or `|`.
        const m = selection.empty && !inCode ? /(?<![!\\[])\[\[([^[\]\n#|￼]*)$/.exec(before) : null
        if (!m) {
            this.armed = false
            this.hide()
            return
        }
        if (transaction.docChanged && m[1] === '') this.armed = true
        if (!this.armed) return
        this.range = { from: $from.pos - m[0].length, to: $from.pos }
        if (m[1] === this.query && this.menu) return
        this.query = m[1]
        this.selected = 0
        const mine = ++this.token
        const from = openPath(this.editor)
        void this.resolver
            .suggest!(m[1], from, 8)
            .catch(() => [] as LinkSuggestion[])
            .then((suggestions) => {
                if (mine !== this.token || !this.range) return
                const typed = m[1].trim()
                const exact = suggestions.some((s) => s.link.toLowerCase() === typed.toLowerCase())
                this.rows = suggestions.map((suggestion) => ({ suggestion, isNew: false }))
                if (typed && !exact) this.rows.push({ suggestion: { path: '', link: typed, title: typed }, isNew: true })
                this.render()
            })
    }

    handleKeyDown(event: KeyboardEvent): boolean {
        if (!this.menu || this.rows.length === 0) {
            if (this.menu && event.key === 'Escape') {
                this.hide()
                return true
            }
            return false
        }
        switch (event.key) {
            case 'ArrowDown':
                this.selected = (this.selected + 1) % this.rows.length
                this.highlight()
                return true
            case 'ArrowUp':
                this.selected = (this.selected - 1 + this.rows.length) % this.rows.length
                this.highlight()
                return true
            case 'Enter':
            case 'Tab':
                this.choose(this.rows[this.selected])
                return true
            case 'Escape':
                this.armed = false
                this.hide()
                return true
            default:
                return false
        }
    }

    private choose(row: Row | undefined) {
        if (!row || !this.range) return
        const { from, to } = this.range
        const { state } = this.editor
        // Swallow closing brackets already typed after the caret.
        const after = state.doc.textBetween(to, Math.min(to + 2, state.doc.resolve(to).end()))
        const end = to + (after.startsWith(']]') ? 2 : 0)
        const node = this.type.create({ target: row.suggestion.link, fragment: null, alias: null }, null, state.doc.resolve(from).marks())
        this.editor.chain().focus().command(({ tr }) => {
            tr.replaceWith(from, end, node)
            return true
        }).run()
        this.armed = false
        this.hide()
    }

    private render() {
        const menu = document.createElement('div')
        // Its own root class: the slash menu sweeps away any popover holding
        // `.ezco-mde-slash-menu` on every selection change. (It shares the
        // slash menu's look; the row classes are the slash menu's own.)
        menu.className = 'ezco-mde-wikilink-menu'
        menu.setAttribute('role', 'listbox')
        menu.setAttribute('aria-label', 'Link to a note')
        if (this.rows.length === 0) {
            const empty = document.createElement('div')
            empty.className = 'ezco-mde-slash-empty'
            empty.textContent = 'Type a note name'
            menu.append(empty)
        }
        this.rows.forEach((row, i) => {
            const item = document.createElement('button')
            item.type = 'button'
            item.className = 'ezco-mde-slash-item'
            item.setAttribute('role', 'option')
            const body = document.createElement('span')
            body.className = 'ezco-mde-slash-item-body'
            const title = document.createElement('span')
            title.className = 'ezco-mde-slash-item-title'
            title.textContent = row.isNew ? `New note “${row.suggestion.link}”` : row.suggestion.title ?? row.suggestion.link
            const desc = document.createElement('span')
            desc.className = 'ezco-mde-slash-item-desc'
            desc.textContent = row.isNew ? 'created when you follow the link' : row.suggestion.path
            body.append(title, desc)
            item.append(body)
            item.addEventListener('mousedown', (e) => {
                e.preventDefault()
                this.choose(row)
            })
            item.addEventListener('mouseenter', () => {
                this.selected = i
                this.highlight()
            })
            menu.append(item)
        })
        this.menu = menu
        this.highlight()
        if (this.popup) {
            this.popup.setContent(menu)
            return
        }
        const created = tippy(document.body, {
            getReferenceClientRect: () => {
                const r = this.range ?? { from: 0, to: 0 }
                const start = this.editor.view.coordsAtPos(r.from)
                const end = this.editor.view.coordsAtPos(r.to)
                return new DOMRect(start.left, start.top, Math.max(1, end.right - start.left), end.bottom - start.top)
            },
            appendTo: () => document.body,
            content: menu,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
            theme: 'ezco-mde-slash',
            maxWidth: 'none',
        }) as TippyInstance | TippyInstance[]
        this.popup = Array.isArray(created) ? created[0] : created
    }

    private highlight() {
        this.menu?.querySelectorAll('.ezco-mde-slash-item').forEach((el, i) => {
            el.classList.toggle('is-selected', i === this.selected)
            el.setAttribute('aria-selected', String(i === this.selected))
            if (i === this.selected) (el as HTMLElement).scrollIntoView?.({ block: 'nearest' })
        })
    }

    private hide() {
        this.token++
        this.popup?.destroy()
        this.popup = null
        this.menu = null
        this.range = null
        this.rows = []
        this.query = null
    }

    destroy() {
        this.editor.off('selectionUpdate', this.onSelectionUpdate)
        this.hide()
    }
}
