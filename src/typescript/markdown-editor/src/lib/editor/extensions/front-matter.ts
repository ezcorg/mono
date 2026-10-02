/**
 * Front matter: the YAML block a note may open with, between `---` fences.
 * It is where a note keeps its properties, and its identity (`id:`, RFC §3).
 *
 * The node holds the YAML exactly as written and serializes it back
 * untouched. It shows as one small line at the top of the note, "2
 * properties", that opens on a click into a table of them (wikilinks in
 * values are followable) and closes on another; "Edit YAML" beside it, or
 * arrowing up from the note's first line, shows the YAML itself, edited as
 * text (see `source-view.ts`). Nothing else on it is a control: clicking
 * the table changes nothing. Whether the table is open is remembered per
 * editor, from note to note. The document admits it only as its first node:
 * `FrontMatterDocument` replaces the default document for that.
 *
 * With `assignId`, a note opened without an `id:` is given one (as an edit,
 * so autosave writes it, and outside the undo history). That is the host's
 * policy, not the editor's: a viewer that must not write leaves it unset.
 */
import { Editor, Node, mergeAttributes } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import { Fragment, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, Selection, type EditorState } from '@tiptap/pm/state'
import { normalizePath } from '@joinezco/storage'
import { isNote, matchWikilinkAt } from '@joinezco/vault'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import { enter, sourceViewDOM, sourceViewKey, sourceViewSpec } from './source-view'
import { wikilinkLabel, type WikilinkStorage } from './wikilink'
import type { FileSystemStorage } from './filesystem'

export interface FrontMatterOptions {
    /** Give a note opened without an `id:` a new one. */
    assignId?: () => string
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

let yamlModule: Promise<typeof import('yaml')> | null = null
const loadYaml = () => (yamlModule ??= import('yaml'))

export const FrontMatter = Node.create<FrontMatterOptions>({
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

    extendNodeSchema(extension) {
        return extension.name === 'frontMatter' ? sourceViewSpec : {}
    },

    addStorage() {
        return {
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
                    const deliberate = transactions.some((tr) => tr.getMeta(sourceViewKey) || tr.getMeta('pointer'))
                    return deliberate ? null : newState.tr.setSelection(bodyStart(newState))
                },
            }),
        ]
    },

    onCreate() {
        const { state, view } = this.editor
        if (inFrontMatter(state, this.type)) view.dispatch(state.tr.setSelection(bodyStart(state)).setMeta('addToHistory', false))
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
        return ({ node, getPos, view }) => {
            const { dom, preview, contentDOM } = sourceViewDOM(view, getPos, { outer: 'div', source: 'pre' }, { enterOnClick: false })
            dom.classList.add('ezco-mde-front-matter')
            // One line: the toggle ("▸ 2 properties"), and while open, the way
            // to the YAML. The table sits under it.
            const bar = document.createElement('div')
            bar.className = 'ezco-mde-props-bar'
            const toggle = document.createElement('button')
            toggle.type = 'button'
            toggle.className = 'ezco-mde-props-toggle'
            const edit = document.createElement('button')
            edit.type = 'button'
            edit.className = 'ezco-mde-props-edit'
            edit.textContent = 'Edit YAML'
            edit.title = 'Edit the properties as YAML'
            const table = document.createElement('div')
            table.className = 'ezco-mde-props-host'
            bar.append(toggle, edit)
            preview.append(bar, table)
            let count = 0
            const show = (open: boolean) => {
                dom.classList.toggle('is-collapsed', !open)
                toggle.setAttribute('aria-expanded', String(open))
                toggle.textContent = `${open ? '▾' : '▸'} ${count ? `${count} ${count === 1 ? 'property' : 'properties'}` : 'Properties'}`
                edit.hidden = !open
            }
            const isOpen = () => propertiesOpen.get(editor) ?? false
            show(isOpen())
            toggle.addEventListener('mousedown', (e) => e.preventDefault())
            toggle.addEventListener('click', () => {
                propertiesOpen.set(editor, !isOpen())
                show(isOpen())
            })
            edit.addEventListener('mousedown', (e) => e.preventDefault())
            edit.addEventListener('click', () => {
                const pos = getPos()
                const target = pos === undefined ? null : view.state.doc.nodeAt(pos)
                if (pos !== undefined && target) {
                    enter(view, pos, target, true)
                    view.focus()
                }
            })
            let current = node
            let token = 0
            const render = () => {
                const mine = ++token
                const yaml = current.textContent
                void loadYaml().then(({ parseDocument }) => {
                    if (mine !== token) return
                    renderProperties(table, yaml, parseDocument, editor)
                    count = table.querySelectorAll('.ezco-mde-prop').length
                    show(isOpen())
                })
            }
            render()
            return {
                dom,
                contentDOM,
                update(next) {
                    if (next.type !== current.type) return false
                    const changed = next.textContent !== current.textContent
                    current = next
                    if (changed) render()
                    return true
                },
                ignoreMutation: (m) => !contentDOM.contains(m.target) && m.type !== 'selection',
                destroy() {
                    token++
                },
            }
        }
    },
})

