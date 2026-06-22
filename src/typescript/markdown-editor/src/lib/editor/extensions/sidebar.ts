/**
 * Document outline sidebar.
 *
 * Auto-generates a navigable table of contents from the document's heading
 * structure and renders it in a `<nav>` *outside* the editor body. By default
 * it's inserted as the sibling immediately **before** the editor's root element
 * (so it sits to the left when the host lays the two out in a flex row); a
 * consumer can place it anywhere via the `mount` option (mirrors the toolbar).
 *
 * Clicking an entry smoothly scrolls its heading into view; as the document
 * scrolls, the entry for the current section is highlighted.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/** Where the sidebar DOM should be placed (same shape as `ToolbarMount`). */
export type SidebarMount =
    | HTMLElement
    | ((editorRoot: HTMLElement) => HTMLElement | null | void)

export interface SidebarOptions {
    /**
     * Where to render the outline. It always lives *outside* the editor body;
     * this controls which element it lands in:
     *  - `HTMLElement` → the sidebar is appended into it.
     *  - function → called with the editor's root element; return a container
     *    to append into, or mount the node yourself and return nothing.
     *  - `undefined` (default) → inserted as the sibling immediately *before*
     *    the editor's root element. Reads as a left column when the host lays
     *    the sidebar + editor out in a flex row.
     */
    mount?: SidebarMount
    /** Extra class(es) added to the sidebar root, for consumer theming. */
    className?: string
    /** Optional heading shown above the outline (e.g. "Contents"). */
    title?: string
}

interface OutlineEntry {
    level: number
    /** Document position immediately before the heading node — kept fresh on
     *  every doc change so click-to-scroll + active tracking stay correct
     *  without rebuilding the list. */
    pos: number
    row: HTMLElement
}

/** A run of heading text sharing the same set of (rendered) inline marks. */
interface InlineSegment {
    text: string
    marks: string[]
}

// Mark name → the element that renders it in the outline. Anything not listed
// (notably `link`) renders as plain text — the outline navigates by scroll, so
// a nested anchor would be misleading.
const MARK_TAG: Record<string, string> = {
    code: 'code',
    bold: 'strong',
    italic: 'em',
    strike: 's',
}

/** Break a heading's inline content into mark-tagged text runs. */
function inlineSegments(node: PMNode): InlineSegment[] {
    const segments: InlineSegment[] = []
    node.descendants((child) => {
        if (child.isText && child.text) {
            segments.push({
                text: child.text,
                marks: child.marks.map((m) => m.type.name).filter((name) => name !== 'link'),
            })
        }
        return true
    })
    return segments
}

/** Build escaped DOM for a heading's inline segments (text wrapped in its mark
 *  elements). Uses text nodes, so heading content is never parsed as HTML. */
function segmentsToFragment(segments: InlineSegment[]): DocumentFragment {
    const frag = document.createDocumentFragment()
    for (const seg of segments) {
        let node: Node = document.createTextNode(seg.text)
        for (const mark of seg.marks) {
            const tag = MARK_TAG[mark]
            if (!tag) continue
            const el = document.createElement(tag)
            el.appendChild(node)
            node = el
        }
        frag.appendChild(node)
    }
    return frag
}

/** Stable key for a heading list, EXCLUDING positions — so editing body text
 *  (which shifts heading positions but not the outline's content) doesn't
 *  trigger a DOM rebuild, and thus no active-row flash. */
function outlineSignature(
    headings: { level: number; segments: InlineSegment[] }[],
): string {
    return headings
        .map((h) => `${h.level}|` + h.segments.map((s) => `${s.marks.join(',')}:${s.text}`).join(''))
        .join('\n')
}

