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
 * reference and whose body is the comment; "open" puts that document in a
 * sheet beside the note (`comment-sheet.ts`), where a longer comment is
 * written and other passages of the note are quoted into it, or loads it
 * in the editor itself. What is typed and not yet posted is a draft, kept
 * in this browser on its own.
 */
import { Extension, type Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type EditorState, type Selection, type Transaction } from '@tiptap/pm/state'
import type { Mapping } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { basename, dirname, joinPath, normalizePath, type FileOperations, type VfsInterface } from '@joinezco/storage'
import { findTextFragment, formatReference, formatTextFragment, parseTextFragment, referenceKey, referencesIn, textFragmentFor, type CommentIndex, type CommentRef, type Reaction, type Reactions, type Wikilink } from '@joinezco/vault'
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
    /** The whole of this note: no fragment, or a quote of all its text (a
     *  reply quotes the whole of the comment it answers). Nothing to
     *  highlight; its card sits at the top. */
    whole: boolean
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

/** Who and when, read back from a comment document's name (`theo
 *  2026-09-26 14.02.md`, or `… 14.02 2.md` for another in the same minute). */
export function authorOf(path: string): { author: string; time: string } {
    const stem = basename(path).replace(/\.md$/i, '')
    const m = /^(\S+) (\d{4}-\d{2}-\d{2}) (\d{2})\.(\d{2})(?: \d+)?$/.exec(stem)
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
export const refKey = referenceKey

/**
 * Where a target is in this note. A text fragment is looked for as
 * written; when the note was read afresh (`approximate`), also where its
 * text nearly matches; while the note is edited here, where the quote was
 * is mapped through the edit instead (`mapped`), so a quote whose words
 * are being changed stays with them and is rewritten to what they are now.
 */
function locate(doc: PMNode, link: Wikilink, text: () => DocText, approximate: boolean, mapped: Range | null): CommentTarget {
    const target: CommentTarget = { link, range: null, approximate: false, orphaned: false, whole: false }
    const fragment = link.fragment?.trim()
    if (!fragment) return { ...target, whole: true }
    const at = (range: Range, approximate: boolean): CommentTarget => ({ ...target, range, approximate, whole: coversAll(doc, range) })
    if (fragment.startsWith(':~:text=')) {
        const found = locateTextFragment(doc, fragment, undefined, text(), approximate)
        if (found) return at({ from: found.from, to: found.to }, !found.exact)
        if (mapped && mapped.to > mapped.from) return at(mapped, true)
        return { ...target, orphaned: true }
    }
    const range = fragment.startsWith('^') ? findBlockId(doc, fragment.slice(1)) : findPin(doc, fragment) ?? findFragment(doc, fragment)
    return range ? at({ from: range.from, to: range.to }, false) : { ...target, orphaned: true }
}

/** Whether `range` holds all of the note's text: no words outside it
 *  (blank space, and what is not text, such as the reference a comment's
 *  document opens with, aside). */
function coversAll(doc: PMNode, range: Range): boolean {
    let all = true
    doc.descendants((node, pos) => {
        if (!all) return false
        if (!node.isText || !node.text) return true
        const before = node.text.slice(0, Math.max(0, Math.min(node.text.length, range.from - pos)))
        const after = node.text.slice(Math.max(0, Math.min(node.text.length, range.to - pos)))
        if (before.trim() || after.trim()) all = false
        return true
    })
    return all
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
    const ranges: Range[] = []
    for (const c of comments) {
        const r = c.target.range
        if (!r || r.to <= r.from || c.target.whole) continue
        const classes = ['ezco-mde-comment']
        if (c.id === active) classes.push('is-active')
        if (c.resolved) classes.push('is-resolved')
        decorations.push(Decoration.inline(r.from, r.to, { class: classes.join(' ') }))
        ranges.push(r)
    }
    // Where two comments' text overlaps, the overlap is marked deeper, so
    // it can be told from one comment's; clicking it looks at each in turn.
    for (const [from, to] of overlaps(ranges)) decorations.push(Decoration.inline(from, to, { class: 'ezco-mde-comment-stack' }))
    for (const r of draft?.ranges ?? []) {
        if (r.to > r.from) decorations.push(Decoration.inline(r.from, r.to, { class: 'ezco-mde-comment is-draft' }))
    }
    return DecorationSet.create(doc, decorations)
}

/** The stretches covered by two or more of `ranges`. */
function overlaps(ranges: Range[]): [number, number][] {
    const edges = [...new Set(ranges.flatMap((r) => [r.from, r.to]))].sort((a, b) => a - b)
    const out: [number, number][] = []
    for (let i = 0; i + 1 < edges.length; i++) {
        const [a, b] = [edges[i], edges[i + 1]]
        if (ranges.filter((r) => r.from <= a && r.to >= b).length < 2) continue
        const last = out[out.length - 1]
        if (last && last[1] === a) last[1] = b
        else out.push([a, b])
    }
    return out
}

/** The comment whose text is exactly `selection`: what following a link to
 *  the comment selects. */
function exactly(comments: CommentInfo[], selection: Selection): CommentInfo | null {
    if (selection.empty || !(selection instanceof TextSelection)) return null
    return comments.find((c) => c.target.range && c.target.range.from === selection.from && c.target.range.to === selection.to) ?? null
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
            target: { link: ref.link, range: null, approximate: false, orphaned: false, whole: false },
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
            /** Choose the selection for a comment (the margin opens a composer
             *  by it); while a sheet is open, quote the selection into it. */
            startComment: () => ReturnType
            cancelComment: () => ReturnType
            /** A new comment document about `ranges` (the selection when none
             *  are given; none, and no selection, is a comment on the note),
             *  with `body`; `open` opens it to write in full: in the sheet
             *  (`true`), or as the note in the editor (`'note'`). */
            addComment: (options: { body: string; ranges?: Range[]; open?: boolean | 'note' }) => ReturnType
            /** A new document answering comment `id` (its text is what the
             *  reply references); `open` opens it as `addComment` does. */
            replyToComment: (id: string, body: string, options?: { open?: boolean | 'note' }) => ReturnType
            editComment: (id: string, body: string) => ReturnType
            /** Delete a comment. One others have answered stays as a
             *  tombstone so the replies keep their place. */
            deleteComment: (id: string) => ReturnType
            /** Resolve (a ✅ reaction) or reopen (take one's ✅ away). */
            resolveComment: (id: string) => ReturnType
            reopenComment: (id: string) => ReturnType
            /** Add the identity's `emoji` to a comment, or take it away. */
            reactToComment: (id: string, emoji: string) => ReturnType
            /** Open the comment's document in the sheet beside the note, to
             *  write in full (in the editor itself where there is no margin). */
            openComment: (id: string) => ReturnType
            /** Load the comment's document as the note in the editor. */
            openCommentAsNote: (id: string) => ReturnType
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

        /**
         * Load a comment's document to write in it: the caret at the end of
         * its text, in a paragraph put under the reference when there is
         * none yet (a document that is only its reference has nowhere to
         * type: the embed's paragraph must stay the embed alone for the line
         * to read as a reference). Neither the paragraph nor the caret is an
         * edit or a step undo takes back.
         */
        const openForWriting = async (path: string) => {
            const p = persistence()
            if (!p) return
            await p.loadFile(path, { focus: false })
            if (p.codeView || normalizePath(p.options.filepath ?? '') !== normalizePath(path)) return
            const { state, view } = editor
            const tr = state.tr
            const last = state.doc.lastChild
            const reference = !!last && last.isTextblock && last.childCount > 0 && last.content.content.every((n) => n.type.name === 'embed')
            if (!last || !last.isTextblock || reference) tr.insert(state.doc.content.size, state.schema.nodes.paragraph.create())
            tr.setSelection(TextSelection.atEnd(tr.doc)).setMeta('addToHistory', false).setMeta('preventUpdate', true).scrollIntoView()
            view.dispatch(tr)
            view.focus()
        }

        /** A document opened to be written before anything was: it goes
         *  again if the editor leaves it with nothing under its reference. */
        const discardIfLeftEmpty = (path: string, ops: FileOperations, fs: VfsInterface) => {
            const p = persistence()
            if (!p?.subscribe) return
            const off = p.subscribe((event) => {
                if (event.type !== 'close' && (event.type !== 'load' || normalizePath(event.path) === normalizePath(path))) return
                off()
                void fs
                    .readFile(path)
                    .then((text) => (referencesIn(text).length ? undefined : ops.remove(path)))
                    .catch(() => undefined)
            })
        }

        /** A document at `folder` named for the author now, holding `link` and `body`. */
        const writeDocument = async (folder: string, link: Wikilink, body: string) => {
            const ops = files()
            const fs = persistence()?.options.fs
            if (!ops || !fs) throw new Error('Comments need the vault\'s files')
            let path = joinPath(folder, commentFileName(author()!))
            for (let n = 2; await fs.exists(path); n++) path = path.replace(/\.md$/, ` ${n}.md`)
            await ops.create(path, formatReference(link, body) + '\n')
            return path
        }
        /** The margin, when there is one: it holds the sheet. */
        const margin = () => (editor.storage as any).commentMargin as { open?: (path: string) => void; sheet?: { quote(link: Wikilink): void } | null } | undefined
        /** Write the comment in full: in the sheet; without a margin, as the
         *  note in the editor (one left with nothing written goes again). */
        const openInFull = async (path: string, body: string) => {
            const m = margin()
            if (m?.open) return m.open(path)
            await openAsNote(path, body)
        }
        /** The document as the note in the editor; one left with nothing written goes again. */
        const openAsNote = async (path: string, body: string) => {
            await openForWriting(path)
            if (!body) {
                const ops = files()
                const fs = persistence()?.options.fs
                if (ops && fs) discardIfLeftEmpty(path, ops, fs)
            }
        }
        const write = async (folder: string, link: Wikilink, body: string, open: boolean | 'note') => {
            const path = await writeDocument(folder, link, body)
            await refresh()
            if (open === 'note') await openAsNote(path, body)
            else if (open) await openInFull(path, body)
            return path
        }

        /** The link a reply to `c` holds: the comment's text, in its document. */
        const replyLink = async (c: CommentInfo, fs: VfsInterface): Promise<Wikilink> => {
            const text = await fs.readFile(c.ref.source)
            const bodyStart = text.indexOf(c.ref.body, c.ref.start)
            const f = c.ref.body && bodyStart >= 0 ? textFragmentFor(text, bodyStart, bodyStart + c.ref.body.length) : null
            return { target: linkTarget(c.ref.source), fragment: f ? formatTextFragment(f) : null, alias: null }
        }

        /** Change a comment where it lives (null deletes it). */
        const change =
            (id: string, next: (c: CommentInfo) => { link: Wikilink; body: string } | null) =>
            ({ state, dispatch }: { state: EditorState; dispatch?: (tr: Transaction) => void }) => {
                const ix = index()
                const c = find(state, id)
                if (!author() || !c || !ix) return false
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
                    const sheet = margin()?.sheet
                    const note = openPath(editor)
                    if (sheet && note) {
                        // A comment is being written in full: the selection
                        // is quoted into it (a pin, if one is needed, saved
                        // with the note before the quote refers to it).
                        if (!dispatch) return true
                        const link = anchorFor(tr, { from, to }, linkTarget(note), docText(tr.doc), pinIds(tr.doc))
                        dispatch(tr)
                        void persistence()?.save()
                        sheet.quote(link)
                        return true
                    }
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
                        const link = await replyLink(c, fs)
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
                    if (dispatch) void openInFull(c.ref.source, c.body)
                    return true
                },
            openCommentAsNote:
                (id) =>
                ({ state, dispatch }) => {
                    const c = find(state, id)
                    if (!c) return false
                    if (dispatch) void openForWriting(c.ref.source)
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
                    apply(tr, value, old, state) {
                        const meta = tr.getMeta(commentsKey) as CommentsMeta | undefined
                        // Unchanged (a selection moved): the same value, which is
                        // how the margin knows there is nothing to draw. Unless
                        // the selection became exactly a comment's text, which is
                        // what following a link to the comment does: that looks
                        // at the comment.
                        if (!meta && !tr.docChanged) {
                            const hit = tr.selectionSet && !value.active && !tr.selection.eq(old.selection) ? exactly(value.comments, tr.selection) : null
                            return hit ? { ...value, active: hit.id, decorations: decorate(state.doc, value.comments, hit.id, value.draft) } : value
                        }
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
                        // Read with the comment's text already selected (its link
                        // followed before the index answered): look at it.
                        if (!active && meta?.found) active = exactly(comments, tr.selection)?.id ?? null
                        return { comments, active, draft, decorations: decorate(state.doc, comments, active, draft) }
                    },
                },
                props: {
                    decorations: (state) => commentsKey.getState(state)?.decorations,
                    // A click on commented text looks at its comment (the caret
                    // still goes where it was clicked).
                    handleClick(view, pos) {
                        const state = commentsKey.getState(view.state)
                        if (!state) return false
                        // Every comment on the clicked spot, the narrowest first;
                        // where one of them is looked at already, the next.
                        const size = (c: CommentInfo) => c.target.range!.to - c.target.range!.from
                        const hits = state.comments
                            .filter((c) => c.target.range && !c.target.whole && c.target.range.from <= pos && pos <= c.target.range.to)
                            .sort((a, b) => size(a) - size(b))
                        const at = hits.findIndex((c) => c.id === state.active)
                        const next = hits.length ? hits[(at + 1) % hits.length] : null
                        if ((next?.id ?? null) !== state.active) view.dispatch(view.state.tr.setMeta(commentsKey, { active: next?.id ?? null } satisfies CommentsMeta))
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
                        const gathered = ix && path ? await gather(path, ix, options.reactions, fs, new Map(), new Set([path])) : []
                        if (mine !== token || destroyed) return
                        const found = gathered
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
