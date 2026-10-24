/**
 * Paths completed as they are typed: after a backtick (`` `./src/li ``, on
 * its way to being inline code that names a file) and as a Markdown link's
 * destination (`[the file](./src/li`). From three characters that read as
 * a path (`~/`, `./`, `../`, `/`, or a bare name, `src`), a menu under the text lists
 * the files and folders of the vault that match, drawn as the code block
 * toolbar's file browser draws them (a file's icon in its colour, folders
 * first). A file chosen fills the path in and finishes what was being
 * typed: the code (the backtick's pair closed, the text made code) or the
 * link (the text made a link to the file); a folder chosen fills it in and
 * the menu goes on inside it. Tab chooses as Enter does, as a shell's
 * completion; Escape leaves the text as typed until it is typed on. Inside
 * inline code already made, a path is completed the same way, in place.
 *
 * Paths are the vault's, as the editor's filesystem has them: `/` and `~/`
 * are its root (the notes folder is what the editor reaches; a host that
 * means the home directory maps it into its filesystem), `./` the open
 * note's folder, `../` its parent; a bare name is looked for in the note's
 * folder, and in the root when the folder has nothing of that name. Code
 * names a file: it is not a link to it, and nothing is opened. The link is
 * the other trigger.
 */
import { Editor, Extension, getMarkRange } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { FileType, type VfsInterface } from '@joinezco/storage'
import { FOLDER_ICON, getFileIcon } from '@joinezco/codeblock'
import { SuggestionMenu, type SuggestionItem } from '../ui/suggestion-menu'
import { openNotePath, persistenceOf } from './filesystem'

/** An entry the typed path may go on to. */
export interface PathCompletion {
    /** The entry's name (a folder's with its slash). */
    name: string
    /** Whether it is a folder (chosen, the menu goes on inside it). */
    directory: boolean
    /** The path as it will read once filled in, in the typed form. */
    path: string
}

/** The forms a path is written in: rooted, relative, or a bare name of the
 *  characters names are made of. */
const PATH = /(?:~\/)?[A-Za-z0-9_.\-/]+/
/** A path that says where it starts; a bare name does not. */
const ROOTED = /^(?:~\/|\.\.?\/|\/)/
/** Fewer characters than this (`~/D`, `./s`, `../`, `src`) say nothing yet. */
const MIN = 3
/** A leaf that is not text, in a textblock's text as read here. */
const LEAF = '￼'

/** `typed` read as a path (one of the forms, long enough), else null. */
function pathOf(typed: string): string | null {
    return typed.length >= MIN && new RegExp(`^${PATH.source}$`).test(typed) ? typed : null
}

/**
 * The vault folder `typedDir` (a typed path up to and including its last
 * slash) names, from a note in `noteDir` (its folder's segments): `/` for
 * the root, else `a/b`. Null for a path that climbs above the root.
 */
export function resolveDir(typedDir: string, noteDir: string[]): string | null {
    let base: string[]
    let rest: string
    if (typedDir.startsWith('~/')) {
        base = []
        rest = typedDir.slice(2)
    } else if (typedDir.startsWith('/')) {
        base = []
        rest = typedDir.slice(1)
    } else {
        // `./`, `../`, or a bare name: from the note's folder.
        base = [...noteDir]
        rest = typedDir
    }
    for (const seg of rest.split('/')) {
        if (!seg || seg === '.') continue
        if (seg === '..') {
            if (!base.length) return null
            base.pop()
        } else base.push(seg)
    }
    return base.length ? base.join('/') : '/'
}

/**
 * What `typed` may be completed to: the entries of its folder whose names
 * start with what follows its last slash (hidden ones only when that
 * starts with a dot), folders first, each alphabetically; at most `limit`.
 * Empty for a folder that is not there.
 */
