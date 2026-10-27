/**
 * Front matter: the YAML block a note may open with, between `---` fences.
 * It is where a note keeps its properties, and its identity (`id:`, RFC §3).
 *
 * The node holds the YAML exactly as written and serializes it back
 * untouched. It shows as the note's code blocks do: the YAML in a code
 * editor (`@joinezco/codeblock`, as a YAML file) under a header drawn as
 * the code blocks' toolbar is, a YAML glyph in the line numbers' column
 * and "frontmatter" in the field, over the code, naming the section, with
 * a summary of the properties at the field's end ("3 properties · id,
 * title"). When the YAML is not being edited it folds to that header
 * alone, and the header to nearly nothing: the glyph and the summary,
 * small and faint, a line above the note's title (styles.ts). The summary
 * pressed, the caret arrowed up from the note's first line, or "Edit
 * properties" (in the header's dropdown and in the block's gutter menu)
 * opens it with the caret in the YAML; leaving it (a click in the note,
 * Escape, arrowing down past its last line) folds it again. The field's
 * dropdown holds what the properties can do: open, add one, fold when not
 * editing (a setting, kept), or go. The folding is the reader's to turn
 * off; the choice is kept.
 *
 * A note gets front matter by typing `---` on its first line, which asks
 * whether it is front matter or a divider (both are `---`), by pasting a
 * `---` block at the top (`markdown-paste.ts`), or by the "Front matter"
 * slash command. With nothing in it the header says "No properties", and
 * the YAML, opened, shows what a property looks like. The document admits
 * front matter only as its first node: `FrontMatterDocument` replaces the
 * default document for that.
 *
 * With `assignId`, a note opened without an `id:` is given one (as an edit,
 * so autosave writes it, and outside the undo history); with `ensure`, a
 * note opened without front matter is given an empty block. Both are the
 * host's policy, not the editor's: a viewer that must not write leaves
 * them unset.
 */
import { Editor, Node, mergeAttributes } from '@tiptap/core'
import { readKept, writeKept } from '../ui/kept'
import { settingsOf } from '../settings'
import Document from '@tiptap/extension-document'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from '@tiptap/pm/state'
import type { EditorView as PMView } from '@tiptap/pm/view'
import { EditorView, keymap, placeholder, showPanel, type KeyBinding, type Panel, type ViewUpdate } from '@codemirror/view'
import { EditorState as CMState } from '@codemirror/state'
import { basicSetup, codeblock, getFileIcon } from '@joinezco/codeblock'
import { memoryVfs, normalizePath } from '@joinezco/storage'
import { isNote } from '@joinezco/vault'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import { setupOnce } from './markdown-it'
import { codeblockRegistry, isDarkMode, measureBaseFontPx } from './codeblock'
import { persistenceOf } from './filesystem'
import { SuggestionMenu } from '../ui/suggestion-menu'
import { el } from '../ui/dom'

export interface FrontMatterOptions {
    /** Give a note opened without an `id:` a new one. */
    assignId?: () => string
    /** Give a note opened without front matter an empty block of
     *  properties, so every note starts with its header to fill in. */
    ensure?: boolean
}

