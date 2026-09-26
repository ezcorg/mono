/**
 * The vault as a tree of folders and files, beside the editor.
 *
 * Built on interfaces only: the filesystem lists folders (`readDir`, a folder
 * read when it is opened), `FileOperations` creates, moves and deletes (so in
 * a vault a rename keeps links working), and a change notice (the vault's
 * `subscribe`) refreshes what is shown. It follows the open file: its row is
 * marked and its folders opened.
 *
 * Keyboard first, as an ARIA tree: arrows move and open or close folders,
 * Enter opens a file, F2 renames in place, Delete asks (in the row) and
 * deletes, Escape closes the tree and returns to the note. The header makes
 * a new note or folder in the selected folder.
 *
 * Nothing of it shows until asked for (⌘⇧E, or `toggleFileTree`), unless
 * the host passes `open`; while closed it reads no folders. The palette
 * (⌘P) finds files by name; the tree is for looking around folders.
 */
import { Editor, Extension } from '@tiptap/core'
import { FileType, basename, dirname, extname, isHidden, joinPath, normalizePath, type FileOperations, type VfsInterface } from '@joinezco/storage'
import type { SidebarMount } from './sidebar'
import type { FileSystemStorage } from './filesystem'
import { mountInRail } from './rail'

export interface FileTreeOptions {
    /** Where to render (see `SidebarMount`); by default before the editor. */
    mount?: SidebarMount
    className?: string
    /** Heading over the tree (default "Files"). */
    title?: string
    /** Creates, moves and deletes files. Supplied by the editor's setup. */
    files?: FileOperations
    /** Be told when the vault changed. Supplied by the editor's setup. */
    subscribe?: (listener: () => void) => () => void
    /** Leave paths out of the tree (default: dot-files and dot-folders). */
    ignore?: (path: string) => boolean
    /** Start open (default: closed to its header). */
    open?: boolean
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        fileTree: {
            /** Show or hide the file tree (⌘⇧E). */
            toggleFileTree: () => ReturnType
        }
    }
}

interface Entry {
    path: string
    name: string
    folder: boolean
}

class FileTreeView {
    readonly dom: HTMLElement
    private list: HTMLElement
    private status: HTMLElement
    private toggle: HTMLButtonElement
    private unmount: () => void = () => {}
    private actions: HTMLElement
    private shown = false
    /** Folders shown open. */
    private open = new Set<string>([''])
    /** What each open folder holds, as last read. */
    private children = new Map<string, Entry[]>()
    /** The row with focus (roving tabindex). */
    private active: string | null = null
    private renaming: string | null = null
    private confirming: string | null = null
    private cleanups: (() => void)[] = []
    private scheduled = false
    /** Focus goes to the tree once it is drawn (it was asked for). */
    private focusOnDraw = false

    constructor(
        private editor: Editor,
        private options: FileTreeOptions,
    ) {
        this.dom = document.createElement('nav')
        this.dom.className = 'ezco-mde-files'
        this.dom.setAttribute('aria-label', 'Files')
        for (const cls of (options.className ?? '').split(/\s+/).filter(Boolean)) this.dom.classList.add(cls)

        const header = document.createElement('div')
        header.className = 'ezco-mde-files-header'
        this.toggle = document.createElement('button')
        this.toggle.type = 'button'
        this.toggle.className = 'ezco-mde-files-toggle'
        this.toggle.title = 'Show or hide the files (⌘⇧E)'
        const title = document.createElement('span')
        title.className = 'ezco-mde-files-title'
        title.textContent = options.title ?? 'Files'
        this.toggle.append(title)
        this.toggle.addEventListener('mousedown', (e) => e.preventDefault())
        this.toggle.addEventListener('click', () => this.setShown(!this.shown))
        this.actions = document.createElement('span')
        this.actions.className = 'ezco-mde-files-actions'
        this.actions.append(this.button('+', 'New note', () => void this.createNote()), this.button('⊞', 'New folder', () => void this.createFolder()))
        header.append(this.toggle, this.actions)
        this.list = document.createElement('ul')
        this.list.className = 'ezco-mde-files-list'
        this.list.id = `ezco-mde-files-${++treeCount}`
        this.toggle.setAttribute('aria-controls', this.list.id)
        this.list.setAttribute('role', 'tree')
        this.list.addEventListener('keydown', (e) => this.onKeyDown(e))
        // The keys act on the focused row, however focus got there (Tab, a
        // screen reader, a click), and that row is the one Tab returns to.
        this.list.addEventListener('focusin', (e) => {
            const path = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]')?.dataset.path
            if (!path || path === this.active) return
            this.active = path
            for (const el of this.list.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
                el.tabIndex = el.dataset.path === path ? 0 : -1
            }
        })
        this.status = document.createElement('div')
        this.status.className = 'ezco-mde-files-status'
        this.status.setAttribute('role', 'status')
        this.dom.append(header, this.list, this.status)
        this.mount(options.mount)
        this.setShown(!!options.open, false)

