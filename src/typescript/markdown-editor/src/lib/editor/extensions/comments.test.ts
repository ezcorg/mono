import { describe, it, expect, afterEach } from 'vitest'
import { Vault, memoryVfs, type VfsInterface } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'
import { RESOLVED, type CommentsStorage } from './comments'

/**
 * Comments are documents (comments RFC): a note's comments are the
 * documents referencing ranges of it, each found at its text; a reply is a
 * document referencing a comment's text; reactions are the identity's
 * state. Through a vault, as a host gives them.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement; vault: Vault }> = []
afterEach(() => {
    created.forEach(({ editor, container, vault }) => {
        cleanupEditor(editor, container)
        vault.close()
    })
    created.length = 0
})

const NOTE = '# Animals\n\nThe quick brown fox jumps over the [lazy dog]{#c-01J9K}.\n'
const COMMENT = '![[Animals#:~:text=brown%20fox]]\nAre both of these the same animal? See [[Zoology]].\n'
const PINNED = '![[Animals#c-01J9K]]\nA cat, surely.\n'
const REPLY = '![[comments/Animals/alice 2026-09-13 12.04#:~:text=the%20same%20animal]]\nNo, and the second one should be a cat.\n'

const FILES: Record<string, string> = {
    'Animals.md': NOTE,
    'Zoology.md': '# Zoology\n',
    'comments/Animals/alice 2026-09-13 12.04.md': COMMENT,
    'comments/Animals/bob 2026-09-13 12.10.md': PINNED,
    'comments/Animals/theo 2026-09-13 12.12.md': REPLY,
}

async function open(files = FILES, path = 'Animals.md', author: string | null = 'theo', expect = (editor: MarkdownEditor, comments: CommentsStorage) => editor.getText().includes('fox') && comments.comments().length > 0) {
    const vault = await Vault.open(memoryVfs(files), { watch: false, identity: author ?? undefined })
    const container = createTestContainer(`comments-${created.length}`)
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: path, autoSave: true },
        links: { resolver: vault.links, index: vault.links },
        search: vault.search,
        files: vault.files,
        comments: { author: author ?? undefined, index: vault.comments, reactions: vault.reactions, margin: false },
    })
    created.push({ editor, container, vault })
    const comments = (editor.storage as any).comments as CommentsStorage
    await waitFor(() => expect(editor, comments), 4000)
    return { editor, container, vault, comments, fs: vault.fs as VfsInterface }
}

const textAt = (editor: MarkdownEditor, r: { from: number; to: number } | null) => (r ? editor.state.doc.textBetween(r.from, r.to) : null)
const byAuthor = (comments: CommentsStorage, author: string) => comments.comments().find((c) => c.author === author)!

describe('Comments about a note', () => {
    it('are the documents referencing it, each at its text, with their replies and reactions', async () => {
        const { editor, vault, comments } = await open()
        await vault.reactions.toggle({ doc: 'comments/Animals/alice 2026-09-13 12.04.md', ref: 'Animals#:~:text=brown%20fox' }, '👍')
        await waitFor(() => byAuthor(comments, 'alice').reactions.length === 1, 3000)
        const [a, b] = [byAuthor(comments, 'alice'), byAuthor(comments, 'bob')]
        expect(comments.comments().length).toBe(2)
        expect(textAt(editor, a.target.range)).toBe('brown fox')
        expect(a.time).toBe('2026-09-13T12:04')
        expect(a.body).toBe('Are both of these the same animal? See [[Zoology]].')
        expect(a.replies.map((r) => [r.author, r.body])).toEqual([['theo', 'No, and the second one should be a cat.']])
        expect(a.reactions.map((r) => [r.by, r.emoji])).toEqual([['theo', '👍']])
        expect(a.resolved).toBe(false)
        expect(textAt(editor, b.target.range)).toBe('lazy dog')
        // Highlighted in the note.
        expect([...editor.view.dom.querySelectorAll('.ezco-mde-comment')].map((e) => e.textContent)).toEqual(['brown fox', 'lazy dog'])
    })

    it('are resolved by a ✅, and reopened by taking it away', async () => {
        const { editor, comments } = await open()
        editor.commands.resolveComment(byAuthor(comments, 'alice').id)
        await waitFor(() => byAuthor(comments, 'alice').resolved, 3000)
        expect(byAuthor(comments, 'alice').reactions.map((r) => r.emoji)).toEqual([RESOLVED])
        expect(editor.view.dom.querySelector('.ezco-mde-comment.is-resolved')?.textContent).toBe('brown fox')
        editor.commands.reopenComment(byAuthor(comments, 'alice').id)
        await waitFor(() => !byAuthor(comments, 'alice').resolved, 3000)
    })

    it('are shown, not written, without an author', async () => {
        const { editor, comments } = await open(FILES, 'Animals.md', null)
        expect(comments.comments().length).toBe(2)
        expect(comments.author()).toBeNull()
        expect(editor.commands.addComment({ body: 'x' })).toBe(false)
        expect(editor.commands.reactToComment(byAuthor(comments, 'alice').id, '👍')).toBe(false)
    })
})

describe('Writing comments', () => {
    it('makes a document named for the author and the time, referencing the selection', async () => {
        const { editor, fs, comments } = await open()
        const from = editor.getText().indexOf('jumps') + 1
        editor.commands.setTextSelection({ from, to: from + 'jumps'.length })
        editor.commands.addComment({ body: 'A leap, really.' })
        await waitFor(() => comments.comments().length === 3, 4000)
        const mine = byAuthor(comments, 'theo')
        expect(mine.ref.source).toMatch(/^comments\/Animals\/theo \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.md$/)
        expect(await fs.readFile(mine.ref.source)).toBe('![[Animals#:~:text=jumps]]\n\nA leap, really.\n')
        expect(textAt(editor, mine.target.range)).toBe('jumps')
    })

    it('pins the text when no quote could tell it apart', async () => {
        // Twenty of the same word: no context makes the tenth unique.
        const words = Array.from({ length: 20 }, () => 'ha').join(' ')
        const { editor, fs, comments } = await open({ 'Twice.md': `${words}\n` }, 'Twice.md', 'theo', (e) => e.getText().includes('ha'))
        const from = 1 + 'ha '.length * 9
        editor.commands.setTextSelection({ from, to: from + 2 })
        editor.commands.addComment({ body: 'The tenth one.' })
        await waitFor(() => comments.comments().length === 1, 4000)
        expect(getMarkdownContent(editor)).toMatch(/^(ha ){9}\[ha\]\{#c-[a-z0-9-]+\}( ha){10}$/)
        const doc = await fs.readFile(comments.comments()[0].ref.source)
        expect(doc).toMatch(/^!\[\[Twice#c-[a-z0-9-]+\]\]\n\nThe tenth one\.\n$/)
        expect(textAt(editor, comments.comments()[0].target.range)).toBe('ha')
    })

    it('answers a comment with a document referencing its text, and can open it in the editor', async () => {
        const { editor, fs, comments } = await open()
        editor.commands.replyToComment(byAuthor(comments, 'bob').id, 'Not a cat.')
        await waitFor(() => byAuthor(comments, 'bob').replies.length === 1, 4000)
        const reply = byAuthor(comments, 'bob').replies[0]
        expect(await fs.readFile(reply.ref.source)).toBe('![[comments/Animals/bob 2026-09-13 12.10#:~:text=A%20cat%2C%20surely.]]\n\nNot a cat.\n')
        // Opened: the editor is the editor of that document, its reference an
        // embed that quotes the passage it answers.
        editor.commands.openComment(reply.id)
        await waitFor(() => (editor.storage as any).persistence.options.filepath === reply.ref.source, 4000)
        await waitFor(() => !!editor.view.dom.querySelector('.ezco-mde-embed--passage'), 4000)
        expect(editor.view.dom.querySelector('.ezco-mde-embed--passage .ezco-mde-embed-content')?.textContent?.trim()).toBe('A cat, surely.')
    })

    it('edits a comment where it lives, deletes an unanswered one, and leaves a tombstone for an answered one', async () => {
        const { editor, fs, comments } = await open()
        editor.commands.editComment(byAuthor(comments, 'bob').id, 'A cat, **surely**.')
        await waitFor(() => byAuthor(comments, 'bob').body === 'A cat, **surely**.', 4000)
        expect(await fs.readFile('comments/Animals/bob 2026-09-13 12.10.md')).toBe('![[Animals#c-01J9K]]\n\nA cat, **surely**.\n')
        editor.commands.deleteComment(byAuthor(comments, 'bob').id)
        await waitFor(() => comments.comments().length === 1, 4000)
        expect(await fs.exists('comments/Animals/bob 2026-09-13 12.10.md')).toBe(false)
        // Alice's has a reply: it stays, deleted.
        editor.commands.deleteComment(byAuthor(comments, 'alice').id)
        await waitFor(() => byAuthor(comments, 'alice').body === '[deleted]', 4000)
        expect(byAuthor(comments, 'alice').replies.length).toBe(1)
    })

    it('reacts, and takes a reaction away', async () => {
        const { editor, comments } = await open()
        editor.commands.reactToComment(byAuthor(comments, 'alice').id, '🎉')
        await waitFor(() => byAuthor(comments, 'alice').reactions.some((r) => r.emoji === '🎉'), 3000)
        editor.commands.reactToComment(byAuthor(comments, 'alice').id, '🎉')
        await waitFor(() => !byAuthor(comments, 'alice').reactions.some((r) => r.emoji === '🎉'), 3000)
    })
})

describe('Re-anchoring', () => {
    it('follows an edit to the quoted words, and rewrites the comment’s link where it lives when the note is saved', async () => {
        const { editor, fs, comments } = await open()
        const r = byAuthor(comments, 'alice').target.range!
        editor.view.dispatch(editor.state.tr.insertText('e', r.from + 5))
        await waitFor(() => textAt(editor, byAuthor(comments, 'alice').target.range) === 'browne fox', 2000)
        await (editor.storage as any).persistence.save()
        await waitFor(async () => (await fs.readFile('comments/Animals/alice 2026-09-13 12.04.md')).startsWith('![[Animals#:~:text=browne%20fox]]'), 4000)
    })

    it('finds a quote changed outside the editor when the note is read again', async () => {
        const { editor, fs, comments } = await open()
        await fs.writeFile('Animals.md', NOTE.replace('quick brown fox', 'quick browne fox'))
        await (editor.storage as any).persistence.refresh()
        await waitFor(() => editor.getText().includes('browne fox'), 3000)
        await waitFor(() => textAt(editor, byAuthor(comments, 'alice').target.range) === 'browne fox', 3000)
    })

    it('says when a comment’s text is gone, and anchors it again on a selection', async () => {
        const { editor, fs, comments } = await open()
        const r = byAuthor(comments, 'alice').target.range!
        editor.view.dispatch(editor.state.tr.delete(r.from, r.to))
        await waitFor(() => byAuthor(comments, 'alice').target.orphaned, 2000)
        const from = editor.getText().indexOf('lazy') + 1
        editor.commands.setTextSelection({ from, to: from + 4 })
        editor.commands.anchorComment(byAuthor(comments, 'alice').id)
        await waitFor(async () => (await fs.readFile('comments/Animals/alice 2026-09-13 12.04.md')).startsWith('![[Animals#:~:text=lazy]]'), 4000)
        await waitFor(() => textAt(editor, byAuthor(comments, 'alice').target.range) === 'lazy', 3000)
    })
})

describe('Export', () => {
    it('writes W3C Web Annotations', async () => {
        const { comments } = await open()
        const out = comments.exportAnnotations()
        const alice = out.find((a) => (a.creator as { nickname: string }).nickname === 'alice')!
        expect(alice).toMatchObject({ type: 'Annotation', motivation: 'commenting', created: '2026-09-13T12:04:00Z', body: { format: 'text/markdown' } })
        expect((alice.target as { selector: { exact: string }[] }).selector[0]).toMatchObject({ type: 'TextQuoteSelector', exact: 'brown fox' })
        const reply = out.find((a) => a.motivation === 'replying')!
        expect(reply.target).toBe(alice.id)
    })
})
