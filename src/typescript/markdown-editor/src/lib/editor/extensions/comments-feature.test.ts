import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { memoryVfs } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
import { Comments, CommentInline, CommentMargin, CommentMarks, createEditor, markdownSetup, settingsOf } from '../index'
import { settingsEntries } from '../settings'
import { commentsEnabled, enableComments } from './comments-feature'
import { createTestContainer, trackEditors, waitFor } from '../../../test/utils'

/**
 * The comments work is behind a switch (comments-feature.ts), off until it
 * ships. The suites turn it on (test/utils/setup.ts); this one turns it
 * off, and checks that an editor made then has none of it, while a note
 * and the comments on it are still the documents they are.
 */

const NOTE = '# Note\n\nSome text to comment on, and more of it after.\n'
const COMMENT_PATH = 'comments/Note/alice 2026-09-13 12.01.md'
const COMMENT = '![[Note#:~:text=text%20to%20comment]]\n\nA comment.\n'

const { track } = trackEditors()

describe('The comments work, switched off', () => {
    beforeAll(() => enableComments(false))
    afterAll(() => enableComments(true))

    it('leaves the comment extensions out of `markdownSetup`, whatever the `comments` option says', () => {
        expect(commentsEnabled()).toBe(false)
        const names = markdownSetup({ comments: { author: 'theo' } }).map((e) => e.name)
        for (const ext of [Comments, CommentMarks, CommentMargin, CommentInline]) expect(names).not.toContain(ext.name)
    })

    it('makes an editor with no comments, no columns for them and no Comments settings; the author still names whose settings are read; the comment is a document as written', async () => {
        const vault = await Vault.open(memoryVfs({ 'Note.md': NOTE, [COMMENT_PATH]: COMMENT }), { identity: 'theo' })
        const container = createTestContainer('comments-off')
        container.style.width = '1100px'
        const editor = createEditor({
            element: container,
            fs: { fs: vault.fs, filepath: 'Note.md' },
            comments: { author: 'theo', index: vault.comments, reactions: vault.reactions },
            settings: { instance: 'test' },
        })
        track(editor, container, vault)
        await waitFor(() => editor.getText().includes('Some text'), 3000)
        // Nothing of the work: no extension, no storage, no columns, no highlight.
        expect(editor.extensionManager.extensions.map((e) => e.name)).not.toContain(Comments.name)
        expect((editor.storage as Record<string, unknown>).comments).toBeUndefined()
        expect(container.querySelector('.ezco-mde-annotations')).toBeNull()
        expect(container.querySelector('.ezco-mde-comments')).toBeNull()
        expect(container.querySelector('.ezco-mde-comment')).toBeNull()
        // The settings offer no Comments group (the toolbar's entries, the
        // schema beside the files), and are still the author's.
        const settings = settingsOf(editor)!
        await settings.ready
        expect(settings.schema.properties?.comments).toBeUndefined()
        const entries = settingsEntries(settings, 'device', '')
        expect(entries.some((e) => e.id.startsWith('Comments'))).toBe(false)
        expect(entries.some((e) => e.id.startsWith('The note'))).toBe(true)
        expect(settings.file('global')).toBe('.settings/theo/global.yaml')
        // The comment's document, opened: its reference and its text, as written.
        await (editor.storage as any).persistence.loadFile(COMMENT_PATH)
        await waitFor(() => editor.getText().includes('A comment'), 3000)
        expect(editor.storage.markdown.getMarkdown().trimEnd()).toBe(COMMENT.trimEnd())
    })
})
