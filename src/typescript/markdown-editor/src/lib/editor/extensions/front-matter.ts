/**
 * Front matter: the YAML block a note may open with, between `---` fences.
 * It is where a note keeps its properties, and its identity (`id:`, RFC §3).
 *
 * The node holds the YAML exactly as written and serializes it back
 * untouched. It shows as the note's code blocks do: the YAML in a code
 * editor (`@joinezco/codeblock`, as a YAML file, without the toolbar),
 * which collapses to one small line at the top of the note, "2
 * properties · id, title", when it is not being edited. A click on the
 * line, arrowing up from the note's first line, or the "Edit properties"
 * block action opens it with the caret in the YAML; leaving it (a click in
 * the note, Escape, arrowing down past its last line) collapses it again.
 * The collapsing is the reader's to turn off, from the block's own action
 * in the gutter ("Collapse when not editing"); the choice is kept. The
 * document admits it only as its first node: `FrontMatterDocument`
 * replaces the default document for that.
 *
 * With `assignId`, a note opened without an `id:` is given one (as an edit,
 * so autosave writes it, and outside the undo history). That is the host's
 * policy, not the editor's: a viewer that must not write leaves it unset.
 */
import { Editor, Node, mergeAttributes } from '@tiptap/core'
import { readKept, writeKept } from '../ui/kept'
import { settingsOf } from '../settings'
import Document from '@tiptap/extension-document'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from '@tiptap/pm/state'
import { EditorView, keymap, type KeyBinding, type ViewUpdate } from '@codemirror/view'
import { EditorState as CMState } from '@codemirror/state'
import { basicSetup, codeblock } from '@joinezco/codeblock'
import { memoryVfs, normalizePath } from '@joinezco/storage'
import { isNote } from '@joinezco/vault'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import { codeblockRegistry, isDarkMode, measureBaseFontPx } from './codeblock'
import type { FileSystemStorage } from './filesystem'

export interface FrontMatterOptions {
    /** Give a note opened without an `id:` a new one. */
    assignId?: () => string
}

export interface FrontMatterStorage {
    /** Whether the YAML folds to one line when it is not being edited. */
    autoCollapse: boolean
    /** The views showing front matter, told when `autoCollapse` changes. */
    refresh: Set<() => void>
    markdown: MarkdownNodeSpec
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        frontMatter: {
            /** Open the front matter with the caret at the end of its YAML. */
            editFrontMatter: () => ReturnType
            /** Fold the YAML away when it is not being edited, or keep it open. */
            setFrontMatterAutoCollapse: (on: boolean) => ReturnType
        }
    }
}

/** Transactions that put the caret in the front matter on purpose. */
export const frontMatterKey = new PluginKey('frontMatter')
/** Where the reader's choice to keep the YAML open is kept. */
const COLLAPSE_KEY = 'ezco-mde-front-matter'

function keptAutoCollapse(): boolean {
    return readKept(COLLAPSE_KEY) !== 'open'
}

function keepAutoCollapse(on: boolean) {
    writeKept(COLLAPSE_KEY, on ? null : 'open')
}

/** The document, with room for front matter before its blocks. */
export const FrontMatterDocument = Document.extend({
    content: 'frontMatter? block+',
})