export async function completions(fs: VfsInterface, typed: string, noteDir: string[], limit = 12): Promise<PathCompletion[]> {
    const slash = typed.lastIndexOf('/')
    const typedDir = typed.slice(0, slash + 1)
    const partial = typed.slice(slash + 1)
    const lower = partial.toLowerCase()
    const matches = (entries: [string, number][]) => entries.filter(([name]) => name.toLowerCase().startsWith(lower) && (partial.startsWith('.') || !name.startsWith('.')))
    const list = async (dir: string | null): Promise<[string, number][]> => {
        if (dir === null) return []
        try {
            return matches((await fs.readDir(dir)) as [string, number][])
        } catch {
            return []
        }
    }
    let matching = await list(resolveDir(typedDir, noteDir))
    // A bare name the note's folder has nothing for: the root's, then.
    if (!matching.length && !ROOTED.test(typed) && noteDir.length) matching = await list(resolveDir(typedDir, []))
    const sorted = matching.sort(([a, ta], [b, tb]) => {
        const da = ta === FileType.Directory ? 0 : 1
        const db = tb === FileType.Directory ? 0 : 1
        return da - db || a.localeCompare(b)
    })
    return sorted.slice(0, limit).map(([name, type]) => {
        const directory = type === FileType.Directory
        return { name: directory ? `${name}/` : name, directory, path: `${typedDir}${name}${directory ? '/' : ''}` }
    })
}

/** Where a path is being typed, and how it finishes. */
interface Site {
    /** `code`: after a lone backtick; `link`: a Markdown link's destination;
     *  `mark`: inside inline code already made. */
    kind: 'code' | 'link' | 'mark'
    /** The path typed so far. */
    typed: string
    /** The document range the path's text takes. */
    from: number
    to: number
    /** For `code`: the backtick's position. For `link`: where `[` is, and
     *  the text between the brackets. */
    tick?: number
    bracket?: number
    text?: string
}

/** The path being typed at the caret, if one is. */
function siteAt(editor: Editor): Site | null {
    const { state } = editor
    const { selection } = state
    if (!selection.empty) return null
    const { $from } = selection
    if ($from.parent.type.spec.code || !$from.parent.isTextblock) return null
    const code = state.schema.marks.code
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, LEAF)
    const start = $from.start()
    // Inside inline code: the code's text up to the caret.
    if (code && code.isInSet($from.marks())) {
        const range = getMarkRange($from, code)
        if (range && range.from < $from.pos) {
            const typed = state.doc.textBetween(range.from, $from.pos, undefined, LEAF)
            const path = pathOf(typed)
            return path && !/[\s￼]/.test(path) ? { kind: 'mark', typed: path, from: range.from, to: $from.pos } : null
        }
    }
    // A link's destination: `[text](path`.
    const link = new RegExp(`\\[([^[\\]￼]*)\\]\\((${PATH.source})$`).exec(before)
    if (link && pathOf(link[2])) {
        const to = $from.pos
        return { kind: 'link', typed: link[2], from: to - link[2].length, to, bracket: start + link.index, text: link[1] }
    }
    // After a lone backtick: `` `path ``.
    const tick = new RegExp(`(?<!\`)\`(${PATH.source})$`).exec(before)
    if (tick && pathOf(tick[1])) {
        const to = $from.pos
        return { kind: 'code', typed: tick[1], from: to - tick[1].length, to, tick: start + tick.index }
    }
    return null
}

class PathCompleteView {
    private menu: SuggestionMenu
    private site: Site | null = null
    private token = 0
    /** The path left as typed by Escape: not asked about again until it changes. */
    private dismissed: string | null = null
    private shownFor: string | null = null

    constructor(
        private editor: Editor,
        view: EditorView,
        private fs: VfsInterface,
    ) {
        this.menu = new SuggestionMenu({
            view,
            range: () => this.site && { from: this.site.from, to: this.site.to },
            className: 'ezco-mde-slash-menu ezco-mde-path-menu',
            label: 'Files matching the path',
            tabSelects: true,
            onClose: () => {
                this.dismissed = this.site?.typed ?? null
                this.hide()
            },
        })
        this.onUpdate = this.onUpdate.bind(this)
        editor.on('update', this.onUpdate)
        editor.on('selectionUpdate', this.onUpdate)
    }

    private onUpdate({ transaction }: { transaction: { docChanged: boolean } }) {
        const site = siteAt(this.editor)
        if (!site) {
            this.dismissed = null
            this.hide()
            return
        }
        if (this.dismissed !== null) {
            if (site.typed === this.dismissed) return
            this.dismissed = null
        }
        // Asked by typing (or by a completion, which types): landing the
        // caret in a path already there asks nothing.
        if (!transaction.docChanged && !this.menu.isOpen) return
        this.site = site
        if (site.typed === this.shownFor && this.menu.isOpen) return
        this.shownFor = site.typed
        const mine = ++this.token
        const note = openNotePath(this.editor)
        const noteDir = note ? note.split('/').slice(0, -1) : []
        void completions(this.fs, site.typed, noteDir).then((found) => {
            if (mine !== this.token || !this.site) return
            if (!found.length) {
                // Nothing there: nothing to offer (a path to a file that is
                // not in the vault is still a path).
                this.hide()
                return
            }
            this.render(found)
        })
    }