        const persistence = this.persistence()
        if (persistence) {
            this.cleanups.push(
                persistence.subscribe((event) => {
                    // A save changes no name the tree shows; the vault's own
                    // notice covers a file made or moved by the save.
                    if (event.type === 'load') this.reveal(event.path)
                    else if (event.type !== 'save') this.schedule()
                }),
            )
        }
        if (options.subscribe) this.cleanups.push(options.subscribe(() => this.schedule()))
        const current = this.currentPath()
        if (current) this.reveal(current)
        else void this.refresh()
    }

    /** Show or hide the tree (nothing of it shows while hidden); read it when shown. */
    setShown(shown: boolean, read = true) {
        this.shown = shown
        this.dom.hidden = !shown
        this.dom.classList.toggle('is-collapsed', !shown)
        this.toggle.setAttribute('aria-expanded', String(shown))
        this.list.hidden = !shown
        this.status.hidden = !shown
        this.actions.hidden = !shown
        if (shown && read) {
            const current = this.currentPath()
            if (current) this.reveal(current)
            else void this.refresh()
        }
    }

    toggleShown() {
        const hadFocus = this.dom.contains(document.activeElement)
        // Opened: the keys work at once, on the open file's row (drawn
        // first, when the tree had not been read yet).
        this.focusOnDraw = !this.shown
        this.setShown(!this.shown)
        if (this.shown) this.focusRow(this.active ?? this.currentPath() ?? this.visible()[0]?.path ?? '')
        else if (hadFocus) this.editor.commands.focus()
    }

    private get fs(): VfsInterface | undefined {
        return this.persistence()?.options.fs
    }

    private persistence(): FileSystemStorage | undefined {
        return (this.editor.storage as any).persistence as FileSystemStorage | undefined
    }

    private currentPath(): string | null {
        const path = this.persistence()?.options.filepath
        return path ? normalizePath(path) : null
    }

    private ignored(path: string): boolean {
        return (this.options.ignore ?? isHidden)(path)
    }

    private button(glyph: string, label: string, onClick: () => void): HTMLElement {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'ezco-mde-files-action'
        b.textContent = glyph
        b.title = label
        b.setAttribute('aria-label', label)
        b.addEventListener('mousedown', (e) => e.preventDefault())
        b.addEventListener('click', onClick)
        return b
    }

    private mount(mount: SidebarMount | undefined) {
        // In the rail beside the note, shared with the outline.
        this.unmount = mountInRail(this.dom, mount, this.editor.view.dom.parentElement as HTMLElement | null)
    }

    private schedule() {
        if (this.scheduled) return
        this.scheduled = true
        setTimeout(() => {
            this.scheduled = false
            void this.refresh()
        }, 0)
    }

    /** Open the folders down to `path`, and mark it. */
    private reveal(path: string) {
        const clean = normalizePath(path)
        let dir = dirname(clean)
        while (dir) {
            this.open.add(dir)
            dir = dirname(dir)
        }
        this.active = clean
        void this.refresh()
    }

    /** Re-read every open folder and draw the tree (not while it is closed:
     *  opening it reads it). */
    async refresh(): Promise<void> {
        const fs = this.fs
        if (!fs || !this.shown) return
        const next = new Map<string, Entry[]>()
        for (const folder of [...this.open]) {
            try {
                const entries = await fs.readDir(folder || '/')
                next.set(
                    folder,
                    entries
                        .map(([name, type]): Entry => ({ path: joinPath(folder, name), name, folder: type === FileType.Directory }))
                        .filter((e) => !this.ignored(e.path))
                        .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true })),
                )
            } catch {
                if (folder) this.open.delete(folder)
            }
        }
        this.children = next
        this.draw()
    }

    private draw() {
        // Not over an edit in progress: redrawing would replace the input
        // being typed in (and its blur would end the edit). The next draw
        // after the edit shows whatever changed meanwhile.
        if (this.renaming && this.list.querySelector('.ezco-mde-files-rename')) return
        const current = this.currentPath()
        const rows: HTMLElement[] = []
        const walk = (folder: string, depth: number) => {
            for (const entry of this.children.get(folder) ?? []) {
                rows.push(this.row(entry, depth, entry.path === current))
                if (entry.folder && this.open.has(entry.path)) walk(entry.path, depth + 1)
            }
        }
        walk('', 0)
        // Focus stays on the tree when a redraw replaces the row that had it.
        const hadFocus = this.list.contains(document.activeElement)
        this.list.replaceChildren(...rows)
        if (!rows.length) {
            const empty = document.createElement('li')
            empty.className = 'ezco-mde-files-empty'
            empty.textContent = 'No files yet.'
            this.list.append(empty)
        }
        const focusable = rows.find((r) => r.dataset.path === this.active) ?? rows[0]
        focusable?.setAttribute('tabindex', '0')
        if ((hadFocus || this.focusOnDraw) && focusable) {
            this.focusOnDraw = false
            focusable.focus()
        }
        this.dom.classList.toggle('ezco-mde-files--empty', !rows.length)
    }

    private row(entry: Entry, depth: number, isCurrent: boolean): HTMLElement {
        const li = document.createElement('li')
        li.className = 'ezco-mde-files-item'
        li.setAttribute('role', 'treeitem')
        li.dataset.path = entry.path
        li.style.setProperty('--depth', String(depth))
        li.setAttribute('aria-level', String(depth + 1))
        li.tabIndex = -1
        if (entry.folder) li.setAttribute('aria-expanded', String(this.open.has(entry.path)))
        li.classList.toggle('is-folder', entry.folder)
        li.classList.toggle('is-current', isCurrent)
        if (isCurrent) li.setAttribute('aria-current', 'page')

        if (this.renaming === entry.path) {
            const input = document.createElement('input')
            input.className = 'ezco-mde-files-rename'
            input.value = entry.name
            input.setAttribute('aria-label', `Rename ${entry.name}`)
            input.addEventListener('keydown', (e) => {
                e.stopPropagation()
                if (e.key === 'Enter') void this.finishRename(entry, input.value)
                else if (e.key === 'Escape') this.cancelEdit(entry.path)
            })
            input.addEventListener('blur', () => {
                if (this.renaming === entry.path) void this.finishRename(entry, input.value)
            })
            li.append(input)
            queueMicrotask(() => {
                input.focus()
                // Select the name without its extension, as file managers do.
                const ext = entry.folder ? '' : extname(entry.name)
                input.setSelectionRange(0, ext ? entry.name.length - ext.length - 1 : entry.name.length)
            })
            return li
        }

        const label = document.createElement('span')
        label.className = 'ezco-mde-files-name'
        label.textContent = this.confirming === entry.path ? `Delete ${entry.name}? Enter / Esc` : entry.name
        li.classList.toggle('is-confirming', this.confirming === entry.path)
        li.append(label)
        li.addEventListener('mousedown', (e) => e.preventDefault())
        li.addEventListener('click', () => {
            this.focusRow(entry.path)
            void this.activate(entry)
        })
        return li
    }

    private focusRow(path: string) {
        this.active = path
        for (const el of this.list.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
            const mine = el.dataset.path === path
            el.tabIndex = mine ? 0 : -1
            if (mine) el.focus()
        }
    }

    private async activate(entry: Entry) {
        if (entry.folder) {
            if (this.open.has(entry.path)) this.open.delete(entry.path)
            else this.open.add(entry.path)
            await this.refresh()
            this.focusRow(entry.path)
            return
        }
        await this.persistence()?.loadFile(entry.path)
    }

    /** The entries as shown, in order. */
    private visible(): Entry[] {
        const out: Entry[] = []
        const walk = (folder: string) => {
            for (const entry of this.children.get(folder) ?? []) {
                out.push(entry)
                if (entry.folder && this.open.has(entry.path)) walk(entry.path)
            }
        }
        walk('')
        return out
    }

    private onKeyDown(e: KeyboardEvent) {
        const rows = this.visible()
        const at = rows.findIndex((r) => r.path === this.active)
        const entry = rows[at]
        if (this.confirming) {
            // Enter deletes, Escape does not; any other key is not an answer
            // and goes on to what it usually does, the question withdrawn.
            if (e.key === 'Enter' || e.key === 'Escape') e.preventDefault()
            if (e.key === 'Enter') void this.remove(this.confirming)
            else this.cancelEdit(this.confirming)
            return
        }
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
            e.preventDefault()
            this.toggleShown()
            return
        }
        const move = (to: number) => {
            const target = rows[Math.max(0, Math.min(rows.length - 1, to))]
            if (target) this.focusRow(target.path)
        }
        switch (e.key) {
            case 'ArrowDown':
                move(at + 1)
                break
            case 'ArrowUp':
                move(at - 1)
                break
            case 'Home':
                move(0)
                break
            case 'End':
                move(rows.length - 1)
                break
            case 'ArrowRight':
                if (entry?.folder && !this.open.has(entry.path)) void this.activate(entry)
                else if (entry?.folder) move(at + 1)
                break
            case 'ArrowLeft':
                if (entry?.folder && this.open.has(entry.path)) void this.activate(entry)
                else if (entry && dirname(entry.path)) this.focusRow(dirname(entry.path))
                break
            case 'Enter':
            case ' ':
                if (entry) void this.activate(entry)
                break
            case 'F2':
                if (entry) this.startRename(entry.path)
                break
            case 'Delete':
                if (entry && !entry.folder) {
                    this.confirming = entry.path
                    this.draw()
                    this.focusRow(entry.path)
                }
                break
            case 'Escape':
                this.setShown(false)
                this.editor.commands.focus()
                break
            default:
                return
        }
        e.preventDefault()
    }

    startRename(path: string) {
        this.renaming = path
        this.list.querySelector('.ezco-mde-files-rename')?.remove()
        this.draw()
    }

    private cancelEdit(path: string) {
        this.renaming = null
        this.confirming = null
        this.draw()
        this.focusRow(path)
    }

    private say(text: string) {
        this.status.textContent = text
    }

    private async finishRename(entry: Entry, name: string) {
        this.renaming = null
        const files = this.options.files
        const to = joinPath(dirname(entry.path), name.trim())
        if (!files || !name.trim() || to === entry.path || name.includes('/')) {
            this.cancelEdit(entry.path)
            return
        }
        const persistence = this.persistence()
        const current = this.currentPath()
        const opened = current === entry.path || (entry.folder && !!current?.startsWith(`${entry.path}/`))
        try {
            if (opened) await persistence?.flushPendingSave()
            const rewritten = await files.rename(entry.path, to)
            if (this.open.delete(entry.path)) this.open.add(to)
            this.active = to
            this.say(rewritten ? `Renamed; ${rewritten} link${rewritten === 1 ? '' : 's'} updated.` : 'Renamed.')
            if (opened && current) await persistence?.loadFile(to + current.slice(entry.path.length))
        } catch (err) {
            this.say(`Could not rename: ${(err as Error).message}`)
        }
        await this.refresh()
        this.focusRow(this.active ?? to)
    }

    private async remove(path: string) {
        this.confirming = null
        const files = this.options.files
        if (!files) return
        try {
            if (this.currentPath() === path) await this.persistence()?.close({ discard: true })
            await files.remove(path)
            this.say(`Deleted ${basename(path)}.`)
        } catch (err) {
            this.say(`Could not delete: ${(err as Error).message}`)
        }
        await this.refresh()
    }

    /** The folder new files go in: the selected folder, or the selected file's. */
    private targetFolder(): string {
        const active = this.active
        if (!active) return ''
        const entry = this.visible().find((e) => e.path === active)
        return entry?.folder ? entry.path : dirname(active)
    }

    private async unused(folder: string, stem: string, ext: string): Promise<string> {
        const fs = this.fs
        for (let n = 1; ; n++) {
            const path = joinPath(folder, `${stem}${n > 1 ? ` ${n}` : ''}${ext}`)
            if (!(await fs?.exists(path))) return path
        }
    }

    private async createNote() {
        const files = this.options.files
        if (!files) return
        const folder = this.targetFolder()
        const path = await this.unused(folder, 'Untitled', '.md')
        await files.create(path, '')
        if (folder) this.open.add(folder)
        // The name field keeps focus (the editor taking it would end the edit).
        await this.persistence()?.loadFile(path, { focus: false })
        this.startRename(path)
    }

    private async createFolder() {
        const files = this.options.files
        if (!files) return
        const folder = this.targetFolder()
        const path = await this.unused(folder, 'New folder', '')
        await files.mkdir(path)
        if (folder) this.open.add(folder)
        this.active = path
        await this.refresh()
        this.startRename(path)
    }

    destroy() {
        for (const cleanup of this.cleanups) cleanup()
        this.unmount()
    }
}

let treeCount = 0

export const FileTree = Extension.create<FileTreeOptions>({
    name: 'fileTree',

    addOptions() {
        return { mount: undefined, className: undefined, title: undefined, files: undefined, subscribe: undefined, ignore: undefined, open: false }
    },

    addCommands() {
        return {
            toggleFileTree:
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
        return { 'Mod-Shift-e': () => this.editor.commands.toggleFileTree() }
    },

    onCreate() {
        views.set(this.editor, new FileTreeView(this.editor, this.options))
    },

    onDestroy() {
        views.get(this.editor)?.destroy()
        views.delete(this.editor)
    },
})

const views = new WeakMap<Editor, FileTreeView>()