/** Nearest scrollable ancestor of `el` (falls back to the document scroller). */
function findScrollContainer(el: HTMLElement | null): HTMLElement {
    let node = el?.parentElement ?? null
    while (node && node !== document.body) {
        const oy = getComputedStyle(node).overflowY
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return node
        node = node.parentElement
    }
    return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

class SidebarView {
    private nav: HTMLElement
    private list: HTMLElement
    private entries: OutlineEntry[] = []
    private signature = ''
    private scroller: HTMLElement
    private scrollTarget: EventTarget
    private rafPending = false
    private onScroll: () => void

    constructor(
        private view: EditorView,
        options: SidebarOptions,
    ) {
        this.nav = document.createElement('nav')
        this.nav.className = 'ezco-mde-sidebar'
        this.nav.setAttribute('aria-label', 'Document outline')
        for (const cls of (options.className ?? '').split(/\s+/).filter(Boolean)) {
            this.nav.classList.add(cls)
        }

        if (options.title) {
            const header = document.createElement('div')
            header.className = 'ezco-mde-sidebar-title'
            header.textContent = options.title
            this.nav.appendChild(header)
        }

        this.list = document.createElement('ul')
        this.list.className = 'ezco-mde-sidebar-list'
        this.nav.appendChild(this.list)

        this.mount(options.mount)

        // Active-section tracking follows the editor's scroll container.
        this.scroller = findScrollContainer(
            (view.dom.parentElement as HTMLElement | null) ?? (view.dom as HTMLElement),
        )
        const docScroller = this.scroller === document.documentElement ||
            this.scroller === document.scrollingElement
        this.scrollTarget = docScroller ? window : this.scroller
        this.onScroll = () => {
            if (this.rafPending) return
            this.rafPending = true
            requestAnimationFrame(() => {
                this.rafPending = false
                this.updateActive()
            })
        }
        this.scrollTarget.addEventListener('scroll', this.onScroll, { passive: true })

        this.rebuild()
    }

    private mount(mount: SidebarMount | undefined) {
        const editorRoot = this.view.dom.parentElement as HTMLElement | null
        if (mount instanceof HTMLElement) {
            mount.appendChild(this.nav)
        } else if (typeof mount === 'function' && editorRoot) {
            const container = mount(editorRoot)
            if (container instanceof HTMLElement) container.appendChild(this.nav)
        } else if (editorRoot?.parentElement) {
            // Default: the sibling immediately before the editor root (left of
            // it in a flex row).
            editorRoot.parentElement.insertBefore(this.nav, editorRoot)
        } else if (editorRoot) {
            editorRoot.insertBefore(this.nav, this.view.dom)
        } else {
            document.body.appendChild(this.nav)
        }
    }

    /** Collect the document's headings (in order), with their inline content. */
    private collectHeadings(): { level: number; segments: InlineSegment[]; pos: number }[] {
        const out: { level: number; segments: InlineSegment[]; pos: number }[] = []
        this.view.state.doc.descendants((node, pos) => {
            if (node.type.name === 'heading') {
                out.push({
                    level: Number(node.attrs.level) || 1,
                    segments: inlineSegments(node),
                    pos,
                })
                return false // headings have no heading descendants
            }
            return true
        })
        return out
    }

    /**
     * Reconcile the outline with the document. The DOM is rebuilt only when the
     * heading STRUCTURE changes (a heading added / removed / retitled / re-level
     * / re-styled — `outlineSignature` deliberately ignores positions). Edits
     * elsewhere merely shift heading positions, so we refresh the stored
     * positions in place and re-evaluate the active row WITHOUT touching the
     * DOM — which is what stops the selected row's highlight from flickering on
     * every keystroke.
     */
    private rebuild() {
        const headings = this.collectHeadings()
        const signature = outlineSignature(headings)

        if (signature === this.signature) {
            // Same headings → only positions moved. Update them in place (the
            // counts match, since the signature is unchanged) and re-evaluate
            // the active row; the DOM, and thus the highlight, is untouched.
            for (let i = 0; i < this.entries.length && i < headings.length; i++) {
                this.entries[i].pos = headings[i].pos
            }
            this.updateActive()
            return
        }
        this.signature = signature

        this.list.replaceChildren()
        this.entries = []
        // Normalize indentation to the shallowest heading present, so a doc
        // whose top level is H2 doesn't render with a wasted leading indent.
        const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6)

        for (const h of headings) {
            const li = document.createElement('li')
            li.className = 'ezco-mde-sidebar-item'
            li.style.setProperty('--depth', String(h.level - minLevel))

            const a = document.createElement('a')
            a.className = 'ezco-mde-sidebar-link'
            a.setAttribute('data-level', String(h.level))
            // Mirror the heading's own inline styling (code/bold/italic/strike);
            // links render as plain text (the outline navigates by scroll).
            if (h.segments.length) {
                a.appendChild(segmentsToFragment(h.segments))
            } else {
                a.textContent = 'Untitled'
            }
            a.href = '#'

            // `entry.pos` is kept live by the fast path above, so a click always
            // scrolls to the heading's CURRENT position even after later edits.
            const entry: OutlineEntry = { level: h.level, pos: h.pos, row: a }
            a.addEventListener('mousedown', (e) => e.preventDefault())
            a.addEventListener('click', (e) => {
                e.preventDefault()
                this.goTo(entry.pos)
            })

            li.appendChild(a)
            this.list.appendChild(li)
            this.entries.push(entry)
        }

        // Hide the chrome entirely when there's nothing to outline.
        this.nav.classList.toggle('ezco-mde-sidebar--empty', this.entries.length === 0)
        this.updateActive()
    }

    /** Smoothly scroll the heading at `pos` into view. */
    private goTo(pos: number) {
        const dom = this.view.nodeDOM(pos) as HTMLElement | null
        if (dom && typeof dom.scrollIntoView === 'function') {
            dom.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
    }

    /** Highlight the entry for the heading currently at the top of the view. */
    private updateActive() {
        if (this.entries.length === 0) return
        const scrollerTop = this.scroller === document.documentElement ||
            this.scroller === document.scrollingElement
            ? 0
            : this.scroller.getBoundingClientRect().top
        const threshold = scrollerTop + 80

        let activeIndex = 0
        for (let i = 0; i < this.entries.length; i++) {
            const dom = this.view.nodeDOM(this.entries[i].pos) as HTMLElement | null
            if (!dom) continue
            if (dom.getBoundingClientRect().top <= threshold) activeIndex = i
            else break
        }

        this.entries.forEach((e, i) =>
            e.row.classList.toggle('is-active', i === activeIndex),
        )
    }

    update() {
        // Cheap when unchanged: rebuild() diffs the heading signature and only
        // touches the DOM when headings were added/removed/retitled/moved.
        this.rebuild()
    }

    destroy() {
        this.scrollTarget.removeEventListener('scroll', this.onScroll)
        this.nav.remove()
    }
}

export const Sidebar = Extension.create<SidebarOptions>({
    name: 'sidebar',

    addOptions() {
        return {
            mount: undefined,
            className: undefined,
            title: undefined,
        }
    },

    addProseMirrorPlugins() {
        const extension = this
        return [
            new Plugin({
                key: new PluginKey('sidebar'),
                view: (editorView) => new SidebarView(editorView, extension.options),
            }),
        ]
    },
})
