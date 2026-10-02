/**
 * The links of the open note: what links to it (backlinks), and the links in
 * it that point at notes not written yet.
 *
 * Built against `LinkIndex`, never a particular index: the host supplies it
 * (a `Vault`'s `links` from `@joinezco/storage`, the icanhaz links
 * capability, anything with the same four methods). The panel asks again
 * when a file is loaded or saved and whenever the index says it changed, so
 * it follows the vault without polling.
 *
 * Rendered outside the editor body, like the outline: by default after the
 * editable (a "linked from" footer under the note, which is where a reader
 * finishes); `mount` puts it anywhere else, e.g. a sidebar column.
 *
 * Nothing of it shows until asked for (⌘⇧L, `toggleLinksPanel`, or the
 * palette), unless the host passes `open`; while hidden it asks the index
 * for nothing.
 */
import { Editor, Extension } from '@tiptap/core'
import { basename, dirname, normalizePath } from '@joinezco/storage'
import { type LinkIndex, type LinkRef } from '@joinezco/vault'
import type { SidebarMount } from './sidebar'
import type { FileSystemStorage } from './filesystem'
import type { WikilinkStorage } from './wikilink'

export interface LinksPanelOptions {
    /** The vault's links. Without one the panel renders nothing. */
    index?: LinkIndex
    /** Where to render (see `SidebarMount`); default: after the editable. */
    mount?: SidebarMount
    /** Extra class(es) on the panel root. */
    className?: string
    /** Heading over the backlinks (default "Linked from"). */
    title?: string
    /** Start shown (default: hidden until asked for). */
    open?: boolean
}

interface LinksPanelStorage {
    /** Re-read the index now (it also re-reads on its own). */
    refresh: () => Promise<void>
    /** Whether the panel is shown. */
    shown: () => boolean
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        linksPanel: {
            /** Show or hide the links panel (⌘⇧L). */
            toggleLinksPanel: () => ReturnType
        }
    }
}

/** A note's name as a reader knows it: the file name without `.md`. */
function noteName(path: string): string {
    const name = basename(path)
    return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name
}

class LinksPanelView {
    readonly dom: HTMLElement
    private backlinkList: HTMLElement
    private backlinkTitle: HTMLElement
    private danglingSection: HTMLElement
    private danglingList: HTMLElement
    private token = 0
    private scheduled = false
    private cleanups: (() => void)[] = []
    shown = false

    constructor(
        private editor: Editor,
        private index: LinkIndex,
        private options: LinksPanelOptions,
    ) {
        const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
            const node = document.createElement(tag)
            node.className = className
            return node
        }
        this.dom = el('section', 'ezco-mde-links')
        this.dom.setAttribute('aria-label', 'Links')
        for (const cls of (options.className ?? '').split(/\s+/).filter(Boolean)) this.dom.classList.add(cls)
        this.backlinkTitle = el('div', 'ezco-mde-links-title')
        this.backlinkList = el('ul', 'ezco-mde-links-list')
        this.danglingSection = el('div', 'ezco-mde-links-dangling')
        const danglingTitle = el('div', 'ezco-mde-links-title')
        danglingTitle.textContent = 'Not written yet'
        this.danglingList = el('ul', 'ezco-mde-links-list')
        this.danglingSection.append(danglingTitle, this.danglingList)
        this.dom.append(this.backlinkTitle, this.backlinkList, this.danglingSection)
        this.mount(options.mount)

