/**
 * Comments (comments RFC; the platform RFC's §4): threads written in the
 * note as footnotes, anchored by links to its text.
 *
 * - `CommentThread` is a footnote definition whose first line is a thread
 *   header. It holds the thread's source, written back byte for byte until
 *   a command changes it, and is hidden in the body: the margin shows it.
 * - `Comments` finds each thread's targets (text fragments, pins, block ids
 *   and headings; threads written in other notes come from the host's
 *   `CommentIndex`), highlights what they anchor, keeps text fragments
 *   pointing at their text as it is edited, and has the commands.
 *
 * Re-anchoring: an edit in the editor is mapped through, so a target whose
 * quoted text was changed is rewritten, in the same step, to quote what its
 * range holds now (or pinned, when no quote can be unique). A target found
 * only approximately (its text changed outside the editor) is rewritten to
 * the text it was found at. A thread written elsewhere is rewritten there,
 * through the index, when the note is saved.
 */
import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core'
import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
    commentTime,
    formatTextFragment,
    formatThread,
    isReaction,
    newCommentId,
    normalizePath,
    parseTextFragment,
    parseThreadDefinition,
    parseThreadHeader,
    stripComments,
    textFragmentFor,
    type CommentIndex,
    type CommentRef,
    type Message,
    type Thread,
    type Wikilink,
} from '@joinezco/storage'
import type { MarkdownNodeSpec } from 'tiptap-markdown'
import { footnoteDefinitionRule } from './footnote'
import { docText, findBlockId, findFragment, findPin, locateTextFragment, textOffset, type DocText } from './fragment'
import { documentId } from './front-matter'
import type { FileSystemStorage } from './filesystem'

// ── The thread node ─────────────────────────────────────────────────────────

const THREAD_LINE = /^\[\^([^\]\s]+)\]: (.*)$/

/** A top-level footnote definition whose first line is a thread header: its
 *  lines (exactly those a footnote would take) as one token. */
function commentThreadRule(state: any, startLine: number, endLine: number, silent: boolean): boolean {
    if (state.level !== 0 || state.sCount[startLine] - state.blkIndent >= 4) return false
    const lineStart = state.bMarks[startLine] + state.tShift[startLine]
    const m = THREAD_LINE.exec(state.src.slice(lineStart, state.eMarks[startLine]))
    if (!m || !parseThreadHeader(m[2])) return false
    if (silent) return true
    const count = state.tokens.length
    if (!footnoteDefinitionRule(state, startLine, endLine, false)) return false
    state.tokens.length = count
    let last = state.line
    while (last > startLine + 1 && state.isEmpty(last - 1)) last--
    const token = state.push('ezco_comment_thread', 'div', 0)
    token.meta = { label: m[1], source: state.src.slice(lineStart, state.eMarks[last - 1]) }
    token.map = [startLine, state.line]
    return true
}

function setupMarkdownIt(markdownit: any) {
    if (markdownit.__ezcoComments) return
    markdownit.__ezcoComments = true
    const alt = { alt: ['paragraph', 'reference'] }
    // Ahead of footnote definitions, so a thread is not taken for one.
    try {
        markdownit.block.ruler.before('ezco_footnote_def', 'ezco_comment_thread', commentThreadRule, alt)
    } catch {
        markdownit.block.ruler.before('reference', 'ezco_comment_thread', commentThreadRule, alt)
    }
    const esc = markdownit.utils.escapeHtml
    markdownit.renderer.rules.ezco_comment_thread = (tokens: any[], idx: number) =>
        `<div data-comment-thread="${esc(tokens[idx].meta.label)}" data-source="${esc(tokens[idx].meta.source)}"></div>`
}

