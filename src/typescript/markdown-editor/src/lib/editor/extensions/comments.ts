/**
 * Comments (comments RFC): every comment is a document. A note may hold
 * reference blocks, an embed of a range of another document with text
 * under it (`![[Plan#:~:text=ship%20it]]` and then the commentary); each is
 * a comment on that range. A reply is a document referencing a range of a
 * comment's text; a thread is what the index gathers by following
 * references. Reactions (and resolution, a ✅) are per-identity state the
 * host keeps (`Reactions`), never documents.
 *
 * This extension finds, for the open note, every comment about it
 * (`CommentIndex.about`), where each one's target is in the note (a text
 * fragment, a pin, a block id or a heading), the replies under each and
 * their reactions; highlights the targets; keeps a comment's link pointing
 * at its text as the note is edited here (rewritten where the comment lives
 * when the note is saved); and has the commands. Creating a comment makes a
 * document, `comments/<note>/<author> <time>.md`, whose first line is the
 * reference and whose body is the comment; "open" loads that document in
 * the editor, which is where a longer comment is written.
 */
import { Extension, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { Mapping } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
    basename,
    dirname,
    findTextFragment,
    formatReference,
    formatTextFragment,
    formatWikilink,
    joinPath,
    normalizePath,
    parseTextFragment,
    textFragmentFor,
    type CommentIndex,
    type CommentRef,
    type FileOperations,
    type Reaction,
    type Reactions,
    type VfsInterface,
    type Wikilink,
} from '@joinezco/storage'
import { docText, findBlockId, findFragment, findPin, locateTextFragment, textOffset, type DocText } from './fragment'
import { documentId } from './front-matter'
import { loadedDocumentMeta, type FileSystemStorage } from './filesystem'

// ── What the plugin knows ───────────────────────────────────────────────────

export interface Range {
    from: number
    to: number
}

export interface CommentTarget {
    link: Wikilink
    /** Where it is in this note; null for the whole note or one not found. */
    range: Range | null
    /** Found only approximately: its text changed outside the editor. */
    approximate: boolean
    /** Names a place in this note that is not there. */
    orphaned: boolean
}

/** A comment: a reference in a document, with what answers it. */
export interface CommentInfo {
    /** The document and line the reference is at. */
    id: string
    ref: CommentRef
    /** Who wrote it and when, as the document's name says (`theo 2026-09-26
     *  14.02.md`); the document's name otherwise. */
    author: string
    time: string
    body: string
    target: CommentTarget
    /** Documents referencing this comment's text (or its document). */
    replies: CommentInfo[]
    /** Every identity's reactions to it; a ✅ resolves it. */
    reactions: Reaction[]
    resolved: boolean
    /** Where it sits in the note (its target found here), or null. */
    anchor: number | null
}

interface CommentsState {
    comments: CommentInfo[]
    active: string | null
    /** Text chosen for a comment not yet written. */
    draft: { ranges: Range[] } | null
    decorations: DecorationSet
}

interface CommentsMeta {
    /** What the index found (a read). */
    found?: CommentInfo[]
    active?: string | null
    draft?: { ranges: Range[] } | null
}

export const commentsKey = new PluginKey<CommentsState>('comments')

/** The mark of a resolved comment: a ✅ reaction from anyone. */
export const RESOLVED = '✅'
/** What a deleted comment's body says when replies keep it in place. */
export const DELETED_BODY = '[deleted]'
/** Where a note's comments go: `comments/<note>/`. */
const COMMENTS_DIR = 'comments'

