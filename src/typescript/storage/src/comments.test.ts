import { describe, expect, it } from 'vitest'
import {
    commentTime,
    formatThread,
    isReaction,
    newCommentId,
    parseThreadDefinition,
    parseThreadHeader,
    stripComments,
    threadsIn,
    type Thread,
} from './comments.js'

const RFC_THREAD = [
    '[^c-01J9K]: @theo 2026-09-13T12:04Z · open · [[#:~:text=brown%20fox]] [[#c-01J9K]]',
    '    Are both of these the same animal? See [[Zoology]].',
    '    - @alice 2026-09-13T12:10Z: No, and the second one should be a cat.',
    '      - @theo 2026-09-13T12:12Z: 👍',
].join('\n')

const NOTE = ['# Animals', '', 'The quick brown fox jumps over the [lazy dog]{#c-01J9K}.', '', RFC_THREAD, ''].join('\n')

describe('A thread', () => {
    it('reads the RFC’s example: header, targets, body, and nested replies', () => {
        const parsed = parseThreadDefinition(RFC_THREAD)!
        expect(parsed.label).toBe('c-01J9K')
        expect(parsed.thread).toEqual({
            author: 'theo',
            time: '2026-09-13T12:04Z',
            status: 'open',
            targets: [
                { target: '', fragment: ':~:text=brown%20fox', alias: null },
                { target: '', fragment: 'c-01J9K', alias: null },
            ],
            body: 'Are both of these the same animal? See [[Zoology]].',
            replies: [
                {
                    author: 'alice',
                    time: '2026-09-13T12:10Z',
                    body: 'No, and the second one should be a cat.',
                    replies: [{ author: 'theo', time: '2026-09-13T12:12Z', body: '👍', replies: [] }],
                },
            ],
        } satisfies Thread)
        // Written back as it was.
        expect(formatThread(parsed.thread, parsed.label)).toBe(RFC_THREAD)
    })

    it('reads a header without status or targets, and one with text after them', () => {
        expect(parseThreadHeader('@theo 2026-09-13T12:04Z')).toEqual({ author: 'theo', time: '2026-09-13T12:04Z', status: 'open', targets: [], rest: '' })
        expect(parseThreadHeader('@theo 2026-09-13T12:04:59Z · resolved')?.status).toBe('resolved')
        expect(parseThreadHeader('@theo 2026-09-13T12:04Z · [[Plan#^abc]] · Is this right?')).toMatchObject({
            status: 'open',
            targets: [{ target: 'Plan', fragment: '^abc', alias: null }],
            rest: 'Is this right?',
        })
        expect(parseThreadHeader('theo 2026-09-13T12:04Z')).toBeNull()
        expect(parseThreadHeader('@theo yesterday')).toBeNull()
        // A footnote that is no thread.
        expect(parseThreadDefinition('[^1]: Just a footnote.')).toBeNull()
    })

    it('keeps a multi-paragraph body and replies whose bodies are several lines', () => {
        const thread: Thread = {
            author: 'theo',
            time: '2026-09-13T12:04Z',
            status: 'resolved',
            targets: [],
            body: 'First paragraph.\n\nSecond, with a list:\n\n- one\n- two',
            replies: [
                { author: 'alice', time: '2026-09-13T12:10Z', body: 'A reply\nthat wraps.\n\nAnd goes on.', replies: [] },
                { author: 'bob', time: '2026-09-13T12:11Z', body: '```js\nx()\n```', replies: [] },
            ],
        }
        const text = formatThread(thread, 'c-1')
        expect(text).toBe(
            [
                '[^c-1]: @theo 2026-09-13T12:04Z · resolved',
                '    First paragraph.',
                '',
                '    Second, with a list:',
                '',
                '    - one',
                '    - two',
                '    - @alice 2026-09-13T12:10Z: A reply',
                '      that wraps.',
                '',
                '      And goes on.',
                // A body that starts a block of its own goes on the next line.
                '    - @bob 2026-09-13T12:11Z:',
                '      ```js',
                '      x()',
                '      ```',
            ].join('\n'),
        )
        expect(parseThreadDefinition(text)!.thread).toEqual(thread)
        // And as a list item in another note.
        const item = formatThread(thread, null)
        expect(item.split('\n')[0]).toBe('- @theo 2026-09-13T12:04Z · resolved')
        expect(threadsIn(item)[0].thread).toEqual(thread)
    })

    it('knows a reaction from a reply', () => {
        expect(isReaction('👍')).toBe(true)
        expect(isReaction('🎉 ❤️')).toBe(true)
        expect(isReaction('👍🏽')).toBe(true)
        expect(isReaction('👍 yes')).toBe(false)
        expect(isReaction('1')).toBe(false)
        expect(isReaction('')).toBe(false)
    })

    it('has an id and a time of the shape the grammar reads', () => {
        const when = Date.UTC(2026, 8, 13, 12, 4, 30)
        expect(newCommentId(when)).toMatch(/^c-[0-9A-HJKMNP-TV-Z]{16}$/)
        expect(commentTime(when)).toBe('2026-09-13T12:04Z')
        expect(parseThreadHeader(`@theo ${commentTime(when)}`)).not.toBeNull()
    })
})

describe('The threads in a note', () => {
    it('are found in footnotes and in top-level list items, not in code or front matter', () => {
        const review = [
            '---',
            'note: "[^c-9]: @x 2026-09-13T12:04Z · open"',
            '---',
            '# Review',
            '',
            '- @alice 2026-09-13T12:10Z · open · [[Plan#:~:text=ship%20it]]',
            '  Which release?',
            '  - @theo 2026-09-13T12:12Z: The next one.',
            '- an ordinary item',
            '- @bob 2026-09-13T12:20Z: reads like a reply, is not a thread',
            '',
            '```',
            '[^c-2]: @theo 2026-09-13T12:04Z · open',
            '```',
            '',
            RFC_THREAD,
        ].join('\n')
        const found = threadsIn(review)
        expect(found.map((t) => [t.form, t.label, t.line])).toEqual([
            ['item', null, 6],
            ['footnote', 'c-01J9K', 16],
        ])
        expect(found[0].thread.replies[0].body).toBe('The next one.')
        expect(found[0].text).toBe(review.split('\n').slice(5, 8).join('\n'))
        expect(review.slice(found[1].start, found[1].end)).toBe(RFC_THREAD)
    })

    it('take in a lazy continuation line, and stop at the next block', () => {
        const text = '[^c-1]: @theo 2026-09-13T12:04Z · open\nwritten without indenting\n\nA paragraph after.'
        const [t] = threadsIn(text)
        expect(t.thread.body).toBe('written without indenting')
        expect(t.text).toBe('[^c-1]: @theo 2026-09-13T12:04Z · open\nwritten without indenting')
    })

    it('can be stripped, the pins they point at unwrapped and other spans kept', () => {
        const note = NOTE.replace('The quick', 'The [quick]{.adjective} quick')
        expect(stripComments(note)).toBe(['# Animals', '', 'The [quick]{.adjective} quick brown fox jumps over the lazy dog.', ''].join('\n'))
        // Between paragraphs: one blank line left.
        expect(stripComments(`A.\n\n${RFC_THREAD}\n\nB.\n`)).toBe('A.\n\nB.\n')
        expect(stripComments('No comments.\n')).toBe('No comments.\n')
    })
})