export const CommentThread = Node.create({
    name: 'commentThread',
    group: 'block',
    atom: true,
    selectable: false,
    draggable: false,

    addAttributes() {
        return {
            label: {
                default: '',
                parseHTML: (el) => el.getAttribute('data-comment-thread') ?? '',
                renderHTML: (attrs) => ({ 'data-comment-thread': attrs.label }),
            },
            /** The thread as written, from `[^` to its last line. */
            source: {
                default: '',
                parseHTML: (el) => el.getAttribute('data-source') ?? '',
                renderHTML: (attrs) => ({ 'data-source': attrs.source }),
            },
        }
    },

    parseHTML() {
        return [{ tag: 'div[data-comment-thread]' }]
    },

    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes, { class: 'ezco-mde-comment-thread', hidden: '' })]
    },

    addStorage() {
        return {
            markdown: {
                serialize(state: any, node: PMNode) {
                    state.write(node.attrs.source)
                    state.closeBlock(node)
                },
                parse: { setup: setupMarkdownIt },
            } as MarkdownNodeSpec,
        }
    },
})

// ── What the plugin knows ───────────────────────────────────────────────────

export interface CommentTarget {
    link: Wikilink
    /** Where it is in this note; null for the whole note, a place in
     *  another note, or one not found. */
    range: { from: number; to: number } | null
    /** Found only approximately: its text changed outside the editor. */
    approximate: boolean
    /** In another note. */
    elsewhere: boolean
    /** Names a place in this note that is not there. */
    orphaned: boolean
}

export interface CommentThreadInfo {
    /** The note's own threads: the footnote label. One written elsewhere:
     *  its note and its label (or line). */
    id: string
    thread: Thread
    /** Where the note's own thread's node is; null for one written elsewhere. */
    pos: number | null
    /** Where a thread written elsewhere lives. */
    ref: CommentRef | null
    targets: CommentTarget[]
    /** Where it sits in the note (its first target found here), or null. */
    anchor: number | null
    orphaned: boolean
}

/** A message in a thread: `[]` the thread's own, `[i]` its i-th reply,
 *  `[i, j]` that reply's j-th, and so on. */
export type MessagePath = number[]

interface Range {
    from: number
    to: number
}

interface CommentsState {
    threads: CommentThreadInfo[]
    external: CommentRef[]
    active: string | null
    /** Text chosen for a comment not yet written. */
    draft: { ranges: Range[] } | null
    decorations: DecorationSet
}

interface CommentsMeta {
    external?: CommentRef[]
    active?: string | null
    draft?: { ranges: Range[] } | null
    reanchored?: true
}

export const commentsKey = new PluginKey<CommentsState>('comments')

type Parsed = { label: string; thread: Thread } | null

function locate(doc: PMNode, link: Wikilink, elsewhere: boolean, text: () => DocText): CommentTarget {
    const target = { link, range: null, approximate: false, elsewhere, orphaned: false }
    if (elsewhere) return target
    const fragment = link.fragment?.trim()
    if (!fragment) return target
    if (fragment.startsWith(':~:text=')) {
        const found = locateTextFragment(doc, fragment, undefined, text())
        return found ? { ...target, range: { from: found.from, to: found.to }, approximate: !found.exact } : { ...target, orphaned: true }
    }
    const range = fragment.startsWith('^') ? findBlockId(doc, fragment.slice(1)) : findPin(doc, fragment) ?? findFragment(doc, fragment)
    return range ? { ...target, range: { from: range.from, to: range.to } } : { ...target, orphaned: true }
}

function collect(doc: PMNode, external: CommentRef[], parse: (source: string) => Parsed): CommentThreadInfo[] {
    let flat: DocText | null = null
    const text = () => (flat ??= docText(doc))
    const info = (id: string, thread: Thread, pos: number | null, ref: CommentRef | null, targets: CommentTarget[]): CommentThreadInfo => ({
        id,
        thread,
        pos,
        ref,
        targets,
        anchor: targets.find((t) => t.range)?.range?.from ?? null,
        orphaned: targets.some((t) => t.orphaned),
    })
    const out: CommentThreadInfo[] = []
    doc.forEach((node, pos) => {
        if (node.type.name !== 'commentThread') return
        const parsed = parse(node.attrs.source)
        if (!parsed) return
        out.push(info(parsed.label, parsed.thread, pos, null, parsed.thread.targets.map((l) => locate(doc, l, !!l.target.trim(), text))))
    })
    for (const ref of external) {
        const targets = ref.thread.targets.map((l, i) => locate(doc, l, !ref.about[i], text))
        out.push(info(externalId(ref), ref.thread, null, ref, targets))
    }
    return out
}

