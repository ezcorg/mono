/**
 * Embeds: `![[target]]`, the wikilink grammar with a `!`. What shows depends
 * on what the target is, resolved through the host's resolver as a wikilink
 * is:
 *
 * - an image (`![[diagram.png|300]]`): the image, sized by the alias;
 * - a note (`![[Plan]]`, `![[Plan#Goals]]`): the note, or the section under
 *   the named heading, shown read-only as the note itself would show it
 *   (`renderReadOnly`), refreshed when the vault changes;
 * - a range of a note (`![[Plan#:~:text=ship%20it]]`, a pin `#c-…`): the
 *   passage, quoted, which is what a comment's reference block is: a
 *   portal into the other document, named over it with who wrote it (a
 *   comment's document) and the lines the passage is on, and, when the
 *   passage sits in a plain paragraph, that paragraph around it in the
 *   muted colour, the quoted words alone in full. Its header opens the
 *   note at the passage;
 * - anything else: a card that opens the file (for `![[src/lib.rs#L40-L80]]`,
 *   naming the lines; a region of a file to read and edit in the note is a
 *   fence, ```` ```src/lib.rs#L40-L80 ````, see `codeblock.ts`).
 *
 * The node serializes to exactly the source it came from.
 */
import { Node, mergeAttributes, type AnyExtension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { basename, extname } from '@joinezco/storage'
import { findTextFragment, formatWikilink, frontMatterOf, isNote, matchWikilinkAt, parseTextFragment, type Wikilink as WikilinkParts } from '@joinezco/vault'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import { IMAGE_EXTENSIONS, objectUrlFor, resolveAsset, sizeOf, vaultOf } from './assets'
import { wikilinkLabel, type WikilinkStorage } from './wikilink'
import { slugify } from './slug-utils'
import { lineRange } from '@joinezco/codeblock'
import { authorOf } from './comments'
import { renderReadOnly, type ReadOnlyView } from './comment-render'

export interface EmbedOptions {
    /** The extensions an embedded note's text is shown with: the note's
     *  own, without its chrome; a lean set otherwise. */
    render?: () => AnyExtension[]
}

const attrsOf = (node: PMNode): WikilinkParts => ({
    target: node.attrs.target ?? '',
    fragment: node.attrs.fragment ?? null,
    alias: node.attrs.alias ?? null,
})

const optionalData = (name: string) => ({
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`),
    renderHTML: (attrs: Record<string, unknown>) =>
        attrs[name] === null || attrs[name] === undefined ? {} : { [`data-${name}`]: attrs[name] },
})

/** Where the passage a range names is in a note's text: a text fragment
 *  found in it, or a pinned span `[…]{#id}`; null when it is not there. */
export function passageRange(markdown: string, fragment: string): { from: number; to: number } | null {
    if (fragment.startsWith(':~:text=')) {
        const f = parseTextFragment(fragment)
        const found = f ? findTextFragment(markdown, f) : null
        return found ? { from: found.from, to: found.to } : null
    }
    const close = markdown.indexOf(`]{#${fragment}`)
    if (close < 0) return null
    let depth = 0
    for (let i = close - 1; i >= 0; i--) {
        if (markdown[i] === ']') depth++
        else if (markdown[i] === '[') {
            if (!depth) return { from: i + 1, to: close }
            depth--
        }
    }
    return null
}

/** The passage of a note a range names, or null when it is not there. */
export function passageOf(markdown: string, fragment: string): string | null {
    const range = passageRange(markdown, fragment)
    return range ? markdown.slice(range.from, range.to) : null
}

/** What is around a passage, when that is plain enough to show with it:
 *  the paragraph it sits in (blank lines to blank lines) when that is prose,
 *  not a heading, a list, a quote, a fence, a table or a reference, is not
 *  long, and holds more than the passage. Null otherwise. */
export function contextOf(markdown: string, range: { from: number; to: number }): string | null {
    const before = markdown.lastIndexOf('\n\n', Math.max(0, range.from - 1))
    const start = before < 0 ? 0 : before + 2
    const after = markdown.indexOf('\n\n', range.to)
    const end = after < 0 ? markdown.length : after
    const paragraph = markdown.slice(start, end)
    // A passage across paragraphs is shown as it is: no one paragraph is its context.
    if (markdown.slice(range.from, range.to).includes('\n\n')) return null
    if (paragraph.length > 800) return null
    if (/^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~|\||!\[\[|\[\^|---|\$\$)/.test(paragraph)) return null
    if (paragraph.trim() === markdown.slice(range.from, range.to).trim()) return null
    return paragraph
}

/** `lines 12–14`, or `line 12`, for a range of a text. */
function linesOf(markdown: string, range: { from: number; to: number }): string {
    const line = (at: number) => markdown.slice(0, at).split('\n').length
    const a = line(range.from)
    const b = line(Math.max(range.from, range.to - 1))
    return a === b ? `line ${a}` : `lines ${a}–${b}`
}

/** What a portal says over its content: who wrote the document, when it is
 *  a comment's, and the lines a passage is on. */
function metaOf(path: string, markdown: string, range: { from: number; to: number } | null): string {
    const { author, time } = authorOf(path)
    const parts: string[] = []
    if (time) parts.push(`@${author}`)
    if (range) parts.push(linesOf(markdown, range))
    return parts.join(' · ')
}

/** Whether a fragment names a passage (not a heading). */
const isPassage = (fragment: string | null): fragment is string => !!fragment && (fragment.startsWith(':~:text=') || /^c-/.test(fragment))

/** The part of a note under the heading `fragment` names: that heading and
 *  everything up to the next heading of its level or above. */
export function sectionOf(markdown: string, fragment: string): string | null {
    const want = slugify(fragment.split('#').filter(Boolean).pop() ?? fragment)
    const lines = markdown.split('\n')
    let start = -1
    let level = 0
    let fence = false
    for (let i = 0; i < lines.length; i++) {
        if (/^\s{0,3}(`{3,}|~{3,})/.test(lines[i])) fence = !fence
        if (fence) continue
        const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i])
        if (!h) continue
        if (start < 0) {
            if (slugify(h[2]) === want) {
                start = i
                level = h[1].length
            }
        } else if (h[1].length <= level) {
            return lines.slice(start, i).join('\n').trimEnd()
        }
    }
    return start < 0 ? null : lines.slice(start).join('\n').trimEnd()
}

export const Embed = Node.create<EmbedOptions>({
    name: 'embed',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,

    addOptions() {
        return { render: undefined }
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
        return [{ tag: 'span[data-embed]' }]
    },

    renderHTML({ node, HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { 'data-embed': '' }), wikilinkLabel(attrsOf(node))]
    },

    renderText({ node }) {
        return formatWikilink(attrsOf(node), { embed: true })
    },

    extendNodeSchema(extension) {
        return extension.name === 'embed' ? { leafText: (node: PMNode) => wikilinkLabel(attrsOf(node)) } : {}
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: PMNode) {
                    state.write(formatWikilink(attrsOf(node), { embed: true, inTable: !!state.inTable }))
                },
                parse: {
                    setup(markdownit: any) {
                        if (markdownit.__ezcoEmbed) return
                        markdownit.__ezcoEmbed = true
                        markdownit.inline.ruler.before('image', 'ezco_embed', (state: any, silent: boolean) => {
                            if (state.src.charCodeAt(state.pos) !== 0x21 /* ! */) return false
                            const m = matchWikilinkAt(state.src, state.pos)
                            if (!m?.embed || m.end > state.posMax) return false
                            if (!silent) state.push('ezco_embed', '', 0).meta = m.link
                            state.pos = m.end
                            return true
                        })
                        const esc = markdownit.utils.escapeHtml
                        markdownit.renderer.rules.ezco_embed = (tokens: any[], idx: number) => {
                            const link: WikilinkParts = tokens[idx].meta
                            let attrs = ` data-embed="" data-target="${esc(link.target)}"`
                            if (link.fragment !== null) attrs += ` data-fragment="${esc(link.fragment)}"`
                            if (link.alias !== null) attrs += ` data-alias="${esc(link.alias)}"`
                            return `<span${attrs}>${esc(wikilinkLabel(link))}</span>`
                        }
                    },
                },
            } as MarkdownNodeSpec,
        }
    },

    addNodeView() {
        const editor = this.editor
        const options = this.options
        return ({ node }) => {
            let current = node
            const dom = document.createElement('span')
            dom.className = 'ezco-mde-embed'
            dom.contentEditable = 'false'
            let url: string | null = null
            let token = 0
            /** The other document's text, shown as the note shows text. */
            let shown: ReadOnlyView | null = null
            const release = () => {
                if (url) URL.revokeObjectURL(url)
                url = null
            }
            const show = (markdown: string, highlight: string | null = null): HTMLElement => {
                shown?.destroy()
                shown = renderReadOnly(editor, markdown, { extensions: options.render?.(), className: 'ezco-mde-embed-body', highlight })
                const content = document.createElement('div')
                content.className = 'ezco-mde-embed-content'
                content.append(shown.dom)
                return content
            }
            const follow = () => {
                const parts = attrsOf(current)
                const wikilink = (editor.storage as any).wikilink as WikilinkStorage | undefined
                void wikilink?.follow(parts.target, lineRange(parts.fragment) ? null : parts.fragment)
            }

            const render = async () => {
                const mine = ++token
                const parts = attrsOf(current)
                const { fs } = vaultOf(editor)
                const resolution = parts.target.trim() ? await resolveAsset(editor, parts.target, 'wikilink') : null
                if (mine !== token) return
                dom.dataset.path = resolution?.path ?? ''
                if (!fs || !resolution?.exists) {
                    release()
                    dom.className = 'ezco-mde-embed is-missing'
                    dom.replaceChildren(card(`${parts.target || 'this note'} (not written yet)`, follow))
                    return
                }
                const path = resolution.path
                const ext = extname(path)
                try {
                    if (IMAGE_EXTENSIONS.has(ext)) {
                        const next = await objectUrlFor(fs, path)
                        if (mine !== token) return URL.revokeObjectURL(next)
                        release()
                        url = next
                        const img = document.createElement('img')
                        img.src = next
                        img.alt = basename(path)
                        img.draggable = false
                        const { width, height } = sizeOf(parts.alias === null ? null : `|${parts.alias}`)
                        if (width) img.style.width = `${width}px`
                        if (height) img.style.height = `${height}px`
                        shown?.destroy()
                        shown = null
                        dom.className = 'ezco-mde-embed ezco-mde-embed--image'
                        dom.replaceChildren(img)
                        return
                    }
                    release()
                    if (isNote(path)) {
                        const text = await fs.readFile(path)
                        if (mine !== token) return
                        const body = frontMatterOf(text) === null ? text : text.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '')
                        if (isPassage(parts.fragment)) {
                            // A quoted passage: what a comment is about, a
                            // portal into its document. Its header takes
                            // the reader to it.
                            const range = passageRange(body, parts.fragment)
                            const context = range && parts.fragment.startsWith(':~:text=') ? contextOf(body, range) : null
                            const markdown = !range ? '*This passage is no longer in the note.*' : context ?? body.slice(range.from, range.to)
                            dom.className = 'ezco-mde-embed ezco-mde-embed--note ezco-mde-embed--passage' + (range ? '' : ' is-orphaned') + (context ? ' has-context' : '')
                            dom.replaceChildren(
                                header(parts.alias || wikilinkLabel({ target: parts.target, fragment: null, alias: null }), follow, metaOf(path, body, range)),
                                show(markdown, context ? parts.fragment : null),
                            )
                            return
                        }
                        const section = parts.fragment ? sectionOf(body, parts.fragment) : body
                        dom.className = 'ezco-mde-embed ezco-mde-embed--note'
                        dom.replaceChildren(header(parts.alias || wikilinkLabel({ ...parts, alias: null }), follow, metaOf(path, body, null)), show(section ?? `*No heading “${parts.fragment}” in this note.*`))
                        return
                    }
                    const range = lineRange(parts.fragment)
                    dom.className = 'ezco-mde-embed ezco-mde-embed--file'
                    dom.replaceChildren(card(range ? `${basename(path)} · ${lines(range)}` : basename(path), follow))
                } catch (e) {
                    dom.className = 'ezco-mde-embed is-missing'
                    dom.replaceChildren(card(`${parts.target}: ${(e as Error).message}`, follow))
                }
            }
            void render()
            const wikilink = (editor.storage as any).wikilink as WikilinkStorage | undefined
            const off = wikilink?.onResolutionsChanged(() => void render()) ?? (() => {})

            return {
                dom,
                update(next) {
                    if (next.type !== current.type) return false
                    const changed = JSON.stringify(next.attrs) !== JSON.stringify(current.attrs)
                    current = next
                    if (changed) void render()
                    return true
                },
                stopEvent: (e) => e.type === 'mousedown' && !!(e.target as HTMLElement).closest('.ezco-mde-embed-open'),
                ignoreMutation: () => true,
                destroy() {
                    token++
                    release()
                    shown?.destroy()
                    shown = null
                    off()
                },
            }
        }
    },
})

/** `lines 40–80`, `line 40`. */
function lines(range: { from: number; to: number }): string {
    return range.from === range.to ? `line ${range.from}` : `lines ${range.from}–${range.to}`
}

function header(title: string, open: () => void, meta = ''): HTMLElement {
    const bar = document.createElement('span')
    bar.className = 'ezco-mde-embed-header'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ezco-mde-embed-open'
    button.textContent = title
    button.title = 'Open'
    button.addEventListener('mousedown', (e) => e.preventDefault())
    button.addEventListener('click', open)
    bar.append(button)
    if (meta) {
        const span = document.createElement('span')
        span.className = 'ezco-mde-embed-meta'
        span.textContent = meta
        bar.append(span)
    }
    return bar
}

function card(title: string, open: () => void): HTMLElement {
    const el = header(title, open)
    el.classList.add('ezco-mde-embed-card')
    return el
}
