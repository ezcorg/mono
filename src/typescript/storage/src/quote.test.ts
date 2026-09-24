import { describe, expect, it } from 'vitest'
import { findTextFragment, formatTextFragment, parseTextFragment, textFragmentFor, type TextFragment } from './quote.js'

const NOTE = [
    'The quick brown fox jumps over the lazy dog.',
    'A second paragraph, about foxes in general and in particular, and dogs.',
    'The quick brown fox appears again here, on its own.',
].join('\n')

const at = (text: string, passage: string, nth = 0) => {
    let from = -1
    for (let i = 0; i <= nth; i++) from = text.indexOf(passage, from + 1)
    return { from, to: from + passage.length }
}

describe('A text fragment', () => {
    it('reads and writes the directive, with the characters that separate parts encoded', () => {
        const f = parseTextFragment(':~:text=The%20quick-,brown%20fox,-jumps')
        expect(f).toEqual({ prefix: 'The quick', start: 'brown fox', end: null, suffix: 'jumps' })
        expect(parseTextFragment('text=a,b')).toEqual({ prefix: '', start: 'text=a', end: 'b', suffix: '' })
        expect(parseTextFragment(':~:text=start,end&text=other')).toEqual({ prefix: '', start: 'start', end: 'end', suffix: '' })
        expect(parseTextFragment(':~:text=')).toBeNull()
        const tricky: TextFragment = { prefix: 'well-known', start: 'a, b & c', end: null, suffix: '[x]|y' }
        const written = formatTextFragment(tricky)
        expect(written).toBe(':~:text=well%2Dknown-,a%2C%20b%20%26%20c,-%5Bx%5D%7Cy')
        expect(parseTextFragment(written)).toEqual(tricky)
    })

    it('is found as written, its context choosing between places', () => {
        const f = parseTextFragment(':~:text=quick%20brown%20fox,-appears')!
        expect(findTextFragment(NOTE, f)).toEqual({ ...at(NOTE, 'quick brown fox', 1), exact: true })
        // Without context, the first place, or the one nearest a hint.
        const bare = parseTextFragment(':~:text=quick%20brown%20fox')!
        expect(findTextFragment(NOTE, bare)?.from).toBe(at(NOTE, 'quick brown fox').from)
        expect(findTextFragment(NOTE, bare, NOTE.length)?.from).toBe(at(NOTE, 'quick brown fox', 1).from)
        // A start and an end: the passage between them.
        const long = parseTextFragment(':~:text=A%20second,and%20dogs')!
        expect(findTextFragment(NOTE, long)).toEqual({ ...at(NOTE, 'A second paragraph, about foxes in general and in particular, and dogs'), exact: true })
    })

    it('is found without regard to case, then approximately after a small edit', () => {
        const f = parseTextFragment(':~:text=THE%20LAZY%20DOG')!
        expect(findTextFragment(NOTE, f)).toEqual({ ...at(NOTE, 'the lazy dog'), exact: true })
        // A word changed inside the quote since it was taken.
        const edited = NOTE.replace('jumps over the lazy dog', 'jumps over the sleepy dog')
        const quote = parseTextFragment(':~:text=jumps%20over%20the%20lazy%20dog')!
        expect(findTextFragment(edited, quote)).toEqual({ ...at(edited, 'jumps over the sleepy dog'), exact: false })
        // Too different is not found.
        expect(findTextFragment(NOTE.replace('lazy dog', 'cat'), parseTextFragment(':~:text=over%20the%20lazy%20dog')!)).toBeNull()
    })

    it('is made for a passage: short and unique as it can be, with context only when needed', () => {
        const lazy = at(NOTE, 'lazy dog')
        expect(textFragmentFor(NOTE, lazy.from, lazy.to)).toEqual({ prefix: '', start: 'lazy dog', end: null, suffix: '' })
        // A repeated passage takes a word of context.
        const second = at(NOTE, 'quick brown fox', 1)
        const f = textFragmentFor(NOTE, second.from, second.to)!
        expect(f).toEqual({ prefix: 'The', start: 'quick brown fox', end: null, suffix: 'appears' })
        expect(findTextFragment(NOTE, f)).toEqual({ ...second, exact: true })
        // A long passage is its first and last words.
        const long = at(NOTE, 'A second paragraph, about foxes in general and in particular, and dogs.')
        const lf = textFragmentFor(NOTE, long.from, long.to)!
        expect(lf).toEqual({ prefix: '', start: 'A second paragraph, about', end: 'in particular, and dogs.', suffix: '' })
        expect(findTextFragment(NOTE, lf)).toEqual({ ...long, exact: true })
        // Surrounding whitespace is left out.
        expect(textFragmentFor(NOTE, lazy.from - 1, lazy.to)?.start).toBe('lazy dog')
    })

    it('is not made when the passage and its surroundings repeat word for word', () => {
        const text = Array.from({ length: 30 }, () => 'la').join(' ')
        const middle = at(text, 'la', 15)
        expect(textFragmentFor(text, middle.from, middle.to)).toBeNull()
        // Even the first: a fragment cannot say "at the start".
        const first = at(text, 'la')
        expect(textFragmentFor(text, first.from, first.to)).toBeNull()
    })
})