export interface FrontMatterStorage {
    /** Whether the YAML folds to its header when it is not being edited. */
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
            /** Give the note front matter (empty) if it has none, and open it. */
            insertFrontMatter: () => ReturnType
            /** Open the front matter (made if there is none) on a fresh last
             *  line, for a property to be typed. */
            addFrontMatterProperty: () => ReturnType
            /** Take the front matter out of the note. */
            removeFrontMatter: () => ReturnType
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

/** The header's summary of `yaml`: how many properties, and their names. */
export function summarize(yaml: string): string {
    const names = topLevelKeys(yaml)
    if (!names.length) return 'No properties'
    return `${names.length} ${names.length === 1 ? 'property' : 'properties'} · ${names.join(', ')}`
}

/** The dashes that open front matter, as typed (macOS may have made the
 *  first two an em dash). */
const DASHES = new Set(['---', '—-'])

/**
 * Whether dashes typed over `range` are the first line of a note that has
 * no front matter yet: the first block of the document, a paragraph that
 * holds nothing but them. Then they are not a divider (yet): the front
 * matter extension asks which (`horizontal-rule.ts` leaves them be).
 */
export function asksForFrontMatter(state: EditorState, range: { from: number; to: number }, match: string): boolean {
    if (!state.schema.nodes.frontMatter || !DASHES.has(match)) return false
    const $from = state.doc.resolve(range.from)
    if ($from.depth !== 1 || $from.index(0) !== 0 || $from.parent.type.name !== 'paragraph') return false
    // Nothing in the paragraph but the dashes typed so far (the last is
    // still on its way in).
    return $from.parent.textContent === match.slice(0, range.to - range.from)
}

export const FrontMatter = Node.create<FrontMatterOptions, FrontMatterStorage>({
    name: 'frontMatter',
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    isolating: true,

    addOptions() {
        return { assignId: undefined, ensure: false }
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
                    setup: (markdownit: any) => setupOnce(markdownit, 'frontMatter', () => {
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
                    }),
                },
            } as MarkdownNodeSpec,
        }
    },

    addProseMirrorPlugins() {
        const type = this.type
        const editor = this.editor
        let prompt: DashesPrompt | null = null
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
            // `---` typed as the first line of a note without front matter:
            // front matter or a divider? Both are written the same.
            new Plugin({
                key: new PluginKey('frontMatterPrompt'),
                view: (view) => (prompt = new DashesPrompt(editor, view, type)),
                props: {
                    handleKeyDown: (_, event) => prompt?.handleKeyDown(event) ?? false,
                },
            }),
        ]
    },

    addCommands() {
        const type = this.type
        const storage = this.storage
        /** The caret sent into the front matter at `pos` of `tr`'s document, the editor focused. */
        const enter = (tr: import('@tiptap/pm/state').Transaction, pos: number, view: PMView) => {
            tr.setSelection(TextSelection.create(tr.doc, pos)).setMeta(frontMatterKey, 'enter')
            // The selection reaches the node's view (which hands it to the
            // YAML) only through an editor that holds the focus (the
            // editable itself, not the front matter's own header or the
            // block's menu): one that does not is given it, once the
            // selection is in place.
            requestAnimationFrame(() => {
                if (!view.isDestroyed && !view.hasFocus()) view.focus()
            })
        }
        return {
            editFrontMatter:
                () =>
                ({ state, tr, dispatch, view }) => {
                    const first = state.doc.firstChild
                    if (first?.type !== type) return false
                    if (dispatch) enter(tr, first.nodeSize - 1, view)
                    return true
                },
            insertFrontMatter:
                () =>
                ({ state, tr, dispatch, view }) => {
                    const first = state.doc.firstChild
                    if (first?.type === type) {
                        if (dispatch) enter(tr, first.nodeSize - 1, view)
                        return true
                    }
                    if (dispatch) {
                        tr.insert(0, type.create())
                        enter(tr, 1, view)
                    }
                    return true
                },
            addFrontMatterProperty:
                () =>
                ({ state, tr, dispatch, view }) => {
                    if (dispatch) {
                        let first = state.doc.firstChild
                        if (first?.type !== type) {
                            tr.insert(0, type.create())
                            first = tr.doc.firstChild!
                        }
                        // A fresh line at the end for the property, unless the
                        // YAML already ends on one (or has nothing yet).
                        let end = first.nodeSize - 1
                        const text = first.textContent
                        if (text && !text.endsWith('\n')) {
                            tr.insertText('\n', end)
                            end++
                        }
                        enter(tr, end, view)
                    }
                    return true
                },
            removeFrontMatter:
                () =>
                ({ state, tr, dispatch, view }) => {
                    const first = state.doc.firstChild
                    if (first?.type !== type) return false
                    if (dispatch) {
                        tr.delete(0, first.nodeSize)
                        tr.setSelection(Selection.near(tr.doc.resolve(0), 1))
                        requestAnimationFrame(() => {
                            if (!view.isDestroyed) view.focus()
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
        const { assignId, ensure } = this.options
        const editor = this.editor
        const type = this.type
        const persistence = persistenceOf(editor)
        // Notes come by being loaded (a filesystem and a path), or given at
        // creation: the latter gets its block now.
        const loads = !!(persistence?.options.fs && persistence.options.filepath)
        if (ensure && !loads) ensureBlock(editor, type)
        if ((!assignId && !ensure) || !persistence || !loads) return
        unsubscribers.set(
            editor,
            persistence.subscribe((event) => {
                // A note, loaded into the rich-text editor (not a code file).
                if (event.type !== 'load' || persistence.codeView || !isNote(normalizePath(event.path))) return
                if (assignId) ensureId(editor, type, assignId)
                else ensureBlock(editor, type)
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

            let current = node
            let updating = false
            let collapsed = storage.autoCollapse
            const show = (open: boolean) => {
                collapsed = !open
                dom.classList.toggle('is-collapsed', collapsed)
                head.setExpanded(open)
                if (open) {
                    cm.requestMeasure()
                    requestAnimationFrame(align)
                }
            }
            // The header's columns as the code's: the glyph in the line
            // numbers' column, the field over the code (the toolbar's own
            // variables, measured from the gutter as the code block's
            // toolbar measures them). Measured open; folded, the header
            // keeps the last measure.
            const align = () => {
                const gutters = cm.dom.querySelector<HTMLElement>('.cm-gutters')
                const width = gutters?.getBoundingClientRect().width ?? 0
                if (!gutters || !width) return
                const iconCol = Math.ceil(2 * cm.defaultCharacterWidth) + 8
                const numbers = gutters.querySelector<HTMLElement>('.cm-lineNumbers')
                cm.dom.style.setProperty('--cm-icon-col-width', `${iconCol}px`)
                cm.dom.style.setProperty('--cm-gutter-width', `${width}px`)
                cm.dom.style.setProperty('--cm-gutter-lineno-width', numbers ? `${numbers.getBoundingClientRect().width}px` : `${iconCol}px`)
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
            /** The block taken out of the note, the caret where it was. */
            const remove = () => {
                const pos = getPos()
                if (pos === undefined) return false
                const tr = view.state.tr.delete(pos, pos + current.nodeSize)
                view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(pos), 1)))
                view.focus()
                return true
            }
            const open = () => {
                show(true)
                cm.focus()
            }
            /** The YAML opened with the caret at `at` (its end unless given). */
            const openAt = (at?: number) => {
                open()
                updating = true
                cm.dispatch({ selection: { anchor: at ?? cm.state.doc.length } })
                updating = false
            }
            const keys_: KeyBinding[] = [
                {
                    key: 'ArrowDown',
                    run: () => {
                        const { main } = cm.state.selection
                        return main.empty && cm.state.doc.lineAt(main.head).to === cm.state.doc.length ? leave() : false
                    },
                },
                {
                    // Up from the first line: the header, as a code block's toolbar.
                    key: 'ArrowUp',
                    run: () => {
                        const { main } = cm.state.selection
                        if (!main.empty || cm.state.doc.lineAt(main.head).from !== 0) return false
                        head.focus()
                        return true
                    },
                },
                { key: 'ArrowRight', run: () => (cm.state.selection.main.empty && cm.state.selection.main.to === cm.state.doc.length ? leave() : false) },
                { key: 'Escape', run: leave },
                {
                    // Nothing in it: Backspace takes the block away.
                    key: 'Backspace',
                    run: () => (cm.state.doc.length ? false : remove()),
                },
                { key: 'Mod-z', run: () => editor.commands.undo() },
                { key: 'Mod-Shift-z', run: () => editor.commands.redo() },
                { key: 'Mod-y', run: () => editor.commands.redo() },
            ]
            const head = frontMatterHead({
                summary: () => summarize(current.textContent),
                folds: () => storage.autoCollapse,
                isOpen: () => !collapsed,
                open: () => openAt(),
                openAtStart: () => openAt(0),
                addProperty: () => editor.commands.addFrontMatterProperty(),
                toggleFolds: () => editor.commands.setFrontMatterAutoCollapse(!storage.autoCollapse),
                remove,
                leave,
                isEmpty: () => current.textContent.length === 0,
            })
            const persistence = persistenceOf(editor)
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
                        showPanel.of(() => head.panel),
                        // What a property looks like, while there is none.
                        placeholder('key: value'),
                    ],
                }),
            })
            dom.append(cm.dom)
            codeblockRegistry.register(cm)
            // The gutter widens with the line count: the header follows.
            const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(align) : null
            resized?.observe(cm.dom)

            // Left (a click in the note, Escape, the caret arrowed out): folded
            // again, unless the reader keeps it open. Focus gone to the header
            // is not leaving, nor is focus gone to the block's own menu: the
            // fold waits for where it goes next.
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
                        if (storage.autoCollapse && !cm.hasFocus && !head.hasFocus()) show(false)
                    }
                    document.addEventListener('focusin', next, { once: true })
                    return
                }
                show(false)
            }
            cm.contentDOM.addEventListener('focusout', left)
            head.input.addEventListener('focusout', left)
            const refresh = () => show(!storage.autoCollapse || cm.hasFocus || head.hasFocus())
            storage.refresh.add(refresh)
            head.update()
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
                    if (text !== was) head.update()
                    return true
                },
                // The caret sent in (arrowed up into it, the summary pressed, a
                // command): the YAML opens with it where it was sent.
                setSelection(anchor, head_) {
                    open()
                    updating = true
                    const size = cm.state.doc.length
                    cm.dispatch({ selection: { anchor: Math.min(anchor, size), head: Math.min(head_, size) } })
                    updating = false
                },
                // Selected whole (its glyph in the gutter pressed): marked, not
                // opened; the menu that follows is the block's.
                selectNode() {
                    dom.classList.add('is-selected')
                },
                deselectNode() {
                    dom.classList.remove('is-selected')
                },
                stopEvent() {
                    return true
                },
                ignoreMutation() {
                    return true
                },
                destroy() {
                    resized?.disconnect()
                    storage.refresh.delete(refresh)
                    cm.contentDOM.removeEventListener('focusout', left)
                    head.input.removeEventListener('focusout', left)
                    head.destroy()
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

/** Give the document an empty block of front matter if it has none. */
function ensureBlock(editor: Editor, type: PMNode['type']) {
    const { state } = editor
    if (state.doc.firstChild?.type === type) return
    editor.view.dispatch(state.tr.insert(0, type.create()).setMeta('addToHistory', false))
}

// ─────────────────────────────────────────────────────────────────────────
// The header
// ─────────────────────────────────────────────────────────────────────────

interface HeadCallbacks {
    /** The summary line: how many properties, which. */
    summary: () => string
    /** Whether the YAML folds when not being edited. */
    folds: () => boolean
    /** Whether the YAML is shown. */
    isOpen: () => boolean
    /** Open the YAML, the caret at its end. */
    open: () => void
    /** Open the YAML, the caret at its start (arrowed down from the header). */
    openAtStart: () => void
    /** Open the YAML on a fresh last line. */
    addProperty: () => void
    toggleFolds: () => void
    /** Take the block out of the note. */
    remove: () => boolean
    /** The caret to the start of the note's body. */
    leave: () => boolean
    /** Nothing in the YAML. */
    isEmpty: () => boolean
}

interface Head {
    panel: Panel
    /** The field, named "frontmatter": focusable, its dropdown behind it. */
    input: HTMLInputElement
    hasFocus: () => boolean
    focus: () => void
    /** The summary redrawn, and the dropdown's rows. */
    update: () => void
    setExpanded: (open: boolean) => void
    destroy: () => void
}

/** A row of the header's dropdown: what the properties can do. */
interface HeadAction {
    label: () => string
    icon: () => string
    run: () => void
}

/** The glyph the header wears: the YAML file icon, in its colour. */
const YAML_ICON = getFileIcon('properties.yaml')
const EDIT_ICON = ''
const ADD_ICON = ''
const ON_ICON = '✓'
const OFF_ICON = '✗'

/**
 * The front matter's header: the code blocks' toolbar row (its classes, so
 * it is drawn as one), a YAML glyph for the search glyph, "frontmatter" in
 * the field as the section's name, and the properties summarized at the
 * field's end. The field is not typed in: pressed (or Enter on it) it
 * opens a dropdown of what the properties can do, drawn as the toolbar's
 * results are; the summary pressed opens the YAML. ArrowDown goes into the
 * YAML, Escape to the note, Backspace takes an empty block away.
 */
function frontMatterHead(cb: HeadCallbacks): Head {
    const dom = el('div', 'cm-toolbar-panel ezco-mde-front-matter-head')
    const iconBox = el('div', 'cm-toolbar-state-icon-container')
    const icon = el('div', 'cm-toolbar-state-icon', YAML_ICON.glyph)
    icon.style.fontFamily = 'var(--cm-icon-font-family)'
    if (YAML_ICON.color) icon.style.color = YAML_ICON.color
    icon.setAttribute('aria-hidden', 'true')
    iconBox.append(icon)
    const field = el('div', 'cm-toolbar-input-container')
    const input = el('input', 'cm-toolbar-input')
    input.type = 'text'
    input.value = 'frontmatter'
    input.readOnly = true
    input.spellcheck = false
    input.size = input.value.length + 1
    input.setAttribute('aria-label', 'Front matter')
    input.setAttribute('aria-haspopup', 'menu')
    input.setAttribute('aria-expanded', 'false')
    const summary = el('button', 'ezco-mde-front-matter-summary')
    summary.type = 'button'
    summary.title = 'Edit the properties'
    field.append(input, summary)
    const results = el('ul', 'cm-search-results')
    results.setAttribute('role', 'menu')
    dom.append(iconBox, field, results)

    const actions: HeadAction[] = [
        { label: () => 'Edit properties', icon: () => EDIT_ICON, run: () => cb.open() },
        { label: () => 'Add property', icon: () => ADD_ICON, run: () => cb.addProperty() },
        { label: () => `Collapse when not editing: ${cb.folds() ? 'on' : 'off'}`, icon: () => (cb.folds() ? ON_ICON : OFF_ICON), run: () => cb.toggleFolds() },
        { label: () => 'Delete front matter', icon: () => OFF_ICON, run: () => void cb.remove() },
    ]
    let selected = 0
    let shown = false

    const mark = () => {
        results.querySelectorAll<HTMLElement>('.cm-search-result').forEach((row, i) => row.classList.toggle('selected', i === selected))
    }
    const draw = () => {
        if (!shown) return
        const rows = actions.map((action, i) => {
            const li = el('li', 'cm-search-result cm-command-result')
            li.setAttribute('role', 'menuitem')
            const box = el('div', 'cm-search-result-icon-container')
            const glyph = el('div', 'cm-search-result-icon', action.icon())
            glyph.style.fontFamily = 'var(--cm-icon-font-family)'
            box.append(glyph)
            li.append(box, el('div', 'cm-search-result-label', action.label()))
            if (i === selected) li.classList.add('selected')
            li.addEventListener('mousedown', (e) => e.preventDefault())
            li.addEventListener('mouseenter', () => {
                selected = i
                mark()
            })
            li.addEventListener('click', (e) => {
                e.stopPropagation()
                choose(action)
            })
            return li
        })
        results.replaceChildren(...rows)
    }
    const pressOutside = (e: MouseEvent) => {
        if (!dom.contains(e.target as Element | null)) hide()
    }
    const showMenu = () => {
        if (shown) return
        shown = true
        selected = 0
        input.setAttribute('aria-expanded', 'true')
        draw()
        document.addEventListener('mousedown', pressOutside, true)
    }
    const hide = () => {
        if (!shown) return
        shown = false
        input.setAttribute('aria-expanded', 'false')
        results.replaceChildren()
        document.removeEventListener('mousedown', pressOutside, true)
    }
    const choose = (action: HeadAction) => {
        hide()
        action.run()
    }

    input.addEventListener('mousedown', (e) => {
        // The press is the field's: the note's selection stays where it is.
        e.preventDefault()
        input.focus()
        if (shown) hide()
        else showMenu()
    })
    input.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault()
                if (shown) {
                    selected = (selected + 1) % actions.length
                    mark()
                } else cb.openAtStart()
                break
            case 'ArrowUp':
                e.preventDefault()
                if (shown) {
                    selected = (selected - 1 + actions.length) % actions.length
                    mark()
                }
                break
            case 'Enter':
            case ' ':
                e.preventDefault()
                if (shown) choose(actions[selected])
                else showMenu()
                break
            case 'Escape':
                e.preventDefault()
                if (shown) hide()
                else cb.leave()
                break
            case 'Backspace':
            case 'Delete':
                if (cb.isEmpty()) {
                    e.preventDefault()
                    hide()
                    cb.remove()
                }
                break
        }
    })
    summary.addEventListener('mousedown', (e) => e.preventDefault())
    summary.addEventListener('click', (e) => {
        e.stopPropagation()
        hide()
        if (cb.isOpen()) cb.leave()
        else cb.open()
    })

    return {
        panel: { dom, top: true },
        input,
        hasFocus: () => dom.contains(document.activeElement),
        focus: () => input.focus(),
        update: () => {
            summary.textContent = cb.summary()
            draw()
        },
        setExpanded: (open) => {
            summary.setAttribute('aria-expanded', String(open))
            summary.title = open ? 'Fold the properties' : 'Edit the properties'
        },
        destroy: () => {
            hide()
            dom.remove()
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────
// `---` on the first line
// ─────────────────────────────────────────────────────────────────────────

/**
 * The menu under `---` typed as the first line of a note that has no front
 * matter: front matter, or a divider. Until one is chosen the dashes stay
 * text (`horizontal-rule.ts` holds its rule off for them); typing on,
 * moving away or Escape leaves them so, and a later `---` elsewhere is a
 * divider as ever.
 */
class DashesPrompt {
    private menu: SuggestionMenu
    private range: { from: number; to: number } | null = null
    /** Set when the dashes were just typed: landing the caret after dashes
     *  already there does not ask again. */
    private armed = false

    constructor(
        private editor: Editor,
        view: PMView,
        private type: PMNode['type'],
    ) {
        this.menu = new SuggestionMenu({
            view,
            range: () => this.range,
            className: 'ezco-mde-slash-menu ezco-mde-dashes-menu',
            label: 'Front matter or a divider',
            atTop: 'wrap',
            onClose: () => {
                this.armed = false
                this.hide()
            },
        })
        this.onUpdate = this.onUpdate.bind(this)
        editor.on('update', this.onUpdate)
        editor.on('selectionUpdate', this.onUpdate)
    }

    private onUpdate({ transaction }: { transaction: { docChanged: boolean } }) {
        const { state } = this.editor
        const first = state.doc.firstChild
        const { selection } = state
        const dashes = first?.type.name === 'paragraph' && DASHES.has(first.textContent) && first.textContent
        const atEnd = selection.empty && selection.$from.depth === 1 && selection.$from.index(0) === 0 && selection.$from.parentOffset === (dashes ? dashes.length : -1)
        if (!dashes || !atEnd || state.doc.firstChild?.type === this.type) {
            this.armed = false
            this.hide()
            return
        }
        if (transaction.docChanged) this.armed = true
        if (!this.armed || this.menu.isOpen) return
        this.range = { from: 1, to: 1 + dashes.length }
        this.menu.show(
            [
                { icon: '---', title: 'Front matter', description: 'The note’s properties, as YAML at its top', onSelect: () => this.frontMatter() },
                { icon: '—', title: 'Divider', description: 'A horizontal rule', onSelect: () => this.divider() },
            ],
            '',
        )
    }

    handleKeyDown(event: KeyboardEvent): boolean {
        return this.menu.handleKeyDown(event)
    }

    /** The dashes made the note's front matter, empty, open for its properties. */
    private frontMatter() {
        const { state, view } = this.editor
        const first = state.doc.firstChild!
        const tr = state.tr
        // The paragraph goes, unless it is all the note has (the body needs a block).
        const replacement = state.doc.childCount > 1 ? [this.type.create()] : [this.type.create(), state.schema.nodes.paragraph.create()]
        tr.replaceWith(0, first.nodeSize, replacement)
        tr.setSelection(TextSelection.create(tr.doc, 1)).setMeta(frontMatterKey, 'enter')
        view.dispatch(tr)
        view.focus()
        this.hide()
    }

    /** The dashes made a divider, as the input rule would have: the rule
     *  before the paragraph, which keeps the caret, emptied. */
    private divider() {
        const { state, view } = this.editor
        const hr = state.schema.nodes.horizontalRule
        if (!hr) return
        const first = state.doc.firstChild!
        const rule = hr.create()
        const tr = state.tr.insert(0, rule)
        const start = rule.nodeSize + 1
        tr.delete(start, start + first.textContent.length)
        tr.setSelection(TextSelection.create(tr.doc, start))
        view.dispatch(tr.scrollIntoView())
        view.focus()
        this.hide()
    }

    private hide() {
        this.menu.hide()
        this.range = null
    }

    destroy() {
        this.editor.off('update', this.onUpdate)
        this.editor.off('selectionUpdate', this.onUpdate)
        this.hide()
    }
}
