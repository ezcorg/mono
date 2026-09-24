/**
 * A region of a file as an editor: the RFC's region embed
 * (`![[src/lib.rs#L40-L80]]`, §2.1) is a live view of those lines that can
 * be edited in the note.
 *
 * An edit is written back by putting the region's lines in place of the
 * range in the file as it was shown, and nothing else of the file changes.
 * With a version log that is a `put` on the version shown, so a file that
 * changed since becomes a conflict copy (the region's edit applied to what
 * was shown) and the region shows the file again; without one, the file is
 * compared with what was shown and not written if it changed. When the
 * region comes to hold more or fewer lines, its range moves with them.
 */
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { basicSetup, extOrLanguageToLanguageId, getLanguageSupport, type FileVersions } from '@joinezco/codeblock'
import { extname, type VfsInterface } from '@joinezco/storage'

export interface LineRange {
    /** 1-based, inclusive. */
    from: number
    to: number
}

export interface RegionOptions {
    fs: VfsInterface
    versions?: FileVersions
    path: string
    range: LineRange
    /** The whole file as shown, and the version it is (with a log). */
    text: string
    version: string | null
    /** The region now holds a different number of lines. */
    onRange: (range: LineRange) => void
    /** The file changed since it was shown (its edit is at `copy`, with a
     *  log): show it again. */
    onStale: (copy?: string) => void
}

export interface RegionEditor {
    view: EditorView
    /** Write any edit not yet written, then stop. */
    destroy(): void
}

export function regionEditor(parent: HTMLElement, options: RegionOptions): RegionEditor {
    const { fs, versions, path } = options
    let shown = options.text
    let version = options.version
    let range = options.range
    let timer: ReturnType<typeof setTimeout> | null = null
    let writing: Promise<void> = Promise.resolve()

    const language = new Compartment()
    const lines = shown.split('\n')
    const view = new EditorView({
        parent,
        state: EditorState.create({
            doc: lines.slice(range.from - 1, range.to).join('\n'),
            extensions: [
                basicSetup,
                lineNumbers({ formatNumber: (n) => String(n + range.from - 1) }),
                language.of([]),
                EditorView.updateListener.of((update) => {
                    if (!update.docChanged) return
                    if (timer) clearTimeout(timer)
                    timer = setTimeout(write, 500)
                }),
            ],
        }),
    })
    const id = extOrLanguageToLanguageId[extname(path) as keyof typeof extOrLanguageToLanguageId]
    if (id) {
        void getLanguageSupport(id as any)
            .then((support) => support && view.dispatch({ effects: language.reconfigure(support) }))
            .catch(() => {})
    }

    function write(): Promise<void> {
        if (timer) clearTimeout(timer)
        timer = null
        const region = view.state.doc.toString().split('\n')
        writing = writing.then(async () => {
            const before = shown.split('\n')
            const next = [...before.slice(0, range.from - 1), ...region, ...before.slice(range.to)].join('\n')
            if (next === shown) return
            if (versions) {
                const result = await versions.put(path, version, next)
                if (result.ok === false) return options.onStale(result.conflict.path)
                version = result.version.id
            } else {
                if ((await fs.readFile(path)) !== shown) return options.onStale()
                await fs.writeFile(path, next)
            }
            shown = next
            const to = range.from + region.length - 1
            if (to !== range.to) {
                range = { from: range.from, to }
                options.onRange(range)
            }
        })
        return writing
    }

    return {
        view,
        destroy() {
            if (timer) void write()
            view.destroy()
        },
    }
}
