import { describe, it, expect, afterEach } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import { Vault, memoryVfs, parseThreadDefinition, type Thread } from '@joinezco/storage'
import { createEditor, MarkdownEditor, type MarkdownEditorOptions } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'
import type { CommentsStorage } from './comments'

/**
 * Comments in a note (comments RFC): threads as footnotes, targets as links
 * to its text, found, highlighted, re-anchored and changed by commands.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const THREAD = [
    '[^c-01J9K]: @theo 2026-09-13T12:04Z · open · [[#:~:text=brown%20fox]] [[#c-01J9K]]',
    '    Are both of these the same animal? See [[Zoology]].',
    '    - @alice 2026-09-13T12:10Z: No, and the second one should be a cat.',
    '      - @theo 2026-09-13T12:12Z: 👍',
].join('\n')

const NOTE = ['# Animals', '', 'The quick brown fox jumps over the [lazy dog]{#c-01J9K}.', '', THREAD].join('\n')

function open(content: string, options: Partial<MarkdownEditorOptions> = {}) {
    const container = createTestContainer(`comments-${created.length}`)
    const editor = createEditor({ element: container, content, comments: { author: 'theo', margin: false }, ...options })
    created.push({ editor, container })
    return { editor, container, comments: (editor.storage as any).comments as CommentsStorage }
}

/** The document range of `text` (its nth occurrence). */
function rangeOf(editor: MarkdownEditor, text: string, nth = 0) {
    let found: { from: number; to: number } | null = null
    let seen = 0
    editor.state.doc.descendants((node, pos) => {
        if (found || !node.isText) return !found
        let at = node.text!.indexOf(text)
        while (at >= 0) {
            if (seen++ === nth) {
                found = { from: pos + at, to: pos + at + text.length }
                return false
            }
            at = node.text!.indexOf(text, at + 1)
        }
        return true
    })
    if (!found) throw new Error(`no “${text}”`)
    return found as { from: number; to: number }
}

const textAt = (editor: MarkdownEditor, r: { from: number; to: number } | null) => (r ? editor.state.doc.textBetween(r.from, r.to) : null)

