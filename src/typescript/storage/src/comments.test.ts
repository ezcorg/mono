import { describe, expect, it } from 'vitest'
import { formatReference, referencesIn, spliceReference, type Reference } from './comments.js'

const NOTE = [
    '---',
    'id: 01J9K',
    'about: "![[Plan]]"',
    '---',
    '# Review of the plan',
    '',
    'Some words before any reference.',
    '',
    '![[Plan#:~:text=ship%20it]]',
    'Which release?',
    '',
    'And is it the one we agreed on?',
    '',
    '![[Plan#^abc]]',
    '',
    'Done, I think:',
    '',
    '```md',
    '![[Not#a-reference]]',
    '# not a heading either',
    '```',
    '',
    '',
    '## Later',
    '',
    '![[Plan#Goals]]',
    '- a list as a body',
    '- of two items',
    '![[diagram.png]]',
    '',
    '![[Other]]',
    'About the whole of Other.',
    '',
].join('\n')

describe('referencesIn', () => {
    it('finds each embed-only paragraph with the Markdown under it', () => {
        const refs = referencesIn(NOTE)
        expect(refs.map((r) => [r.link, r.body, r.line])).toEqual([
            [{ target: 'Plan', fragment: ':~:text=ship%20it', alias: null }, 'Which release?\n\nAnd is it the one we agreed on?', 9],
            [{ target: 'Plan', fragment: '^abc', alias: null }, 'Done, I think:\n\n```md\n![[Not#a-reference]]\n# not a heading either\n```', 14],
            [{ target: 'Plan', fragment: 'Goals', alias: null }, '- a list as a body\n- of two items', 26],
            [{ target: 'Other', fragment: null, alias: null }, 'About the whole of Other.', 31],
        ])
    })

    it('gives offsets whose slice is the text as written, byte for byte', () => {
        for (const r of referencesIn(NOTE)) {
            expect(NOTE.slice(r.start, r.end)).toBe(r.text)
            expect(r.text.startsWith('![[')).toBe(true)
            expect(r.text.endsWith('\n')).toBe(false)
        }
        const [first] = referencesIn(NOTE)
        expect(first.text).toBe('![[Plan#:~:text=ship%20it]]\nWhich release?\n\nAnd is it the one we agreed on?')
    })

    it('ends a body at the next reference, the next heading, or the end', () => {
        expect(referencesIn('![[A]]\none\n![[B]]\ntwo').map((r) => r.body)).toEqual(['one', 'two'])
        expect(referencesIn('![[A]]\none\n\n# H\n\nnot a body').map((r) => r.body)).toEqual(['one'])
        expect(referencesIn('![[A]]\none\n\n\n').map((r) => r.body)).toEqual(['one'])
        // A bare embed (a transclusion) still ends the body before it.
        expect(referencesIn('![[A]]\none\n\n![[img.png]]\n\n# H\ntwo').map((r) => r.body)).toEqual(['one'])
        // What follows an embed, blank lines between or not, is its body.
        expect(referencesIn('![[A]]\n\n\ntwo\n').map((r) => r.body)).toEqual(['two'])
    })

    it('leaves out a bare embed, an embed inside a line, and an embed in code', () => {
        expect(referencesIn('![[Plan]]\n\n')).toEqual([])
        expect(referencesIn('See ![[Plan]]\nand more')).toEqual([])
        expect(referencesIn('- ![[Plan]]\n  a caption')).toEqual([])
        expect(referencesIn('```\n![[Plan]]\nbody\n```\n')).toEqual([])
        expect(referencesIn('~~~\n![[Plan]]\nbody\n~~~\n')).toEqual([])
        // A wikilink that is not an embed is a link.
        expect(referencesIn('[[Plan]]\nbody')).toEqual([])
    })

    it('skips front matter, and takes an unclosed one for a rule', () => {
        expect(referencesIn('---\nx: "![[Plan]]"\n---\n![[Plan]]\nbody').map((r) => [r.line, r.body])).toEqual([[4, 'body']])
        expect(referencesIn('---\n![[Plan]]\nbody\n').map((r) => r.body)).toEqual(['body'])
    })

    it('tolerates CRLF, keeping it in the text and out of the body', () => {
        const crlf = '# H\r\n\r\n![[Plan]]\r\nfirst\r\nsecond\r\n\r\n![[Other]]\r\n'
        const refs = referencesIn(crlf)
        expect(refs.map((r) => r.body)).toEqual(['first\nsecond'])
        expect(refs[0].text).toBe('![[Plan]]\r\nfirst\r\nsecond')
        expect(crlf.slice(refs[0].start, refs[0].end)).toBe(refs[0].text)
    })

    it('keeps a fenced block from starting or ending a reference', () => {
        const md = '![[A]]\nbody\n```\n# heading in code\n![[B]]\n```\nstill body\n'
        expect(referencesIn(md).map((r) => r.body)).toEqual(['body\n```\n# heading in code\n![[B]]\n```\nstill body'])
    })
})