/** The `id:` of the open document's front matter, or null. */
export function documentId(editor: Editor): string | null {
    const first = editor.state.doc.firstChild
    if (first?.type.name !== 'frontMatter') return null
    const m = /^id[ \t]*:[ \t]*(.*?)[ \t]*$/m.exec(first.textContent)
    const value = m?.[1].replace(/^(['"])(.*)\1$/, '$2').trim()
    return value || null
}

/** The top-level keys of `yaml`, as far as its lines say (no parse: the
 *  line is a summary, and the YAML may be mid-edit). */
export function topLevelKeys(yaml: string): string[] {
    const keys: string[] = []
    for (const line of yaml.split('\n')) {
        const m = /^([A-Za-z0-9_.-]+)[ \t]*:(?:[ \t]|$)/.exec(line)
        if (m) keys.push(m[1])
    }
    return keys
}

export const FrontMatter = Node.create<FrontMatterOptions, FrontMatterStorage>({
    name: 'frontMatter',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    isolating: true,

    addOptions() {
        return { assignId: undefined }
    },

    addAttributes() {
        return {
            // The closing fence as written: `---`, or YAML's `...`.
            close: {
                default: '---',
                parseHTML: (el) => (el.getAttribute('data-close') === '...' ? '...' : '---'),
                renderHTML: (attrs) => ({ 'data-close': attrs.close }),
            },
        }
    },

    parseHTML() {
        return [
            {
                tag: 'pre[data-front-matter]',
                preserveWhitespace: 'full',
                priority: 60,
                // The YAML comes in an attribute: a newline at the start of a
                // `<pre>` is dropped by HTML parsing, and the text is parsed
                // twice on its way in. Pasted HTML has only the text.
                getContent: (dom, schema) => {
                    const yaml = (dom as HTMLElement).getAttribute('data-yaml') ?? dom.textContent ?? ''
                    return yaml ? Fragment.from(schema.text(yaml)) : Fragment.empty
                },
            },
        ]
    },

    renderHTML({ HTMLAttributes }) {
        return ['pre', mergeAttributes(HTMLAttributes, { 'data-front-matter': '' }), 0]
    },

    addStorage() {
        return {
            autoCollapse: keptAutoCollapse(),
            refresh: new Set<() => void>(),
            markdown: {
                serialize(state: any, node: PMNode) {
                    state.write('---\n')
                    if (node.textContent) {
                        state.text(node.textContent, false)
                        // Every line of the YAML ends here, a blank last one included.
                        state.write('\n')
                    }
                    state.write(node.attrs.close)
                    state.closeBlock(node)
                },
                parse: {
                    setup(markdownit: any) {
                        if (markdownit.__ezcoFrontMatter) return
                        markdownit.__ezcoFrontMatter = true
                        markdownit.block.ruler.before(
                            'table',
                            'ezco_front_matter',
                            (state: any, startLine: number, endLine: number, silent: boolean) => {
                                // Only the first line of the document, unindented.
                                if (startLine !== 0 || state.parentType !== 'root' || state.sCount[0] !== 0) return false
                                const line = (n: number) => state.src.slice(state.bMarks[n], state.eMarks[n])
                                if (line(0) !== '---') return false
                                let close = -1
                                for (let n = 1; n < endLine; n++) {
                                    const text = line(n)
                                    if (text === '---' || text === '...') {
                                        close = n
                                        break
                                    }
                                }
                                if (close < 0) return false
                                if (silent) return true
                                const token = state.push('ezco_front_matter', 'pre', 0)
                                token.content = close > 1 ? state.src.slice(state.bMarks[1], state.eMarks[close - 1]) : ''
                                token.meta = { close: line(close) }
                                token.map = [0, close + 1]
                                state.line = close + 1
                                return true
                            },
                        )
                        const esc = markdownit.utils.escapeHtml
                        markdownit.renderer.rules.ezco_front_matter = (tokens: any[], idx: number) =>
                            `<pre data-front-matter="" data-close="${esc(tokens[idx].meta.close)}" data-yaml="${esc(tokens[idx].content)}"></pre>`
                    },
                },
            } as MarkdownNodeSpec,
        }
    },

    addProseMirrorPlugins() {
        const type = this.type
        return [
            new Plugin({
                key: new PluginKey('frontMatterCaret'),
                // A document's first caret position is inside its front matter,
                // so loading a note (or "focus the start") would open on the
                // YAML. The caret goes there only when sent (a click, an arrow
                // key); anything else lands at the start of the body.
                appendTransaction(transactions, oldState, newState) {
                    // A selection (select all, a drag over the top of the note)
                    // is left as it is: only a caret is moved.
                    if (!newState.selection.empty) return null
                    if (!inFrontMatter(newState, type) || inFrontMatter(oldState, type)) return null
                    const deliberate = transactions.some((tr) => tr.getMeta(frontMatterKey) || tr.getMeta('pointer'))
                    return deliberate ? null : newState.tr.setSelection(bodyStart(newState))
                },
            }),
        ]
    },

    addCommands() {
        const type = this.type
        const storage = this.storage
        return {
            editFrontMatter:
                () =>
                ({ state, tr, dispatch, view }) => {
                    const first = state.doc.firstChild
                    if (first?.type !== type) return false
                    if (dispatch) {
                        tr.setSelection(TextSelection.create(tr.doc, first.nodeSize - 1)).setMeta(frontMatterKey, 'enter')
                        // The selection reaches the node's view (which hands it
                        // to the YAML) only through an editor that holds the
                        // focus: one that does not is given it, once the
                        // selection is in place.
                        requestAnimationFrame(() => {
                            if (!view.isDestroyed && !view.dom.contains(document.activeElement)) view.focus()
                        })
                    }
                    return true
                },
            setFrontMatterAutoCollapse:
                (on) =>
                () => {
                    if (storage.autoCollapse !== on) {
                        storage.autoCollapse = on
                        const settings = settingsOf(this.editor)
                        if (settings) void settings.set('frontMatter.collapsed', on)
                        else keepAutoCollapse(on)
                        for (const refresh of storage.refresh) refresh()
                    }
                    return true
                },
        }
    },


    addKeyboardShortcuts() {
        return {
            // Up from the first line of the note: into the YAML, at its end.
            ArrowUp: () => {
                const { state, view } = this.editor
                const { $from, empty } = state.selection
                if (!empty || $from.depth < 1 || $from.index(0) !== 1 || state.doc.firstChild?.type !== this.type) return false
                if (!view.endOfTextblock('up')) return false
                return this.editor.commands.editFrontMatter()
            },
        }
    },

    onCreate() {
        const { state, view } = this.editor
        if (inFrontMatter(state, this.type)) view.dispatch(state.tr.setSelection(bodyStart(state)).setMeta('addToHistory', false))
        // The fold from the settings, when the editor has them (and as they
        // change); this browser's kept choice without.
        const settings = settingsOf(this.editor)
        if (settings) {
            const storage = this.storage
            const sync = () => {
                const on = settings.get('frontMatter.collapsed')
                if (storage.autoCollapse === on) return
                storage.autoCollapse = on
                for (const refresh of storage.refresh) refresh()
            }
            sync()
            settings.subscribe(sync)
        }
        const assignId = this.options.assignId
        const persistence = (this.editor.storage as any).persistence as FileSystemStorage | undefined
        if (!assignId || !persistence) return
        const editor = this.editor
        const type = this.type
        unsubscribers.set(
            editor,
            persistence.subscribe((event) => {
                // A note, loaded into the rich-text editor (not a code file).
                if (event.type !== 'load' || persistence.codeView || !isNote(normalizePath(event.path))) return
                ensureId(editor, type, assignId)
            }),
        )
    },

    onDestroy() {
        unsubscribers.get(this.editor)?.()
        unsubscribers.delete(this.editor)
    },

    addNodeView() {
        const editor = this.editor
        const storage = this.storage
        return ({ node, getPos, view }) => {
            const dom = document.createElement('div')
            dom.className = 'ezco-mde-front-matter'
            dom.contentEditable = 'false'
            // The one line it folds to: how many properties, and their names.
            const line = document.createElement('button')
            line.type = 'button'
            line.className = 'ezco-mde-front-matter-line'
            line.title = 'Edit the properties'
            const count = document.createElement('span')
            count.className = 'ezco-mde-front-matter-count'
            const keys = document.createElement('span')
            keys.className = 'ezco-mde-front-matter-keys'
            line.append(count, keys)
            dom.append(line)

            let current = node
            let updating = false
            let collapsed = storage.autoCollapse
            const summarize = () => {
                const names = topLevelKeys(current.textContent)
                count.textContent = names.length ? `${names.length} ${names.length === 1 ? 'property' : 'properties'}` : 'No properties'
                keys.textContent = names.join(', ')
                keys.hidden = !names.length
            }
            const show = (open: boolean) => {
                collapsed = !open
                dom.classList.toggle('is-collapsed', collapsed)
                line.setAttribute('aria-expanded', String(open))
                if (open) cm.requestMeasure()
            }

            // The YAML to the note: each change as it is made, and the
            // caret with it (marked, so the caret is let stay).
            const forward = (update: ViewUpdate) => {
                if (updating) return
                const pos = getPos()
                if (pos === undefined) return
                let offset = pos + 1
                const { main } = update.state.selection
                const selFrom = offset + main.from
                const selTo = offset + main.to
                const pmSel = view.state.selection
                // The YAML arriving as the note already has it (the code
                // block setting up) changes nothing in the note.
                if (update.docChanged && update.state.doc.toString() === view.state.doc.nodeAt(pos)?.textContent && !cm.hasFocus) return
                if (!update.docChanged && (!cm.hasFocus || (pmSel.from === selFrom && pmSel.to === selTo))) return
                const tr = view.state.tr
                update.changes.iterChanges((fromA, toA, fromB, toB, text) => {
                    if (text.length) tr.replaceWith(offset + fromA, offset + toA, view.state.schema.text(text.toString()))
                    else tr.delete(offset + fromA, offset + toA)
                    offset += toB - fromB - (toA - fromA)
                })
                if (cm.hasFocus) {
                    const size = tr.doc.content.size
                    tr.setSelection(TextSelection.create(tr.doc, Math.min(selFrom, size), Math.min(selTo, size)))
                }
                view.dispatch(tr.setMeta(frontMatterKey, 'sync'))
            }

            /** Out of the YAML: the caret at the start of the note's body. */
            const leave = () => {
                const pos = getPos()
                if (pos === undefined) return false
                const after = pos + current.nodeSize
                view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(after), 1)).scrollIntoView())
                view.focus()
                return true
            }
            const keys_: KeyBinding[] = [
                {
                    key: 'ArrowDown',
                    run: () => {
                        const { main } = cm.state.selection
                        return main.empty && cm.state.doc.lineAt(main.head).to === cm.state.doc.length ? leave() : false
                    },
                },
                { key: 'ArrowRight', run: () => (cm.state.selection.main.empty && cm.state.selection.main.to === cm.state.doc.length ? leave() : false) },
                { key: 'Escape', run: leave },
                {
                    // Nothing in it: Backspace takes the block away.
                    key: 'Backspace',
                    run: () => {
                        if (cm.state.doc.length) return false
                        const pos = getPos()
                        if (pos === undefined) return false
                        const tr = view.state.tr.delete(pos, pos + current.nodeSize)
                        view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(pos), 1)))
                        view.focus()
                        return true
                    },
                },
                { key: 'Mod-z', run: () => editor.commands.undo() },
                { key: 'Mod-Shift-z', run: () => editor.commands.redo() },
                { key: 'Mod-y', run: () => editor.commands.redo() },
            ]
            const persistence = (editor.storage as any).persistence as FileSystemStorage | undefined
            const base = measureBaseFontPx(view.dom as HTMLElement)
            const cm = new EditorView({
                state: CMState.create({
                    doc: node.textContent,
                    extensions: [
                        keymap.of(keys_),
                        basicSetup,
                        EditorView.updateListener.of(forward),
                        codeblock({
                            content: node.textContent,
                            fs: persistence?.options.fs ?? memoryVfs(),
                            language: 'yaml',
                            toolbar: false,
                            dark: isDarkMode(view.dom),
                            settings: { lineWrap: true, ...(base ? { fontSize: Math.max(base - 2, 1) } : {}) },
                        }),
                    ],
                }),
            })
            dom.append(cm.dom)
            codeblockRegistry.register(cm)

            // Left (a click in the note, Escape, the caret arrowed out): folded
            // again, unless the reader keeps it open. Focus gone to the block's
            // own menu is not leaving: the fold waits for where it goes next.
            const left = (e: FocusEvent) => {
                const to = e.relatedTarget as HTMLElement | null
                if (!storage.autoCollapse || (to && dom.contains(to))) return
                if (to?.closest('.ezco-mde-block-action-menu, .ezco-mde-block-action-btn')) {
                    const next = (ev: FocusEvent) => {
                        const target = ev.target as HTMLElement | null
                        if (target && dom.contains(target)) return
                        if (target?.closest('.ezco-mde-block-action-menu, .ezco-mde-block-action-btn')) {
                            document.addEventListener('focusin', next, { once: true })
                            return
                        }
                        if (storage.autoCollapse && !cm.hasFocus) show(false)
                    }
                    document.addEventListener('focusin', next, { once: true })
                    return
                }
                show(false)
            }
            cm.contentDOM.addEventListener('focusout', left)
            const open = () => {
                show(true)
                cm.focus()
            }
            line.addEventListener('mousedown', (e) => e.preventDefault())
            line.addEventListener('click', () => {
                const pos = getPos()
                if (pos === undefined) return
                view.focus()
                view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + current.nodeSize - 1)).setMeta(frontMatterKey, 'enter'))
                open()
            })
            const refresh = () => show(!storage.autoCollapse || cm.hasFocus)
            storage.refresh.add(refresh)
            summarize()
            show(!storage.autoCollapse)

            return {
                dom,
                update(next) {
                    if (next.type !== current.type) return false
                    const was = current.textContent
                    current = next
                    const text = next.textContent
                    if (text !== was && text !== cm.state.doc.toString()) {
                        // What changed, not the whole: the caret and history stay.
                        const cur = cm.state.doc.toString()
                        let start = 0
                        let curEnd = cur.length
                        let newEnd = text.length
                        while (start < curEnd && cur.charCodeAt(start) === text.charCodeAt(start)) start++
                        while (curEnd > start && newEnd > start && cur.charCodeAt(curEnd - 1) === text.charCodeAt(newEnd - 1)) {
                            curEnd--
                            newEnd--
                        }
                        updating = true
                        cm.dispatch({ changes: { from: start, to: curEnd, insert: text.slice(start, newEnd) } })
                        updating = false
                    }
                    if (text !== was) summarize()
                    return true
                },
                // The caret sent in (arrowed up into it, or the line clicked):
                // the YAML opens with it where it was sent.
                setSelection(anchor, head) {
                    open()
                    updating = true
                    const size = cm.state.doc.length
                    cm.dispatch({ selection: { anchor: Math.min(anchor, size), head: Math.min(head, size) } })
                    updating = false
                },
                selectNode() {
                    open()
                },
                stopEvent() {
                    return true
                },
                ignoreMutation() {
                    return true
                },
                destroy() {
                    storage.refresh.delete(refresh)
                    cm.contentDOM.removeEventListener('focusout', left)
                    codeblockRegistry.unregister(cm)
                    cm.destroy()
                },
            }
        }
    },
})