const externalId = (ref: CommentRef) => `${ref.source}#${ref.label ?? `L${ref.line}`}`

function decorate(doc: PMNode, threads: CommentThreadInfo[], active: string | null, draft: CommentsState['draft']): DecorationSet {
    const decorations: Decoration[] = []
    for (const t of threads) {
        if (t.thread.status !== 'open' && t.id !== active) continue
        for (const target of t.targets) {
            if (!target.range || target.range.to <= target.range.from) continue
            decorations.push(
                Decoration.inline(target.range.from, target.range.to, {
                    class: t.id === active ? 'ezco-mde-comment is-active' : 'ezco-mde-comment',
                }),
            )
        }
    }
    for (const r of draft?.ranges ?? []) {
        if (r.to > r.from) decorations.push(Decoration.inline(r.from, r.to, { class: 'ezco-mde-comment is-draft' }))
    }
    return DecorationSet.create(doc, decorations)
}

// ── Changing threads ────────────────────────────────────────────────────────

/** The message at `path`, or null. */
export function messageAt(root: Message, path: MessagePath): Message | null {
    let at: Message | undefined = root
    for (const i of path) at = at?.replies[i]
    return at ?? null
}

/** `root` with the message at `path` replaced by `change`'s answer (null
 *  removes a reply). */
function updateMessage<T extends Message>(root: T, path: MessagePath, change: (m: Message) => Message | null): T {
    if (!path.length) return (change(root) ?? root) as T
    const [i, ...rest] = path
    if (!root.replies[i]) return root
    const replies = [...root.replies]
    if (rest.length) replies[i] = updateMessage(replies[i], rest, change)
    else {
        const next = change(replies[i])
        if (next) replies[i] = next
        else replies.splice(i, 1)
    }
    return { ...root, replies }
}

/** Ids of every pin in the document. */
function pinIds(doc: PMNode): Set<string> {
    const ids = new Set<string>()
    doc.descendants((node) => {
        for (const m of node.marks) if (m.type.name === 'span' && m.attrs.id) ids.add(m.attrs.id)
        return true
    })
    return ids
}

/** A pin id for thread `label`: the label, then `label-2`, `label-3`… */
function freshPinId(label: string, taken: Set<string>): string {
    let id = label
    for (let n = 2; taken.has(id); n++) id = `${label}-${n}`
    taken.add(id)
    return id
}

/** A target for the text `range` holds: a text fragment unique in the note,
 *  or (when none can be) a pin put around it. */
function anchorFor(tr: Transaction, range: Range, label: string, flat: DocText, taken: Set<string>): Wikilink {
    const f = textFragmentFor(flat.text, textOffset(flat, range.from), textOffset(flat, range.to))
    if (f) return { target: '', fragment: formatTextFragment(f), alias: null }
    const id = freshPinId(label, taken)
    tr.addMark(range.from, range.to, tr.doc.type.schema.marks.span.create({ id }))
    return { target: '', fragment: id, alias: null }
}

/** The span mark with `id` in the document, and where it is. */
function pinMark(doc: PMNode, id: string): { mark: PMMark; from: number; to: number } | null {
    const range = findPin(doc, id)
    if (!range) return null
    let mark: PMMark | null = null
    doc.nodesBetween(range.from, range.to, (node) => {
        mark ??= node.marks.find((m) => m.type.name === 'span' && m.attrs.id === id) ?? null
        return !mark
    })
    return mark ? { mark, ...range } : null
}

const isPinTarget = (link: Wikilink) =>
    !link.target.trim() && !!link.fragment && !link.fragment.startsWith(':~:') && !link.fragment.startsWith('^')

/** Where a new thread goes: after the note's last footnote or thread, else
 *  after its last block with content. */