/** The document name a comment is given: who and when. */
export function commentFileName(author: string, now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${author} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.md`
}

/** Who and when, read back from a comment document's name. */
export function authorOf(path: string): { author: string; time: string } {
    const stem = basename(path).replace(/\.md$/i, '')
    const m = /^(\S+) (\d{4}-\d{2}-\d{2}) (\d{2})\.(\d{2})$/.exec(stem)
    return m ? { author: m[1], time: `${m[2]}T${m[3]}:${m[4]}` } : { author: stem, time: '' }
}

/** The folder a comment on `doc` goes in: the note's, or the folder the
 *  commented document already sits in when it is itself a comment. */
export function commentsFolderFor(doc: string): string {
    const clean = normalizePath(doc)
    const dir = dirname(clean)
    if (dir === COMMENTS_DIR || dir.startsWith(`${COMMENTS_DIR}/`)) return dir
    return joinPath(COMMENTS_DIR, basename(clean).replace(/\.md$/i, ''))
}

/** The link to `doc` (a vault path) as a wikilink target: the path without `.md`. */
export const linkTarget = (doc: string) => normalizePath(doc).replace(/\.md$/i, '')

/** A reaction's `ref` for a comment: its link as written, without brackets. */
export const refKey = (link: Wikilink) => formatWikilink({ ...link, alias: null }).slice(2, -2)

/**
 * Where a target is in this note. A text fragment is looked for as
 * written; when the note was read afresh (`approximate`), also where its
 * text nearly matches; while the note is edited here, where the quote was
 * is mapped through the edit instead (`mapped`), so a quote whose words
 * are being changed stays with them and is rewritten to what they are now.
 */
function locate(doc: PMNode, link: Wikilink, text: () => DocText, approximate: boolean, mapped: Range | null): CommentTarget {
    const target: CommentTarget = { link, range: null, approximate: false, orphaned: false }
    const fragment = link.fragment?.trim()
    if (!fragment) return target
    if (fragment.startsWith(':~:text=')) {
        const found = locateTextFragment(doc, fragment, undefined, text(), approximate)
        if (found) return { ...target, range: { from: found.from, to: found.to }, approximate: !found.exact }
        if (mapped && mapped.to > mapped.from) return { ...target, range: mapped, approximate: true }
        return { ...target, orphaned: true }
    }
    const range = fragment.startsWith('^') ? findBlockId(doc, fragment.slice(1)) : findPin(doc, fragment) ?? findFragment(doc, fragment)
    return range ? { ...target, range: { from: range.from, to: range.to } } : { ...target, orphaned: true }
}

/** The comments, their targets found in `doc`. */
function place(doc: PMNode, comments: CommentInfo[], approximate: boolean, previous?: { comments: CommentInfo[]; mapping: Mapping }): CommentInfo[] {
    let flat: DocText | null = null
    const text = () => (flat ??= docText(doc))
    const mapped = (id: string): Range | null => {
        const was = previous?.comments.find((c) => c.id === id)?.target.range
        if (!was || !previous) return null
        return { from: previous.mapping.map(was.from, 1), to: previous.mapping.map(was.to, -1) }
    }
    return comments.map((c) => {
        const target = locate(doc, c.ref.link, text, approximate, mapped(c.id))
        return { ...c, target, anchor: target.range?.from ?? null }
    })
}

function decorate(doc: PMNode, comments: CommentInfo[], active: string | null, draft: CommentsState['draft']): DecorationSet {
    const decorations: Decoration[] = []
    for (const c of comments) {
        if (!c.target.range || c.target.range.to <= c.target.range.from) continue
        const classes = ['ezco-mde-comment']
        if (c.id === active) classes.push('is-active')
        if (c.resolved) classes.push('is-resolved')
        decorations.push(Decoration.inline(c.target.range.from, c.target.range.to, { class: classes.join(' ') }))
    }
    for (const r of draft?.ranges ?? []) {
        if (r.to > r.from) decorations.push(Decoration.inline(r.from, r.to, { class: 'ezco-mde-comment is-draft' }))
    }
    return DecorationSet.create(doc, decorations)
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

/** A pin id: `c-` and the time, then `-2`, `-3`… */
function freshPinId(taken: Set<string>): string {
    const base = `c-${Date.now().toString(36)}`
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    return id
}

/** A target for the text `range` holds: a text fragment unique in the note,
 *  or (when none can be) a pin put around it. */
function anchorFor(tr: Transaction, range: Range, note: string, flat: DocText, taken: Set<string>): Wikilink {
    const f = textFragmentFor(flat.text, textOffset(flat, range.from), textOffset(flat, range.to))
    if (f) return { target: note, fragment: formatTextFragment(f), alias: null }
    const id = freshPinId(taken)
    tr.addMark(range.from, range.to, tr.doc.type.schema.marks.span.create({ id }))
    return { target: note, fragment: id, alias: null }
}

function openPath(editor: Editor): string | null {
    const path = ((editor.storage as any).persistence as FileSystemStorage | undefined)?.options?.filepath
    return path ? normalizePath(path) : null
}

/** The comment at `id`, wherever it is in the tree. */
export function commentAt(comments: CommentInfo[], id: string): CommentInfo | null {
    for (const c of comments) {
        if (c.id === id) return c
        const inner = commentAt(c.replies, id)
        if (inner) return inner
    }
    return null
}

// ── Reading: comments about a document, threaded ────────────────────────────

/** The text of a comment document, read once per gathering. */
type Texts = Map<string, Promise<string | null>>

/**
 * The comments about `doc`: every reference to it, each with the replies
 * that reference its text (or its document) and its reactions, recursively,
 * a document never followed twice.
 */
async function gather(
    doc: string,
    index: CommentIndex,
    reactions: Reactions | undefined,
    fs: VfsInterface | undefined,
    texts: Texts,
    seen: Set<string>,
): Promise<CommentInfo[]> {
    const refs = await index.about(doc).catch(() => [] as CommentRef[])
    const out: CommentInfo[] = []
    for (const ref of refs) {
        const { author, time } = authorOf(ref.source)
        const id = `${ref.source}#${ref.line}`
        const on = reactions ? await reactions.on(ref.source).catch(() => [] as Reaction[]) : []
        const key = refKey(ref.link)
        const mine = on.filter((r) => r.to.ref === key)
        const replies = seen.has(ref.source) ? [] : await gather(ref.source, index, reactions, fs, texts, new Set([...seen, ref.source]))
        // A reply references this comment's text: keep the ones whose target
        // falls in it (or names the whole document, when this is its only
        // comment).
        const siblings = await index.in(ref.source).catch(() => [] as CommentRef[])
        const text = fs ? await (texts.get(ref.source) ?? texts.set(ref.source, fs.readFile(ref.source).catch(() => null)).get(ref.source)!) : null
        const own = replies.filter((r) => {
            const f = r.ref.link.fragment?.trim()
            if (!f) return siblings.length <= 1 || siblings[0].line === ref.line
            if (!f.startsWith(':~:text=') || text === null) return true
            const parsed = parseTextFragment(f)
            const found = parsed ? findTextFragment(text, parsed) : null
            return !found || (found.from >= ref.start && found.to <= ref.end + 1)
        })
        out.push({
            id,
            ref,
            author,
            time,
            body: ref.body,
            target: { link: ref.link, range: null, approximate: false, orphaned: false },
            replies: own,
            reactions: mine,
            resolved: mine.some((r) => r.emoji === RESOLVED),
            anchor: null,
        })
    }
    return out
}