        const persistence = this.persistence()
        if (persistence) this.cleanups.push(persistence.subscribe(() => this.schedule()))
        if (index.subscribe) this.cleanups.push(index.subscribe(() => this.schedule()))
        this.setShown(!!options.open)
    }

    /** Show or hide the panel; read the index when shown. */
    setShown(shown: boolean) {
        this.shown = shown
        this.dom.hidden = !shown
        if (shown) void this.refresh()
    }

    toggleShown() {
        this.setShown(!this.shown)
        if (this.shown) this.dom.scrollIntoView({ block: 'nearest' })
    }

    private persistence(): FileSystemStorage | undefined {
        return (this.editor.storage as any).persistence as FileSystemStorage | undefined
    }

    private currentPath(): string | null {
        const path = this.persistence()?.options.filepath
        return path ? normalizePath(path) : null
    }

    private mount(mount: SidebarMount | undefined) {
        const editable = this.editor.view.dom as HTMLElement
        const root = editable.parentElement
        if (mount instanceof HTMLElement) mount.appendChild(this.dom)
        else if (typeof mount === 'function' && root) {
            const container = mount(root)
            if (container instanceof HTMLElement) container.appendChild(this.dom)
        } else editable.after(this.dom)
    }

    /** Coalesce a burst of triggers (a save and the index's notice of it)
     *  into one read. */
    private schedule() {
        if (this.scheduled) return
        this.scheduled = true
        setTimeout(() => {
            this.scheduled = false
            void this.refresh()
        }, 0)
    }

    async refresh(): Promise<void> {
        if (!this.shown) return
        const path = this.currentPath()
        const mine = ++this.token
        if (!path) {
            this.dom.classList.add('ezco-mde-links--empty')
            return
        }
        let backlinks: LinkRef[] = []
        let dangling: LinkRef[] = []
        try {
            ;[backlinks, dangling] = await Promise.all([this.index.backlinks(path), this.index.unresolved()])
        } catch (e) {
            console.warn('[LinksPanel] the link index failed:', e)
        }
        if (mine !== this.token) return
        this.dom.classList.remove('ezco-mde-links--empty')
        this.renderBacklinks(backlinks, path)
        this.renderDangling(dangling.filter((l) => normalizePath(l.source) === path))
    }

    private renderBacklinks(links: LinkRef[], path: string) {
        // One row per linking note, in the index's order.
        const bySource = new Map<string, LinkRef[]>()
        for (const link of links) {
            if (normalizePath(link.source) === path) continue
            const rows = bySource.get(link.source) ?? []
            rows.push(link)
            bySource.set(link.source, rows)
        }
        this.backlinkTitle.textContent = `${this.options.title ?? 'Linked from'}${bySource.size ? ` · ${bySource.size}` : ''}`
        if (bySource.size === 0) {
            const empty = document.createElement('li')
            empty.className = 'ezco-mde-links-empty'
            empty.textContent = 'No notes link here yet.'
            this.backlinkList.replaceChildren(empty)
            return
        }
        this.backlinkList.replaceChildren(
            ...[...bySource].map(([source, rows]) =>
                this.row(noteName(source), dirname(source), rows.length > 1 ? `${rows.length} links` : `line ${rows[0].line}`, () =>
                    void this.open(source, path),
                ),
            ),
        )
    }

    private renderDangling(links: LinkRef[]) {
        const targets = [...new Set(links.map((l) => l.target))]
        this.danglingSection.hidden = targets.length === 0
        this.danglingList.replaceChildren(
            ...targets.map((target) => this.row(noteName(target), dirname(target), 'create', () => void this.create(target))),
        )
    }

    private row(name: string, folder: string, meta: string, activate: () => void): HTMLElement {
        const li = document.createElement('li')
        li.className = 'ezco-mde-links-item'
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'ezco-mde-links-link'
        const label = document.createElement('span')
        label.className = 'ezco-mde-links-name'
        label.textContent = name
        button.append(label)
        if (folder) {
            const dir = document.createElement('span')
            dir.className = 'ezco-mde-links-folder'
            dir.textContent = folder
            button.append(dir)
        }
        const info = document.createElement('span')
        info.className = 'ezco-mde-links-meta'
        info.textContent = meta
        button.append(info)
        button.addEventListener('mousedown', (e) => e.preventDefault())
        button.addEventListener('click', activate)
        li.append(button)
        return li
    }

    /** Open a note that links here, and show the first link back. */
    private async open(source: string, from: string) {
        const persistence = this.persistence()
        if (!persistence) return
        await persistence.loadFile(source)
        const wikilink = (this.editor.storage as any).wikilink as WikilinkStorage | undefined
        if (!wikilink) return
        const found: { pos: number; target: string }[] = []
        this.editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'wikilink') found.push({ pos, target: node.attrs.target })
        })
        for (const { pos, target } of found) {
            const resolution = await wikilink.resolve(target)
            if (resolution?.path !== from) continue
            this.editor.chain().setNodeSelection(pos).scrollIntoView().run()
            return
        }
    }

    private async create(target: string) {
        await this.persistence()?.loadFile(target, { create: true })
    }

    destroy() {
        this.token++
        for (const cleanup of this.cleanups) cleanup()
        this.dom.remove()
    }
}

export const LinksPanel = Extension.create<LinksPanelOptions, LinksPanelStorage>({
    name: 'linksPanel',

    addOptions() {
        return { index: undefined, mount: undefined, className: undefined, title: undefined, open: false }
    },

    addStorage() {
        return { refresh: async () => {}, shown: () => false }
    },

    addCommands() {
        return {
            toggleLinksPanel:
                () =>
                ({ editor }) => {
                    const view = views.get(editor)
                    if (!view) return false
                    view.toggleShown()
                    return true
                },
        }
    },

    addKeyboardShortcuts() {
        return { 'Mod-Shift-l': () => this.editor.commands.toggleLinksPanel() }
    },

    onCreate() {
        if (!this.options.index) return
        const view = new LinksPanelView(this.editor, this.options.index, this.options)
        views.set(this.editor, view)
        this.storage.refresh = () => view.refresh()
        this.storage.shown = () => view.shown
    },

    onDestroy() {
        views.get(this.editor)?.destroy()
        views.delete(this.editor)
    },
})

const views = new WeakMap<Editor, LinksPanelView>()