function threadPosition(doc: PMNode): number {
    let after = -1
    doc.forEach((child, offset) => {
        if (child.type.name === 'footnoteDefinition' || child.type.name === 'commentThread') after = offset + child.nodeSize
    })
    if (after >= 0) return after
    let at = doc.content.size
    for (let i = doc.childCount - 1; i >= 0; i--) {
        const child = doc.child(i)
        if (!(child.type.name === 'paragraph' && child.content.size === 0)) break
        at -= child.nodeSize
    }
    return at
}

function openPath(editor: Editor): string | null {
    const path = ((editor.storage as any).persistence as FileSystemStorage | undefined)?.options?.filepath
    return path ? normalizePath(path) : null
}

// ── Export ──────────────────────────────────────────────────────────────────

/** A W3C Web Annotation (https://www.w3.org/TR/annotation-model/). */
export type WebAnnotation = Record<string, unknown>

const isoTime = (time: string) => (time.length === 17 ? `${time.slice(0, 16)}:00Z` : time)

function annotationsOf(editor: Editor, threads: CommentThreadInfo[]): WebAnnotation[] {
    const flat = docText(editor.state.doc)
    const id = documentId(editor)
    const source = id ? `urn:ezco:note:${id}` : openPath(editor) ?? 'urn:ezco:note'
    const quote = (from: number, to: number) => {
        const start = textOffset(flat, from)
        const end = textOffset(flat, to)
        return {
            source,
            selector: [
                {
                    type: 'TextQuoteSelector',
                    exact: flat.text.slice(start, end),
                    prefix: flat.text.slice(Math.max(0, start - 32), start),
                    suffix: flat.text.slice(end, end + 32),
                },
                { type: 'TextPositionSelector', start, end },
            ],
        }
    }
    const targetOf = (t: CommentTarget): unknown => {
        if (t.range) return quote(t.range.from, t.range.to)
        const f = t.link.fragment?.startsWith(':~:text=') ? parseTextFragment(t.link.fragment) : null
        if (!f) return source
        const selector = (exact: string, prefix: string, suffix: string) => ({ type: 'TextQuoteSelector', exact, prefix, suffix })
        return {
            source,
            selector:
                f.end === null
                    ? selector(f.start, f.prefix, f.suffix)
                    : { type: 'RangeSelector', startSelector: selector(f.start, f.prefix, ''), endSelector: selector(f.end, '', f.suffix) },
        }
    }
    const base = (m: Message, annotationId: string) => ({
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        id: annotationId,
        type: 'Annotation',
        creator: { type: 'Person', nickname: m.author },
        created: isoTime(m.time),
        body: { type: 'TextualBody', value: m.body, format: 'text/markdown' },
    })
    const out: WebAnnotation[] = []
    const replies = (m: Message, parent: string) => {
        m.replies.forEach((r, i) => {
            const rid = `${parent}.${i + 1}`
            out.push({ ...base(r, rid), motivation: isReaction(r.body) ? 'assessing' : 'replying', target: parent })
            replies(r, rid)
        })
    }
    for (const t of threads) {
        const aid = `${source}#${t.id}`
        const targets = t.targets.filter((x) => !x.elsewhere).map(targetOf)
        out.push({ ...base(t.thread, aid), motivation: 'commenting', target: targets.length === 1 ? targets[0] : targets.length ? targets : source })
        replies(t.thread, aid)
    }
    return out
}

// ── The extension ───────────────────────────────────────────────────────────

export interface CommentsOptions {
    /** The handle messages are written as. Without one, threads are shown
     *  and not written. */
    author?: string
    /** Threads written in other notes (a vault's `comments`). */
    index?: CommentIndex
}