// ── Export ──────────────────────────────────────────────────────────────────

/** A W3C Web Annotation (https://www.w3.org/TR/annotation-model/). */
export type WebAnnotation = Record<string, unknown>

function annotationsOf(editor: Editor, comments: CommentInfo[]): WebAnnotation[] {
    const flat = docText(editor.state.doc)
    const noteId = documentId(editor)
    const source = noteId ? `urn:ezco:note:${noteId}` : openPath(editor) ?? 'urn:ezco:note'
    const quote = (from: number, to: number) => {
        const start = textOffset(flat, from)
        const end = textOffset(flat, to)
        return {
            source,
            selector: [
                { type: 'TextQuoteSelector', exact: flat.text.slice(start, end), prefix: flat.text.slice(Math.max(0, start - 32), start), suffix: flat.text.slice(end, end + 32) },
                { type: 'TextPositionSelector', start, end },
            ],
        }
    }
    const out: WebAnnotation[] = []
    const base = (c: CommentInfo) => ({
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        id: `urn:ezco:comment:${c.ref.source}#${c.ref.line}`,
        type: 'Annotation',
        creator: { type: 'Person', nickname: c.author },
        ...(c.time ? { created: `${c.time}:00Z` } : {}),
        body: { type: 'TextualBody', value: c.body, format: 'text/markdown' },
    })
    const walk = (c: CommentInfo, parent: string | null) => {
        const id = `urn:ezco:comment:${c.ref.source}#${c.ref.line}`
        out.push({ ...base(c), motivation: parent ? 'replying' : 'commenting', target: parent ?? (c.target.range ? quote(c.target.range.from, c.target.range.to) : source) })
        for (const r of c.replies) walk(r, id)
    }
    for (const c of comments) walk(c, null)
    return out
}

// ── The extension ───────────────────────────────────────────────────────────