const unsubscribers = new WeakMap<Editor, () => void>()

/** Whether the properties table is open, per editor (it follows the reader
 *  from note to note, not the note). */
const propertiesOpen = new WeakMap<Editor, boolean>()

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

/** The properties table: one row per top-level key. */
function renderProperties(
    el: HTMLElement,
    yaml: string,
    parseDocument: typeof import('yaml').parseDocument,
    editor: Editor,
) {
    el.replaceChildren()
    el.classList.remove('is-invalid')
    let value: unknown
    try {
        const doc = parseDocument(yaml)
        if (doc.errors.length) throw doc.errors[0]
        value = doc.toJS()
    } catch (e) {
        el.classList.add('is-invalid')
        const raw = document.createElement('pre')
        raw.className = 'ezco-mde-props-raw'
        raw.textContent = yaml
        const error = document.createElement('div')
        error.className = 'ezco-mde-props-error'
        error.textContent = `Not valid YAML: ${(e as Error).message.split('\n')[0]}`
        el.append(error, raw)
        return
    }
    const table = document.createElement('div')
    table.className = 'ezco-mde-props'
    table.setAttribute('role', 'table')
    table.setAttribute('aria-label', 'Properties')
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
            const row = document.createElement('div')
            row.className = 'ezco-mde-prop'
            row.setAttribute('role', 'row')
            const k = document.createElement('span')
            k.className = 'ezco-mde-prop-key'
            k.setAttribute('role', 'rowheader')
            k.textContent = key
            const cell = document.createElement('span')
            cell.className = 'ezco-mde-prop-value'
            cell.setAttribute('role', 'cell')
            appendValue(cell, v, editor)
            row.append(k, cell)
            table.append(row)
        }
    }
    if (!table.childElementCount) {
        const empty = document.createElement('div')
        empty.className = 'ezco-mde-props-empty'
        empty.textContent = yaml.trim() ? yaml : 'Properties'
        table.append(empty)
    }
    el.append(table)
}

function appendValue(cell: HTMLElement, value: unknown, editor: Editor) {
    if (value === null || value === undefined || value === '') {
        cell.classList.add('is-empty')
        cell.textContent = '—'
        return
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const chip = document.createElement('span')
            chip.className = 'ezco-mde-prop-chip'
            appendValue(chip, item, editor)
            cell.append(chip)
        }
        return
    }
    if (typeof value === 'object') {
        cell.textContent = JSON.stringify(value)
        return
    }
    appendText(cell, String(value), editor)
}

/** Text, with any wikilinks in it as links the reader can follow. */
function appendText(cell: HTMLElement, text: string, editor: Editor) {
    let last = 0
    for (let i = text.indexOf('[['); i >= 0; i = text.indexOf('[[', i + 1)) {
        const m = matchWikilinkAt(text, i)
        if (!m) continue
        if (i > last) cell.append(text.slice(last, i))
        const a = document.createElement('a')
        a.className = 'ezco-mde-wikilink'
        a.setAttribute('role', 'link')
        a.textContent = wikilinkLabel(m.link)
        a.addEventListener('mousedown', (e) => e.preventDefault())
        a.addEventListener('click', (e) => {
            e.preventDefault()
            const wikilink = (editor.storage as any).wikilink as WikilinkStorage | undefined
            void wikilink?.follow(m.link.target, m.link.fragment)
        })
        cell.append(a)
        last = m.end
        i = m.end - 1
    }
    if (last < text.length) cell.append(text.slice(last))
}