const unsubscribers = new WeakMap<Editor, () => void>()

function inFrontMatter(state: EditorState, type: PMNode['type']): boolean {
    const { $head } = state.selection
    return state.doc.firstChild?.type === type && $head.depth >= 1 && $head.before(1) === 0
}

/** The first caret position after the front matter. */
function bodyStart(state: EditorState): Selection {
    return Selection.near(state.doc.resolve(state.doc.firstChild!.nodeSize))
}

/** Give the document an `id:` if its front matter has none (or has none at all). */
function ensureId(editor: Editor, type: PMNode['type'], assignId: () => string) {
    const { state } = editor
    const first = state.doc.firstChild
    const tr = state.tr
    if (first?.type === type) {
        const text = first.textContent
        const line = /^id[ \t]*:[ \t]*(.*?)[ \t]*$/m.exec(text)
        if (line && line[1].replace(/^(['"])(.*)\1$/, '$2').trim()) return
        if (line) {
            // `id:` with no value: fill it in, where it is.
            const at = 1 + line.index + line[0].length
            tr.insertText(`${/[ \t]$/.test(line[0]) ? '' : ' '}${assignId()}`, at)
        } else {
            tr.insertText(text ? `id: ${assignId()}\n` : `id: ${assignId()}`, 1)
        }
    } else {
        tr.insert(0, type.create(null, state.schema.text(`id: ${assignId()}`)))
    }
    editor.view.dispatch(tr.setMeta('addToHistory', false))
}