export interface CommentsStorage {
    /** Every thread about the open note (its own, then those written
     *  elsewhere), with where each target is. */
    threads: () => CommentThreadInfo[]
    /** The thread being looked at. */
    active: () => string | null
    /** Text chosen for a comment not yet written. */
    draft: () => { ranges: Range[] } | null
    /** Look at a thread (null: none), its text brought into view. */
    focus: (id: string | null) => void
    /** The threads as W3C Web Annotations. */
    exportAnnotations: () => WebAnnotation[]
    /** The note as Markdown, without its threads or their pins. */
    markdownWithoutComments: () => string
    /** Read the threads written elsewhere again. */
    refresh: () => Promise<void>
    /** Who is writing (null: nobody; threads are read-only). */
    author: () => string | null
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        comments: {
            /** Choose the selection for a comment (the margin opens a draft). */
            startComment: () => ReturnType
            cancelComment: () => ReturnType
            /** A new thread about `ranges` (the selection when none are
             *  given; none, and no selection, is a comment on the note). */
            addComment: (options: { body: string; ranges?: Range[] }) => ReturnType
            replyToComment: (id: string, body: string, to?: MessagePath) => ReturnType
            editComment: (id: string, body: string, at?: MessagePath) => ReturnType
            /** Remove a reply, or (`at` empty) the whole thread and its pins. */
            deleteComment: (id: string, at?: MessagePath) => ReturnType
            resolveComment: (id: string) => ReturnType
            reopenComment: (id: string) => ReturnType
            /** Add the author's `emoji` to a message, or take it away. */
            reactToComment: (id: string, emoji: string, to?: MessagePath) => ReturnType
            /** Turn the thread's text-fragment targets into pins. */
            pinComment: (id: string) => ReturnType
            /** Point target `index` of the thread at `range` (the selection
             *  by default): how an orphaned target is anchored again. */
            anchorComment: (id: string, index: number, range?: Range) => ReturnType
            focusComment: (id: string | null) => ReturnType
        }
    }
}