describe('formatReference and spliceReference', () => {
    it('write the embed and the trimmed body under it, which read back the same', () => {
        const text = formatReference({ target: 'Plan', fragment: ':~:text=ship%20it', alias: null }, '\n\nWhich release?\n\nSoon?\n\n')
        expect(text).toBe('![[Plan#:~:text=ship%20it]]\n\nWhich release?\n\nSoon?')
        const [ref] = referencesIn(text)
        expect(ref.body).toBe('Which release?\n\nSoon?')
        expect(ref.text).toBe(text)
        expect(formatReference(ref.link, ref.body)).toBe(text)
    })

    it('round-trip a note byte for byte when every reference is written back unchanged', () => {
        let out = NOTE
        for (const ref of [...referencesIn(NOTE)].reverse()) out = spliceReference(out, ref, ref.text)
        expect(out).toBe(NOTE)
        // And every one written in the canonical form (a blank line between the
        // reference and its body) changes only what differed.
        out = NOTE
        for (const ref of [...referencesIn(NOTE)].reverse()) out = spliceReference(out, ref, formatReference(ref.link, ref.body))
        expect(out).toBe(
            NOTE.replace('![[Plan#:~:text=ship%20it]]\nWhich', '![[Plan#:~:text=ship%20it]]\n\nWhich')
                .replace('![[Plan#Goals]]\n- a', '![[Plan#Goals]]\n\n- a')
                .replace('![[Other]]\nAbout', '![[Other]]\n\nAbout'),
        )
    })

    it('replace one reference, and remove one with the blank line it leaves', () => {
        const [first, second] = referencesIn(NOTE)
        const replaced = spliceReference(NOTE, second, formatReference(second.link, 'Not done.'))
        expect(referencesIn(replaced).map((r) => r.body)[1]).toBe('Not done.')
        expect(replaced.slice(0, first.end)).toBe(NOTE.slice(0, first.end))

        const removed = spliceReference(NOTE, first, null)
        expect(removed).toBe(NOTE.replace('![[Plan#:~:text=ship%20it]]\nWhich release?\n\nAnd is it the one we agreed on?\n\n', ''))
        expect(referencesIn(removed)).toHaveLength(3)
        // At the end of a note, the blank line before it goes too.
        const tail: Pick<Reference, 'start' | 'end'> = { start: 'a\n\n'.length, end: 'a\n\n![[B]]\nb'.length }
        expect(spliceReference('a\n\n![[B]]\nb\n', tail, null)).toBe('a\n')
        expect(spliceReference('a\n\n![[B]]\nb', tail, null)).toBe('a\n')
        expect(spliceReference('a\r\n\r\n![[B]]\r\nb\r\n', { start: 5, end: 5 + '![[B]]\r\nb'.length }, null)).toBe('a\r\n')
    })
})
