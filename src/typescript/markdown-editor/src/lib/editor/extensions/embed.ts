/**
 * Embeds: `![[target]]`, the wikilink grammar with a `!`. What shows depends
 * on what the target is, resolved through the host's resolver as a wikilink
 * is:
 *
 * - an image (`![[diagram.png|300]]`): the image, sized by the alias;
 * - a note (`![[Plan]]`, `![[Plan#Goals]]`): the note, or the section under
 *   the named heading, rendered read-only, refreshed when the vault changes;
 * - a range of a note (`![[Plan#:~:text=ship%20it]]`, a pin `#c-…`): the
 *   passage, quoted, which is what a comment's reference block is; its
 *   header opens the note at that passage;
 * - anything else: a card that opens the file (for `![[src/lib.rs#L40-L80]]`,
 *   naming the lines; a region of a file to read and edit in the note is a
 *   fence, ```` ```src/lib.rs#L40-L80 ````, see `codeblock.ts`).
 *
 * The node serializes to exactly the source it came from.
 */
import { Editor, Node, mergeAttributes } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { basename, extname } from '@joinezco/storage'
import { findTextFragment, formatWikilink, frontMatterOf, isNote, matchWikilinkAt, parseTextFragment, type Wikilink as WikilinkParts } from '@joinezco/vault'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import { IMAGE_EXTENSIONS, objectUrlFor, resolveAsset, sizeOf, vaultOf } from './assets'
import { wikilinkLabel, type WikilinkStorage } from './wikilink'
import { slugify } from './slug-utils'
import { lineRange } from '@joinezco/codeblock'

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

/** The passage of a note a range names: a text fragment found in its
 *  text, or a pinned span `[…]{#id}`; null when it is not there. */
export function passageOf(markdown: string, fragment: string): string | null {
    if (fragment.startsWith(':~:text=')) {
        const f = parseTextFragment(fragment)
        const found = f ? findTextFragment(markdown, f) : null
        return found ? markdown.slice(found.from, found.to) : null
    }
    const close = markdown.indexOf(`]{#${fragment}`)
    if (close < 0) return null
    let depth = 0
    for (let i = close - 1; i >= 0; i--) {
        if (markdown[i] === ']') depth++
        else if (markdown[i] === '[') {
            if (!depth) return markdown.slice(i + 1, close)
            depth--
        }
    }
    return null
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

function renderMarkdown(editor: Editor, markdown: string): string {
    const md = (editor.storage as any).markdown?.parser?.md
    if (!md) return ''
    return md.render(markdown)
}

export const Embed = Node.create({
    name: 'embed',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,

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
        return ({ node }) => {
            let current = node
            const dom = document.createElement('span')
            dom.className = 'ezco-mde-embed'
            dom.contentEditable = 'false'
            let url: string | null = null
            let token = 0
            const release = () => {
                if (url) URL.revokeObjectURL(url)
                url = null
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
                        dom.className = 'ezco-mde-embed ezco-mde-embed--image'
                        dom.replaceChildren(img)
                        return
                    }
                    release()
                    if (isNote(path)) {
                        const text = await fs.readFile(path)
                        if (mine !== token) return
                        const body = frontMatterOf(text) === null ? text : text.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '')
                        const content = document.createElement('div')
                        content.className = 'ezco-mde-embed-content'
                        if (isPassage(parts.fragment)) {
                            // A quoted passage: what a comment is about. Its
                            // header takes the reader to it.
                            const passage = passageOf(body, parts.fragment)
                            content.innerHTML = renderMarkdown(editor, passage ?? '*This passage is no longer in the note.*')
                            dom.className = 'ezco-mde-embed ezco-mde-embed--note ezco-mde-embed--passage' + (passage === null ? ' is-orphaned' : '')
                            dom.replaceChildren(header(parts.alias || wikilinkLabel({ target: parts.target, fragment: null, alias: null }), follow), content)
                            return
                        }
                        const section = parts.fragment ? sectionOf(body, parts.fragment) : body
                        content.innerHTML = renderMarkdown(editor, section ?? `*No heading “${parts.fragment}” in this note.*`)
                        dom.className = 'ezco-mde-embed ezco-mde-embed--note'
                        dom.replaceChildren(header(parts.alias || wikilinkLabel({ ...parts, alias: null }), follow), content)
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

function header(title: string, open: () => void): HTMLElement {
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
    return bar
}

function card(title: string, open: () => void): HTMLElement {
    const el = header(title, open)
    el.classList.add('ezco-mde-embed-card')
    return el
}
