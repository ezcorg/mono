import { describe, expect, it } from 'vitest'
import { formatWikilink, parseWikilink, rewriteLinks, scanLinks } from './syntax.js'

describe('wikilink grammar', () => {
    const forms = [
        'note',
        'folder/Note Name',
        'note#heading',
        'note#heading|shown text',
        '#heading',
        'note#^block-id',
        'Note#:~:text=brown%20fox',
        'note|',
        'image.png',
        'a|b|c',
    ]

    it.each(forms)('formats [[%s]] back to what was written', (inner) => {
        const link = parseWikilink(inner)
        expect(link).not.toBeNull()
        expect(formatWikilink(link!)).toBe(`[[${inner}]]`)
    })

    it('splits target, fragment and alias at the first # and |', () => {
        expect(parseWikilink('a/b#c#d|e|f')).toEqual({ target: 'a/b', fragment: 'c#d', alias: 'e|f' })
        expect(parseWikilink('#top')).toEqual({ target: '', fragment: 'top', alias: null })
    })

    it('treats an escaped pipe as the alias separator and escapes it again inside tables', () => {
        const link = parseWikilink('note\\|alias')!
        expect(link).toEqual({ target: 'note', fragment: null, alias: 'alias' })
        expect(formatWikilink(link, { inTable: true })).toBe('[[note\\|alias]]')
        expect(formatWikilink(link, { embed: true })).toBe('![[note|alias]]')
    })

    it('refuses what is not a link', () => {
        for (const inner of ['', ' ', 'a\nb', 'a[b', 'a]b', '|alias']) expect(parseWikilink(inner)).toBeNull()
    })
})

describe('scanning a note for links', () => {
    it('finds every kind, with lines and target offsets', () => {
        const text = [
            'See [[plan]] and ![[img.png|200]].',
            'A [link](notes/a.md#part "title") and ![alt](<my pic.png>).',
            '[ref]: ../b.md',
            'External [x](https://e.com/a.md), [y](#local), [z](mailto:a@b.c).',
        ].join('\n')
        const links = scanLinks(text)
        expect(links.map((l) => [l.kind, l.target, l.fragment, l.line])).toEqual([
            ['wikilink', 'plan', null, 1],
            ['embed', 'img.png', null, 1],
            ['markdown', 'notes/a.md', 'part', 2],
            ['image', 'my pic.png', null, 2],
            ['definition', '../b.md', null, 3],
        ])
        for (const l of links) expect(text.slice(l.targetStart, l.targetEnd)).toBe(l.target)
        expect(links[3].angled).toBe(true)
    })

    it('skips fenced code, inline code and escaped brackets', () => {
        const text = [
            '`[[in code]]` and ``[x](y.md)`` but [[real]]',
            '\\[[escaped]] and \\[not](a link.md)',
            '```',
            '[[fenced]]',
            '```',
            '~~~~ md',
            '[[tilde fenced]]',
            '```',
            '[[still fenced: a shorter or different fence does not close]]',
            '~~~~',
            '[[after]]',
        ].join('\n')
        expect(scanLinks(text).map((l) => l.target)).toEqual(['real', 'after'])
    })

    it('reads wikilinks in front matter, not Markdown links', () => {
        const text = '---\nrelated: "[[plan]]"\nurl: "[x](y.md)"\n---\n[[body]]'
        expect(scanLinks(text).map((l) => [l.target, l.line])).toEqual([
            ['plan', 2],
            ['body', 5],
        ])
    })
})

describe('rewriting links', () => {
    it('replaces only the targets asked for, byte for byte elsewhere', () => {
        const text = 'A [[plan#Goals|goals]], [p](plan.md "t"), [[other]] and `[[plan]]`.\n'
        const out = rewriteLinks(text, (l) => (l.target.startsWith('plan') ? l.target.replace('plan', 'next') : null))
        expect(out).toEqual({ text: 'A [[next#Goals|goals]], [p](next.md "t"), [[other]] and `[[plan]]`.\n', count: 2 })
    })
})