export const Comments = Extension.create<CommentsOptions, CommentsStorage>({
    name: 'comments',

    addOptions() {
        return { author: undefined, index: undefined }
    },

    addStorage() {
        return {
            threads: () => [],
            active: () => null,
            draft: () => null,
            focus: () => {},
            exportAnnotations: () => [],
            markdownWithoutComments: () => '',
            refresh: async () => {},
            author: () => null,
        }
    },

    onBeforeCreate() {
        const editor = this.editor
        const state = () => commentsKey.getState(editor.state)
        this.storage.threads = () => state()?.threads ?? []
        this.storage.active = () => state()?.active ?? null
        this.storage.draft = () => state()?.draft ?? null
        this.storage.focus = (id) => {
            editor.commands.focusComment(id)
        }
        this.storage.exportAnnotations = () => annotationsOf(editor, state()?.threads ?? [])
        this.storage.markdownWithoutComments = () => stripComments((editor.storage as any).markdown.getMarkdown())
        this.storage.author = () => this.options.author ?? null
    },

    addCommands() {
        const author = () => this.options.author ?? null
        const threadsOf = (state: EditorState) => commentsKey.getState(state)?.threads ?? []
        const index = () => this.options.index
        const refresh = () => this.storage.refresh()

        /** Change a thread (null: delete it) wherever it lives. */
        const change =
            (id: string, next: (thread: Thread, info: CommentThreadInfo) => Thread | null) =>
            ({ state, tr, dispatch }: { state: EditorState; tr: Transaction; dispatch?: (tr: Transaction) => void }) => {
                if (!author()) return false
                const info = threadsOf(state).find((t) => t.id === id)
                if (!info) return false
                const updated = next(info.thread, info)
                if (info.pos === null) {
                    const ix = index()
                    if (!ix || !info.ref) return false
                    if (dispatch) void ix.update(info.ref, updated).then(refresh, (error) => {
                        console.error('The thread could not be changed where it lives', error)
                        return refresh()
                    })
                    return true
                }
                const node = tr.doc.nodeAt(info.pos)
                if (!node || node.type.name !== 'commentThread') return false
                if (!dispatch) return true
                if (updated === null) {
                    // Its pins go too, unless another thread points at them.
                    const others = new Set(threadsOf(state).filter((t) => t.id !== id).flatMap((t) => t.thread.targets.filter(isPinTarget).map((l) => l.fragment!)))
                    for (const link of info.thread.targets.filter(isPinTarget)) {
                        if (others.has(link.fragment!)) continue
                        const pin = pinMark(tr.doc, link.fragment!)
                        if (pin) tr.removeMark(pin.from, pin.to, pin.mark)
                    }
                    tr.delete(info.pos, info.pos + node.nodeSize)
                    if (commentsKey.getState(state)?.active === id) tr.setMeta(commentsKey, { active: null } satisfies CommentsMeta)
                } else {
                    tr.setNodeMarkup(info.pos, undefined, { ...node.attrs, source: formatThread(updated, node.attrs.label) })
                }
                dispatch(tr)
                return true
            }

        const message = (body: string): Message => ({ author: author()!, time: commentTime(), body: body.trim(), replies: [] })

        return {
            startComment:
                () =>
                ({ state, tr, dispatch }) => {
                    if (!author() || state.selection.empty) return false
                    const { from, to } = state.selection
                    dispatch?.(tr.setMeta(commentsKey, { draft: { ranges: [{ from, to }] }, active: null } satisfies CommentsMeta))
                    return true
                },
            cancelComment:
                () =>
                ({ tr, dispatch }) => {
                    dispatch?.(tr.setMeta(commentsKey, { draft: null } satisfies CommentsMeta))
                    return true
                },
            addComment:
                ({ body, ranges }) =>
                ({ state, tr, dispatch }) => {
                    if (!author() || !body.trim()) return false
                    const chosen = ranges ?? (state.selection.empty ? [] : [{ from: state.selection.from, to: state.selection.to }])
                    if (!dispatch) return true
                    const label = newCommentId()
                    const flat = docText(tr.doc)
                    const taken = pinIds(tr.doc)
                    const targets = chosen.filter((r) => r.to > r.from).map((r) => anchorFor(tr, r, label, flat, taken))
                    const thread: Thread = { ...message(body), status: 'open', targets }
                    tr.insert(threadPosition(tr.doc), state.schema.nodes.commentThread.create({ label, source: formatThread(thread, label) }))
                    tr.setMeta(commentsKey, { draft: null, active: label } satisfies CommentsMeta)
                    dispatch(tr)
                    return true
                },
            replyToComment: (id, body, to = []) =>
                change(id, (t) => (body.trim() ? updateMessage(t, to, (m) => ({ ...m, replies: [...m.replies, message(body)] })) : t)),
            editComment: (id, body, at = []) => change(id, (t) => updateMessage(t, at, (m) => ({ ...m, body: body.trim() }))),
            deleteComment: (id, at = []) => change(id, (t) => (at.length ? updateMessage(t, at, () => null) : null)),
            resolveComment: (id) => change(id, (t) => ({ ...t, status: 'resolved' })),
            reopenComment: (id) => change(id, (t) => ({ ...t, status: 'open' })),
            reactToComment: (id, emoji, to = []) =>
                change(id, (t) =>
                    updateMessage(t, to, (m) => {
                        const mine = m.replies.findIndex((r) => r.author === author() && r.body.trim() === emoji && !r.replies.length)
                        return mine >= 0
                            ? { ...m, replies: m.replies.filter((_, i) => i !== mine) }
                            : { ...m, replies: [...m.replies, message(emoji)] }
                    }),
                ),
            pinComment:
                (id) =>
                ({ state, tr, dispatch }) => {
                    const info = threadsOf(state).find((t) => t.id === id)
                    if (!author() || !info || info.pos === null) return false
                    const node = tr.doc.nodeAt(info.pos)
                    if (!node) return false
                    if (!dispatch) return true
                    const taken = pinIds(tr.doc)
                    const targets = info.thread.targets.map((link, i) => {
                        const at = info.targets[i]
                        if (!at?.range || !link.fragment?.startsWith(':~:text=')) return link
                        const pin = freshPinId(node.attrs.label, taken)
                        tr.addMark(at.range.from, at.range.to, state.schema.marks.span.create({ id: pin }))
                        return { ...link, fragment: pin }
                    })
                    tr.setNodeMarkup(info.pos, undefined, { ...node.attrs, source: formatThread({ ...info.thread, targets }, node.attrs.label) })
                    dispatch(tr)
                    return true
                },
            anchorComment:
                (id, target, range) =>
                ({ state, tr, dispatch }) => {
                    const info = threadsOf(state).find((t) => t.id === id)
                    const chosen = range ?? (state.selection.empty ? null : { from: state.selection.from, to: state.selection.to })
                    if (!author() || !info || info.pos === null || !chosen || !info.thread.targets[target]) return false
                    const node = tr.doc.nodeAt(info.pos)
                    if (!node) return false
                    if (!dispatch) return true
                    const link = anchorFor(tr, chosen, node.attrs.label, docText(tr.doc), pinIds(tr.doc))
                    const targets = info.thread.targets.map((l, i) => (i === target ? link : l))
                    tr.setNodeMarkup(info.pos, undefined, { ...node.attrs, source: formatThread({ ...info.thread, targets }, node.attrs.label) })
                    tr.setMeta(commentsKey, { active: id } satisfies CommentsMeta)
                    return true
                },
            focusComment:
                (id) =>
                ({ tr, dispatch }) => {
                    dispatch?.(tr.setMeta(commentsKey, { active: id } satisfies CommentsMeta))
                    return true
                },
        }
    },

    addKeyboardShortcuts() {
        // Google Docs' and Word's shortcut for a new comment.
        return { 'Mod-Alt-m': () => this.editor.commands.startComment() }
    },

    addProseMirrorPlugins() {
        const editor = this.editor
        const options = this.options
        const storage = this.storage
        const cache = new Map<string, Parsed>()
        const parse = (source: string): Parsed => {
            if (!cache.has(source)) {
                if (cache.size > 500) cache.clear()
                cache.set(source, parseThreadDefinition(source))
            }
            return cache.get(source)!
        }

        return [
            new Plugin<CommentsState>({
                key: commentsKey,
                state: {
                    init: (_, state) => {
                        const threads = collect(state.doc, [], parse)
                        return { threads, external: [], active: null, draft: null, decorations: decorate(state.doc, threads, null, null) }
                    },
                    apply(tr, value, _old, state) {
                        const meta = tr.getMeta(commentsKey) as CommentsMeta | undefined
                        // Unchanged (a selection moved): the same value, which is
                        // how the margin knows there is nothing to draw.
                        if (!meta && !tr.docChanged) return value
                        const external = meta?.external ?? value.external
                        let draft = value.draft
                        if (draft && tr.docChanged) {
                            draft = { ranges: draft.ranges.map((r) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) })) }
                        }
                        if (meta && 'draft' in meta) draft = meta.draft ?? null
                        const recompute = tr.docChanged || !!meta?.external
                        const threads = recompute ? collect(state.doc, external, parse) : value.threads
                        let active = meta && 'active' in meta ? meta.active ?? null : value.active
                        if (active && !threads.some((t) => t.id === active)) active = null
                        const decorations =
                            recompute || meta ? decorate(state.doc, threads, active, draft) : value.decorations.map(tr.mapping, tr.doc)
                        return { threads, external, active, draft, decorations }
                    },
                },
                props: {
                    decorations: (state) => commentsKey.getState(state)?.decorations,
                    // A click on commented text looks at its thread (the caret
                    // still goes where it was clicked).
                    handleClick(view, pos) {
                        const state = commentsKey.getState(view.state)
                        const hit = state?.threads.find(
                            (t) => (t.thread.status === 'open' || t.id === state.active) && t.targets.some((x) => x.range && x.range.from <= pos && pos <= x.range.to),
                        )
                        if ((hit?.id ?? null) !== state?.active) view.dispatch(view.state.tr.setMeta(commentsKey, { active: hit?.id ?? null } satisfies CommentsMeta))
                        return false
                    },
                },
                appendTransaction(trs, oldState, newState) {
                    if (!trs.some((tr) => tr.docChanged) || trs.some((tr) => (tr.getMeta(commentsKey) as CommentsMeta | undefined)?.reanchored)) return null
                    const before = commentsKey.getState(oldState)?.threads ?? []
                    const after = commentsKey.getState(newState)?.threads ?? []
                    let flat: DocText | null = null
                    const text = () => (flat ??= docText(newState.doc))
                    let taken: Set<string> | null = null
                    const tr = newState.tr
                    let changed = false
                    for (const now of after) {
                        if (now.pos === null) continue
                        const node = newState.doc.nodeAt(now.pos)
                        if (!node) continue
                        const was = before.find((t) => t.id === now.id)
                        let targets = now.thread.targets
                        now.targets.forEach((target, i) => {
                            if (target.elsewhere || !target.link.fragment?.startsWith(':~:text=')) return
                            let range: Range | null = null
                            const old = was?.targets[i]
                            if (old?.range && !old.approximate) {
                                // Edited here: where its text went.
                                let from = old.range.from
                                let to = old.range.to
                                for (const t of trs) {
                                    from = t.mapping.map(from, 1)
                                    to = t.mapping.map(to, -1)
                                }
                                const same = target.range && target.range.from === from && target.range.to === to && !target.approximate
                                if (to > from && !same) range = { from, to }
                            } else if (target.range && target.approximate) {
                                // Edited elsewhere: where it was found.
                                range = target.range
                            }
                            if (!range) return
                            const link = anchorFor(tr, range, node.attrs.label, text(), (taken ??= pinIds(newState.doc)))
                            if (link.fragment === target.link.fragment) return
                            targets = targets.map((l, k) => (k === i ? { ...l, fragment: link.fragment } : l))
                        })
                        if (targets !== now.thread.targets) {
                            tr.setNodeMarkup(now.pos, undefined, { ...node.attrs, source: formatThread({ ...now.thread, targets }, node.attrs.label) })
                            changed = true
                        }
                    }
                    if (!changed) return null
                    tr.setMeta(commentsKey, { reanchored: true } satisfies CommentsMeta)
                    if (trs.some((t) => t.getMeta('addToHistory') === false)) tr.setMeta('addToHistory', false)
                    return tr
                },
                view(view: EditorView) {
                    // Threads written elsewhere: read when a note is loaded and
                    // whenever the index changes; their text fragments are
                    // rewritten there when this note is saved.
                    let token = 0
                    let destroyed = false
                    const read = async () => {
                        const path = openPath(editor)
                        const ix = options.index
                        const mine = ++token
                        const refs = ix && path ? await ix.threadsAbout(path).catch(() => [] as CommentRef[]) : []
                        if (mine !== token || destroyed) return
                        const current = commentsKey.getState(view.state)?.external ?? []
                        if (!refs.length && !current.length) return
                        view.dispatch(view.state.tr.setMeta(commentsKey, { external: refs } satisfies CommentsMeta).setMeta('addToHistory', false))
                    }
                    const reanchorElsewhere = async () => {
                        const ix = options.index
                        if (!ix || !options.author) return
                        const state = commentsKey.getState(view.state)
                        const flat = docText(view.state.doc)
                        for (const t of state?.threads ?? []) {
                            if (!t.ref) continue
                            let targets = t.thread.targets
                            t.targets.forEach((target, i) => {
                                if (!target.range || !target.approximate || !target.link.fragment?.startsWith(':~:text=')) return
                                const f = textFragmentFor(flat.text, textOffset(flat, target.range.from), textOffset(flat, target.range.to))
                                if (f) targets = targets.map((l, k) => (k === i ? { ...l, fragment: formatTextFragment(f) } : l))
                            })
                            if (targets !== t.thread.targets) await ix.update(t.ref, { ...t.thread, targets }).catch(() => null)
                        }
                    }
                    storage.refresh = read
                    const persistence = (editor.storage as any).persistence as FileSystemStorage | undefined
                    const offFile = persistence?.subscribe?.((event) => {
                        if (event.type === 'load') void read()
                        if (event.type === 'save') void reanchorElsewhere()
                    })
                    const offIndex = options.index?.subscribe?.(() => void read())
                    void read()
                    return {
                        destroy() {
                            destroyed = true
                            offFile?.()
                            offIndex?.()
                        },
                    }
                },
            }),
        ]
    },
})