/** The note's threads as the Markdown now has them. */
function threadsIn(editor: MarkdownEditor): Record<string, Thread> {
    const out: Record<string, Thread> = {}
    for (const block of getMarkdownContent(editor).split(/\n(?=\[\^)/)) {
        const parsed = parseThreadDefinition(block.trimEnd())
        if (parsed) out[parsed.label] = parsed.thread
    }
    return out
}

describe('A comment thread in a note', () => {
    it('round-trips byte for byte, hidden in the body, its pin a span', () => {
        const { editor, container } = open(NOTE + '\n\nA footnote.[^1]\n\n[^1]: An ordinary one.')
        expect(getMarkdownContent(editor)).toBe(NOTE + '\n\nA footnote.[^1]\n\n[^1]: An ordinary one.')
        const thread = container.querySelector('.ezco-mde-comment-thread') as HTMLElement
        expect(thread.hidden).toBe(true)
        expect(thread.getBoundingClientRect().height).toBe(0)
        // The pin is a span mark; ordinary footnotes still number from 1.
        expect(editor.state.doc.rangeHasMark(rangeOf(editor, 'lazy dog').from, rangeOf(editor, 'lazy dog').to, editor.schema.marks.span)).toBe(true)
        expect(container.querySelector('.ezco-mde-footnote-ref')?.textContent).toBe('1')
    })

    it('has its targets found and highlighted', () => {
        const { editor, container, comments } = open(NOTE)
        const [t] = comments.threads()
        expect(t.id).toBe('c-01J9K')
        expect(t.thread.replies[0].author).toBe('alice')
        expect(t.targets.map((x) => textAt(editor, x.range))).toEqual(['brown fox', 'lazy dog'])
        expect(t.orphaned).toBe(false)
        expect([...container.querySelectorAll('.ezco-mde-comment')].map((e) => e.textContent)).toEqual(['brown fox', 'lazy dog'])
    })
})

describe('Writing comments', () => {
    it('adds a thread on the selection, anchored by a text fragment, at the end of the note', () => {
        const { editor, comments } = open('# Plan\n\nWe ship it on Friday.\n\nMore text.')
        const r = rangeOf(editor, 'ship it')
        editor.commands.setTextSelection(r)
        expect(editor.commands.addComment({ body: 'Which Friday?' })).toBe(true)
        const [t] = comments.threads()
        expect(t.thread).toMatchObject({ author: 'theo', status: 'open', body: 'Which Friday?', targets: [{ target: '', fragment: ':~:text=ship%20it' }] })
        expect(comments.active()).toBe(t.id)
        const md = getMarkdownContent(editor)
        expect(md.startsWith('# Plan\n\nWe ship it on Friday.\n\nMore text.\n\n[^c-')).toBe(true)
        expect(md).toMatch(/\[\^c-[0-9A-Z]{16}\]: @theo \d{4}-\d\d-\d\dT\d\d:\d\dZ · open · \[\[#:~:text=ship%20it\]\]\n {4}Which Friday\?$/)
    })

    it('pins text that no quote can tell apart, and anchors several ranges to one thread', () => {
        const { editor, comments } = open('la la la la la la la la la la la la la la la la\n\nThe end is near.')
        const first = rangeOf(editor, 'la', 7)
        const second = rangeOf(editor, 'end')
        editor.commands.addComment({ body: 'Both.', ranges: [first, second] })
        const [t] = comments.threads()
        expect(t.thread.targets.map((l) => l.fragment)).toEqual([t.id, ':~:text=end'])
        expect(t.targets.map((x) => textAt(editor, x.range))).toEqual(['la', 'end'])
        expect(getMarkdownContent(editor)).toContain(`la la la la la la la [la]{#${t.id}} la`)
    })

    it('replies, reacts (a toggle), edits, resolves and reopens', () => {
        const { editor, comments } = open(NOTE)
        const id = 'c-01J9K'
        editor.commands.replyToComment(id, 'I think so.')
        editor.commands.replyToComment(id, 'A cat, then.', [0])
        editor.commands.reactToComment(id, '🎉')
        editor.commands.editComment(id, 'Are they the same animal?')
        editor.commands.resolveComment(id)
        let t = threadsIn(editor)[id]
        expect(t.status).toBe('resolved')
        expect(t.body).toBe('Are they the same animal?')
        expect(t.replies.map((r) => [r.author, r.body])).toEqual([
            ['alice', 'No, and the second one should be a cat.'],
            ['theo', 'I think so.'],
            ['theo', '🎉'],
        ])
        expect(t.replies[0].replies.map((r) => r.body)).toEqual(['👍', 'A cat, then.'])
        // The same reaction again takes it away; so does deleting a reply.
        editor.commands.reactToComment(id, '🎉')
        editor.commands.deleteComment(id, [1])
        editor.commands.reopenComment(id)
        t = threadsIn(editor)[id]
        expect(t.status).toBe('open')
        expect(t.replies.map((r) => r.body)).toEqual(['No, and the second one should be a cat.'])
        expect(comments.threads()[0].thread).toEqual(t)
    })

    it('deletes a thread with its pins, leaving their text', () => {
        const { editor, comments } = open(NOTE)
        editor.commands.deleteComment('c-01J9K')
        expect(comments.threads()).toEqual([])
        expect(getMarkdownContent(editor)).toBe('# Animals\n\nThe quick brown fox jumps over the lazy dog.')
    })

    it('writes nothing without an author', () => {
        const { editor, comments } = open(NOTE, { comments: { margin: false } })
        expect(comments.author()).toBeNull()
        expect(editor.commands.replyToComment('c-01J9K', 'hi')).toBe(false)
        editor.commands.setTextSelection(rangeOf(editor, 'quick'))
        expect(editor.commands.addComment({ body: 'x' })).toBe(false)
        expect(getMarkdownContent(editor)).toBe(NOTE)
    })
})

describe('Re-anchoring', () => {
    it('follows an edit to the quoted text, in the same undo step', () => {
        const { editor, comments } = open(NOTE)
        const fox = rangeOf(editor, 'fox')
        editor.view.dispatch(editor.state.tr.insertText('red ', fox.from))
        const [t] = comments.threads()
        expect(t.thread.targets[0].fragment).toBe(':~:text=brown%20red%20fox')
        expect(textAt(editor, t.targets[0].range)).toBe('brown red fox')
        expect(getMarkdownContent(editor)).toContain('· open · [[#:~:text=brown%20red%20fox]] [[#c-01J9K]]')
        editor.commands.undo()
        expect(getMarkdownContent(editor)).toBe(NOTE)
    })

    it('leaves targets alone for an edit elsewhere, and keeps an orphan’s quote', () => {
        const { editor, comments } = open(NOTE)
        editor.view.dispatch(editor.state.tr.insertText('Very ', rangeOf(editor, 'The quick').from))
        expect(getMarkdownContent(editor)).toBe(NOTE.replace('The quick', 'Very The quick'))
        // The quoted text deleted: the thread stays, its target orphaned.
        const r = rangeOf(editor, 'brown fox')
        editor.view.dispatch(editor.state.tr.delete(r.from, r.to))
        const [t] = comments.threads()
        expect(t.thread.targets[0].fragment).toBe(':~:text=brown%20fox')
        expect(t.targets[0]).toMatchObject({ range: null, orphaned: true })
        expect(t.orphaned).toBe(true)
        // Anchored again on a selection.
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, rangeOf(editor, 'jumps').from, rangeOf(editor, 'jumps').to)))
        editor.commands.anchorComment('c-01J9K', 0)
        expect(comments.threads()[0].thread.targets[0].fragment).toBe(':~:text=jumps')
        expect(comments.threads()[0].orphaned).toBe(false)
    })

    it('finds a quote changed outside the editor, and rewrites it to what it found', async () => {
        const fs = memoryVfs({ 'n.md': NOTE })
        const container = createTestContainer('comments-reload')
        const editor = createEditor({ element: container, fs: { fs, filepath: 'n.md', autoSave: true }, comments: { author: 'theo', margin: false } })
        created.push({ editor, container })
        await waitFor(() => editor.getText().includes('brown fox'), 3000)
        // Another program changed the quoted words a little.
        await fs.writeFile('n.md', NOTE.replace('quick brown fox', 'quick browne fox'))
        await (editor.storage as any).persistence.refresh()
        await waitFor(() => editor.getText().includes('browne fox'), 3000)
        const comments = (editor.storage as any).comments as CommentsStorage
        const [t] = comments.threads()
        expect(textAt(editor, t.targets[0].range)).toBe('browne fox')
        expect(t.thread.targets[0].fragment).toBe(':~:text=browne%20fox')
    })
})

describe('Threads written in other notes', () => {
    const REVIEW = '# Review\n\n- @alice 2026-09-13T12:10Z · open · [[Plan#:~:text=ship%20it]]\n  Which release?\n'

    async function openPlan() {
        const vault = await Vault.open(memoryVfs({ 'Plan.md': '# Plan\n\nWe ship it on Friday.\n', 'reviews/r.md': REVIEW }), { watch: false })
        const container = createTestContainer('comments-elsewhere')
        const editor = createEditor({
            element: container,
            fs: { fs: vault.fs, filepath: 'Plan.md', autoSave: true },
            links: { resolver: vault.links, index: vault.links },
            search: vault.search,
            files: vault.files,
            comments: { author: 'theo', index: vault.comments, margin: false },
        })
        created.push({ editor, container })
        const comments = (editor.storage as any).comments as CommentsStorage
        await waitFor(() => comments.threads().length === 1, 3000)
        return { vault, editor, comments }
    }

    it('are shown anchored in the note they are about, and changed where they live', async () => {
        const { vault, editor, comments } = await openPlan()
        const [t] = comments.threads()
        expect(t.ref?.source).toBe('reviews/r.md')
        expect(t.pos).toBeNull()
        expect(textAt(editor, t.targets[0].range)).toBe('ship it')
        editor.commands.replyToComment(t.id, 'The next one.')
        await waitFor(async () => (await vault.fs.readFile('reviews/r.md')).includes('- @theo'), 3000)
        expect(await vault.fs.readFile('reviews/r.md')).toMatch(/Which release\?\n {2}- @theo \S+: The next one\.\n$/)
        // The note itself is untouched, and the index's answer comes back in.
        expect(getMarkdownContent(editor)).toBe('# Plan\n\nWe ship it on Friday.')
        await waitFor(() => comments.threads()[0]?.thread.replies.length === 1, 3000)
    })

    it('are re-anchored where they live when the note is saved', async () => {
        const { vault, editor, comments } = await openPlan()
        const r = rangeOf(editor, 'ship it')
        editor.view.dispatch(editor.state.tr.insertText('s', r.from + 5))
        await (editor.storage as any).persistence.save()
        await waitFor(async () => (await vault.fs.readFile('reviews/r.md')).includes('ship%20sit'), 3000)
        await waitFor(() => textAt(editor, comments.threads()[0]?.targets[0].range ?? null) === 'ship sit', 3000)
    })
})

describe('Export', () => {
    it('strips comments, and writes W3C Web Annotations', () => {
        const { comments } = open('---\nid: 01JNOTE\n---\n\n' + NOTE)
        expect(comments.markdownWithoutComments()).toBe('---\nid: 01JNOTE\n---\n\n# Animals\n\nThe quick brown fox jumps over the lazy dog.\n')
        const [thread, reply, reaction] = comments.exportAnnotations()
        expect(thread).toMatchObject({
            '@context': 'http://www.w3.org/ns/anno.jsonld',
            id: 'urn:ezco:note:01JNOTE#c-01J9K',
            type: 'Annotation',
            motivation: 'commenting',
            creator: { type: 'Person', nickname: 'theo' },
            created: '2026-09-13T12:04:00Z',
            body: { type: 'TextualBody', value: 'Are both of these the same animal? See [[Zoology]].', format: 'text/markdown' },
        })
        const [fox, dog] = thread.target as any[]
        expect(fox.source).toBe('urn:ezco:note:01JNOTE')
        expect(fox.selector[0]).toMatchObject({ type: 'TextQuoteSelector', exact: 'brown fox', suffix: ' jumps over the lazy dog.' })
        expect(fox.selector[1].type).toBe('TextPositionSelector')
        expect(dog.selector[0].exact).toBe('lazy dog')
        expect(reply).toMatchObject({ motivation: 'replying', target: 'urn:ezco:note:01JNOTE#c-01J9K', creator: { nickname: 'alice' } })
        expect(reaction).toMatchObject({ motivation: 'assessing', target: (reply as any).id, body: { value: '👍' } })
    })
})