export interface CommentsOptions {
    /** The handle comments are written as. Without one they are shown, not written. */
    author?: string
    /** Comments about the note, wherever they live (a vault's `comments`). */
    index?: CommentIndex
    /** Reactions and resolution, per identity (a vault's `reactions`). */
    reactions?: Reactions
}

export interface CommentsStorage {
    /** Every comment about the open note, threaded. */
    comments: () => CommentInfo[]
    active: () => string | null
    draft: () => { ranges: Range[] } | null
    focus: (id: string | null) => void
    exportAnnotations: () => WebAnnotation[]
    /** Read the comments again. */
    refresh: () => Promise<void>
    /** Who is writing (null: nobody; comments are read-only). */
    author: () => string | null
    /** Whether reactions can be made. */
    canReact: () => boolean
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        comments: {
            /** Choose the selection for a comment (the margin opens a draft). */
            startComment: () => ReturnType
            cancelComment: () => ReturnType
            /** A new comment document about `ranges` (the selection when none
             *  are given; none, and no selection, is a comment on the note),
             *  with `body`; `open` loads it in the editor. */
            addComment: (options: { body: string; ranges?: Range[]; open?: boolean }) => ReturnType
            /** A new document answering comment `id` (its text is what the
             *  reply references); `open` loads it in the editor. */
            replyToComment: (id: string, body: string, options?: { open?: boolean }) => ReturnType
            editComment: (id: string, body: string) => ReturnType
            /** Delete a comment. One others have answered stays as a
             *  tombstone so the replies keep their place. */
            deleteComment: (id: string) => ReturnType
            /** Resolve (a ✅ reaction) or reopen (take one's ✅ away). */
            resolveComment: (id: string) => ReturnType
            reopenComment: (id: string) => ReturnType
            /** Add the identity's `emoji` to a comment, or take it away. */
            reactToComment: (id: string, emoji: string) => ReturnType
            /** Load the comment's document in the editor, at the comment. */
            openComment: (id: string) => ReturnType
            /** Point comment `id` at `range` (the selection by default): how
             *  an orphaned one is anchored again. */
            anchorComment: (id: string, range?: Range) => ReturnType
            focusComment: (id: string | null) => ReturnType
        }
    }
}