    handleKeyDown(event: KeyboardEvent): boolean {
        return this.menu.handleKeyDown(event)
    }

    private render(found: PathCompletion[]) {
        const items: SuggestionItem[] = found.map((entry) => ({
            icon: entry.directory ? FOLDER_ICON : getFileIcon(entry.name).glyph,
            title: entry.name,
            description: entry.path,
            onSelect: () => this.choose(entry),
        }))
        this.menu.show(items, '')
        // The files' icons in their colours, as the toolbar draws them.
        this.menu.dom?.querySelectorAll<HTMLElement>('.ezco-mde-slash-item').forEach((row, i) => {
            const entry = found[i]
            const icon = row.querySelector<HTMLElement>('.ezco-mde-slash-item-icon')
            if (!icon || !entry || entry.directory) return
            const color = getFileIcon(entry.name).color
            if (color) icon.style.color = color
        })
    }

    private choose(entry: PathCompletion) {
        const site = this.site
        if (!site) return
        const { state } = this.editor
        const { schema } = state
        if (entry.directory) {
            // The folder filled in; the caret after its slash, where the
            // menu goes on with what is inside.
            this.editor
                .chain()
                .focus()
                .command(({ tr }) => {
                    tr.insertText(entry.path, site.from, site.to)
                    return true
                })
                .run()
            this.shownFor = null
            return
        }
        this.hide()
        // The path filled in is a path still (and, as code, where the menu
        // would ask again): not asked about until it is typed on.
        this.dismissed = entry.path
        if (site.kind === 'code' && site.tick !== undefined && schema.marks.code) {
            // The backtick and the path become code naming the file; what is
            // typed next is text.
            const code = schema.marks.code.create()
            this.editor
                .chain()
                .focus()
                .command(({ tr }) => {
                    tr.replaceWith(site.tick!, site.to, schema.text(entry.path, [code]))
                    tr.setStoredMarks([])
                    return true
                })
                .run()
        } else if (site.kind === 'link' && site.bracket !== undefined && schema.marks.link) {
            // `[text](path` (and a `)` typed ahead) become the text, linked to the file.
            const link = schema.marks.link.create({ href: entry.path })
            const text = site.text || entry.name
            const after = state.doc.textBetween(site.to, Math.min(site.to + 1, state.doc.resolve(site.to).end()))
            const end = site.to + (after === ')' ? 1 : 0)
            this.editor
                .chain()
                .focus()
                .command(({ tr }) => {
                    tr.replaceWith(site.bracket!, end, schema.text(text, [link]))
                    tr.setStoredMarks([])
                    return true
                })
                .run()
        } else {
            // In code already: the path filled in, still code.
            const marks = state.doc.resolve(site.from).marks()
            this.editor
                .chain()
                .focus()
                .command(({ tr }) => {
                    tr.replaceWith(site.from, site.to, schema.text(entry.path, marks))
                    return true
                })
                .run()
        }
    }

    private hide() {
        this.token++
        this.menu.hide()
        this.site = null
        this.shownFor = null
    }

    destroy() {
        this.editor.off('update', this.onUpdate)
        this.editor.off('selectionUpdate', this.onUpdate)
        this.hide()
    }
}

export const PathComplete = Extension.create({
    name: 'pathComplete',

    addProseMirrorPlugins() {
        const editor = this.editor
        let view: PathCompleteView | null = null
        return [
            new Plugin({
                key: new PluginKey('pathComplete'),
                view: (editorView) => {
                    // The files are the editor's filesystem's; without one
                    // there is nothing to complete from.
                    const fs = persistenceOf(editor)?.options.fs
                    if (!fs) return { update() {}, destroy() {} }
                    return (view = new PathCompleteView(editor, editorView, fs))
                },
                props: {
                    handleKeyDown: (_, event) => view?.handleKeyDown(event) ?? false,
                },
            }),
        ]
    },
})
