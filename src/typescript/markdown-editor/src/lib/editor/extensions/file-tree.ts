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
 * deletes. The header makes a new note or folder in the selected folder.
 */
import { Editor, Extension } from '@tiptap/core'
import { FileType, basename, dirname, extname, isHidden, joinPath, normalizePath, type FileOperations, type VfsInterface } from '@joinezco/storage'
import type { SidebarMount } from './sidebar'
import type { FileSystemStorage } from './filesystem'

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
        const title = document.createElement('span')
        title.className = 'ezco-mde-files-title'
        title.textContent = options.title ?? 'Files'
        header.append(title, this.button('+', 'New note', () => void this.createNote()), this.button('⊞', 'New folder', () => void this.createFolder()))
        this.list = document.createElement('ul')
        this.list.className = 'ezco-mde-files-list'
        this.list.setAttribute('role', 'tree')
        this.list.addEventListener('keydown', (e) => this.onKeyDown(e))
        this.status = document.createElement('div')
        this.status.className = 'ezco-mde-files-status'
        this.status.setAttribute('role', 'status')
        this.dom.append(header, this.list, this.status)
        this.mount(options.mount)

        const persistence = this.persistence()
        if (persistence) {
            this.cleanups.push(
                persistence.subscribe((event) => {
                    if (event.type === 'load') this.reveal(event.path)
                    else this.schedule()
                }),
            )
        }
        if (options.subscribe) this.cleanups.push(options.subscribe(() => this.schedule()))
        const current = this.currentPath()
        if (current) this.reveal(current)
        else void this.refresh()
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
        const root = this.editor.view.dom.parentElement as HTMLElement | null
        if (mount instanceof HTMLElement) mount.appendChild(this.dom)
        else if (typeof mount === 'function' && root) {
            const container = mount(root)
            if (container instanceof HTMLElement) container.appendChild(this.dom)
        } else if (root?.parentElement) root.parentElement.insertBefore(this.dom, root)
        else document.body.appendChild(this.dom)
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

    /** Re-read every open folder and draw the tree. */
    async refresh(): Promise<void> {
        const fs = this.fs
        if (!fs) return
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
        this.list.replaceChildren(...rows)
        if (!rows.length) {
            const empty = document.createElement('li')
            empty.className = 'ezco-mde-files-empty'
            empty.textContent = 'No files yet.'
            this.list.append(empty)
        }
        const focusable = rows.find((r) => r.dataset.path === this.active) ?? rows[0]
        focusable?.setAttribute('tabindex', '0')
        this.dom.classList.toggle('ezco-mde-files--empty', !rows.length)
    }

    private row(entry: Entry, depth: number, isCurrent: boolean): HTMLElement {
        const li = document.createElement('li')
        li.className = 'ezco-mde-files-item'
        li.setAttribute('role', 'treeitem')
        li.dataset.path = entry.path
        li.style.setProperty('--depth', String(depth))
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
            e.preventDefault()
            if (e.key === 'Enter') void this.remove(this.confirming)
            else if (e.key === 'Escape') this.cancelEdit(this.confirming)
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
            case 'Backspace':
                if (entry && !entry.folder) {
                    this.confirming = entry.path
                    this.draw()
                    this.focusRow(entry.path)
                }
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
        this.dom.remove()
    }
}

export const FileTree = Extension.create<FileTreeOptions>({
    name: 'fileTree',

    addOptions() {
        return { mount: undefined, className: undefined, title: undefined, files: undefined, subscribe: undefined, ignore: undefined }
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