export const Comments = Extension.create<CommentsOptions, CommentsStorage>({
    name: 'comments',

    addOptions() {
        return { author: undefined, index: undefined, reactions: undefined }
    },

    addStorage() {
        return {
            comments: () => [],
            active: () => null,
            draft: () => null,
            focus: () => {},
            exportAnnotations: () => [],
            refresh: async () => {},
            author: () => null,
            canReact: () => false,
        }
    },

    onBeforeCreate() {
        const editor = this.editor
        const state = () => commentsKey.getState(editor.state)
        this.storage.comments = () => state()?.comments ?? []
        this.storage.active = () => state()?.active ?? null
        this.storage.draft = () => state()?.draft ?? null
        this.storage.focus = (id) => {
            editor.commands.focusComment(id)
        }
        this.storage.exportAnnotations = () => annotationsOf(editor, state()?.comments ?? [])
        this.storage.author = () => this.options.author ?? null
        this.storage.canReact = () => !!this.options.reactions?.identity
    },

    addCommands() {
        const editor = this.editor
        const author = () => this.options.author ?? null
        const index = () => this.options.index
        const reactions = () => this.options.reactions
        const refresh = () => this.storage.refresh()
        const persistence = () => (editor.storage as any).persistence as FileSystemStorage | undefined
        const files = (): FileOperations | undefined => {
            const codeblock = editor.extensionManager.extensions.find((e) => e.name === 'ezcodeBlock')
            return (codeblock?.options as { files?: FileOperations } | undefined)?.files
        }
        const find = (state: EditorState, id: string) => commentAt(commentsKey.getState(state)?.comments ?? [], id)

        /** A document at `folder` named for the author now, holding `link` and `body`. */
        const write = async (folder: string, link: Wikilink, body: string, open: boolean) => {
            const ops = files()
            const fs = persistence()?.options.fs
            if (!ops || !fs) throw new Error('Comments need the vault\'s files')
            let path = joinPath(folder, commentFileName(author()!))
            for (let n = 2; await fs.exists(path); n++) path = path.replace(/\.md$/, ` ${n}.md`)
            await ops.create(path, formatReference(link, body) + '\n')
            await refresh()
            if (open) await persistence()?.loadFile(path, { focus: true })
            return path
        }

        /** Change a comment where it lives (null deletes it). */
        const change =
            (id: string, next: (c: CommentInfo) => { link: Wikilink; body: string } | null) =>
            ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) => {
                const ix = index()
                const c = find(state, id)
                if (!author() || !ix || !c) return false
                if (dispatch) {
                    void ix.update(c.ref, next(c)).then(refresh, (error) => {
                        console.error('The comment could not be changed where it lives', error)
                        return refresh()
                    })
                }
                return true
            }

        const react = (id: string, emoji: string) => ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) => {
            const rx = reactions()
            const c = find(state, id)
            if (!rx?.identity || !c) return false
            if (dispatch) void rx.toggle({ doc: c.ref.source, ref: refKey(c.ref.link) }, emoji).then(refresh, (error) => console.error('The reaction could not be made', error))
            return true
        }

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
                ({ body, ranges, open }) =>
                ({ state, tr, dispatch }) => {
                    const note = openPath(editor)
                    if (!author() || !note || (!body.trim() && !open)) return false
                    const chosen = (ranges ?? (state.selection.empty ? [] : [{ from: state.selection.from, to: state.selection.to }])).filter((r) => r.to > r.from)
                    if (!dispatch) return true
                    const flat = docText(tr.doc)
                    const link = chosen.length ? anchorFor(tr, chosen[0], linkTarget(note), flat, pinIds(tr.doc)) : { target: linkTarget(note), fragment: null, alias: null }
                    tr.setMeta(commentsKey, { draft: null } satisfies CommentsMeta)
                    dispatch(tr)
                    // A pin was written into the note: it must be in the file
                    // before the comment's document refers to it.
                    void (async () => {
                        await persistence()?.save()
                        await write(commentsFolderFor(note), link, body.trim(), !!open)
                    })().catch((error) => console.error('The comment could not be written', error))
                    return true
                },
            replyToComment:
                (id, body, options = {}) =>
                ({ state, dispatch }) => {
                    const c = find(state, id)
                    const fs = persistence()?.options.fs
                    if (!author() || !c || !fs || (!body.trim() && !options.open)) return false
                    if (!dispatch) return true
                    void (async () => {
                        // The reply references the comment's text in its document.
                        const text = await fs.readFile(c.ref.source)
                        const refs = c.ref
                        const bodyStart = text.indexOf(refs.body, refs.start)
                        const f = refs.body && bodyStart >= 0 ? textFragmentFor(text, bodyStart, bodyStart + refs.body.length) : null
                        const link: Wikilink = { target: linkTarget(c.ref.source), fragment: f ? formatTextFragment(f) : null, alias: null }
                        await write(commentsFolderFor(c.ref.source), link, body.trim(), !!options.open)
                    })().catch((error) => console.error('The reply could not be written', error))
                    return true
                },
            editComment: (id, body) => change(id, (c) => ({ link: c.ref.link, body: body.trim() })),
            deleteComment: (id) => change(id, (c) => (c.replies.length ? { link: c.ref.link, body: DELETED_BODY } : null)),
            resolveComment: (id) => react(id, RESOLVED),
            reopenComment: (id) => react(id, RESOLVED),
            reactToComment: (id, emoji) => react(id, emoji),
            openComment:
                (id) =>
                ({ state, dispatch }) => {
                    const c = find(state, id)
                    if (!c) return false
                    if (dispatch) void persistence()?.loadFile(c.ref.source, { focus: true })
                    return true
                },
            anchorComment:
                (id, range) =>
                ({ state, tr, dispatch }) => {
                    const note = openPath(editor)
                    const c = find(state, id)
                    const chosen = range ?? (state.selection.empty ? null : { from: state.selection.from, to: state.selection.to })
                    if (!author() || !note || !c || !chosen) return false
                    if (!dispatch) return true
                    const link = anchorFor(tr, chosen, linkTarget(note), docText(tr.doc), pinIds(tr.doc))
                    tr.setMeta(commentsKey, { active: id } satisfies CommentsMeta)
                    dispatch(tr)
                    void (async () => {
                        await persistence()?.save()
                        await index()?.update(c.ref, { link, body: c.ref.body })
                        await refresh()
                    })().catch((error) => console.error('The comment could not be anchored', error))
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

        return [
            new Plugin<CommentsState>({
                key: commentsKey,
                state: {
                    init: (_, state) => ({ comments: [], active: null, draft: null, decorations: DecorationSet.create(state.doc, []) }),
                    apply(tr, value, _old, state) {
                        const meta = tr.getMeta(commentsKey) as CommentsMeta | undefined
                        // Unchanged (a selection moved): the same value, which is
                        // how the margin knows there is nothing to draw.
                        if (!meta && !tr.docChanged) return value
                        let draft = value.draft
                        if (draft && tr.docChanged) {
                            draft = { ranges: draft.ranges.map((r) => ({ from: tr.mapping.map(r.from, 1), to: tr.mapping.map(r.to, -1) })) }
                        }
                        if (meta && 'draft' in meta) draft = meta.draft ?? null
                        // Read afresh (from the index, or the file loaded): a
                        // quote is found where it nearly is. Edited here: where
                        // it is exactly, else where it was.
                        const read = !!meta?.found || !!tr.getMeta(loadedDocumentMeta)
                        const comments = meta?.found
                            ? place(state.doc, meta.found, true)
                            : tr.docChanged
                              ? place(state.doc, value.comments, read, read ? undefined : { comments: value.comments, mapping: tr.mapping })
                              : value.comments
                        let active = meta && 'active' in meta ? meta.active ?? null : value.active
                        if (active && !commentAt(comments, active)) active = null
                        return { comments, active, draft, decorations: decorate(state.doc, comments, active, draft) }
                    },
                },
                props: {
                    decorations: (state) => commentsKey.getState(state)?.decorations,
                    // A click on commented text looks at its comment (the caret
                    // still goes where it was clicked).
                    handleClick(view, pos) {
                        const state = commentsKey.getState(view.state)
                        const hit = state?.comments.find((c) => c.target.range && c.target.range.from <= pos && pos <= c.target.range.to)
                        if ((hit?.id ?? null) !== state?.active) view.dispatch(view.state.tr.setMeta(commentsKey, { active: hit?.id ?? null } satisfies CommentsMeta))
                        return false
                    },
                },
                view(view: EditorView) {
                    let token = 0
                    let destroyed = false
                    const read = async () => {
                        const path = openPath(editor)
                        const ix = options.index
                        const mine = ++token
                        const fs = ((editor.storage as any).persistence as FileSystemStorage | undefined)?.options?.fs
                        const found = ix && path ? await gather(path, ix, options.reactions, fs, new Map(), new Set([path])) : []
                        if (mine !== token || destroyed) return
                        const current = commentsKey.getState(view.state)?.comments ?? []
                        if (!found.length && !current.length) return
                        view.dispatch(view.state.tr.setMeta(commentsKey, { found } satisfies CommentsMeta).setMeta('addToHistory', false))
                    }
                    // A comment whose text was changed here is pointed at what
                    // the text is now, where the comment lives, when the note
                    // is saved (its file is then what the fragment is made of).
                    const reanchor = async () => {
                        const ix = options.index
                        const note = openPath(editor)
                        if (!ix || !options.author || !note) return
                        const state = commentsKey.getState(view.state)
                        const flat = docText(view.state.doc)
                        for (const c of state?.comments ?? []) {
                            const t = c.target
                            if (!t.range || !t.approximate || !t.link.fragment?.startsWith(':~:text=')) continue
                            const f = textFragmentFor(flat.text, textOffset(flat, t.range.from), textOffset(flat, t.range.to))
                            if (!f) continue
                            await ix.update(c.ref, { link: { ...c.ref.link, fragment: formatTextFragment(f) }, body: c.ref.body }).catch(() => null)
                        }
                    }
                    storage.refresh = read
                    const persistence = (editor.storage as any).persistence as FileSystemStorage | undefined
                    const offFile = persistence?.subscribe?.((event) => {
                        if (event.type === 'load') void read()
                        if (event.type === 'save') void reanchor().then(read)
                    })
                    const offIndex = options.index?.subscribe?.(() => void read())
                    const offReactions = options.reactions?.subscribe?.(() => void read())
                    void read()
                    return {
                        destroy() {
                            destroyed = true
                            offFile?.()
                            offIndex?.()
                            offReactions?.()
                        },
                    }
                },
            }),
        ]
    },
})
