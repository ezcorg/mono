import { describe, expect, it } from 'vitest'
import {
    Catalog,
    markdownDestinationFor,
    newNotePath,
    resolveLink,
    resolveMarkdownLink,
    resolveWikilink,
    wikilinkTextFor,
} from './resolve.js'

const files = new Catalog([
    'index.md',
    'plan.md',
    'projects/plan.md',
    'projects/Roadmap.md',
    'projects/2026/plan.md',
    'archive/2025/plan.md',
    'attachments/diagram.png',
    'v1.2.md',
    'readme',
])

describe('wikilink resolution', () => {
    it('prefers a note beside the linking note, then the vault root', () => {
        expect(resolveWikilink('plan', 'projects/x.md', files)).toBe('projects/plan.md')
        expect(resolveWikilink('plan', 'index.md', files)).toBe('plan.md')
        expect(resolveWikilink('plan', 'archive/x.md', files)).toBe('plan.md')
        expect(resolveWikilink('projects/plan', 'archive/2025/x.md', files)).toBe('projects/plan.md')
        expect(resolveWikilink('../index', 'projects/x.md', files)).toBe('index.md')
    })

    it('finds a name anywhere, closest to the linking note first', () => {
        expect(resolveWikilink('2026/plan', 'index.md', files)).toBe('projects/2026/plan.md')
        expect(resolveWikilink('2025/plan', 'index.md', files)).toBe('archive/2025/plan.md')
        expect(resolveWikilink('roadmap', 'index.md', files)).toBe('projects/Roadmap.md')
        expect(resolveWikilink('diagram.png', 'index.md', files)).toBe('attachments/diagram.png')
    })

    it('treats an extension it does not know as part of a note name', () => {
        expect(resolveWikilink('v1.2', null, files)).toBe('v1.2.md')
        expect(resolveWikilink('readme', null, files)).toBe('readme')
        expect(newNotePath('v1.3', 'projects/x.md')).toBe('projects/v1.3.md')
        expect(newNotePath('photo.png', null)).toBe('photo.png')
    })

    it('resolves an empty target to the linking note, and reports where a missing one would go', () => {
        expect(resolveWikilink('', 'projects/plan.md', files)).toBe('projects/plan.md')
        expect(resolveWikilink('ghost', 'projects/x.md', files)).toBeNull()
        expect(resolveLink('ghost', 'projects/x.md', 'wikilink', files)).toEqual({ path: 'projects/ghost.md', exists: false })
    })

    it('writes the shortest unambiguous link, or as qualified as asked', () => {
        expect(wikilinkTextFor('projects/Roadmap.md', 'index.md', files)).toBe('Roadmap')
        expect(wikilinkTextFor('projects/plan.md', 'index.md', files)).toBe('projects/plan')
        expect(wikilinkTextFor('projects/plan.md', 'projects/x.md', files)).toBe('plan')
        expect(wikilinkTextFor('archive/2025/plan.md', 'index.md', files)).toBe('2025/plan')
        expect(wikilinkTextFor('attachments/diagram.png', 'index.md', files)).toBe('diagram.png')
        expect(wikilinkTextFor('projects/Roadmap.md', 'index.md', files, 2)).toBe('projects/Roadmap')
    })
})

describe('Markdown link resolution', () => {
    it('is a path from the note, percent-decoded, with a missing .md tolerated', () => {
        expect(resolveMarkdownLink('Roadmap.md', 'projects/plan.md', files)).toEqual({ path: 'projects/Roadmap.md', exists: true })
        expect(resolveMarkdownLink('../plan', 'projects/plan.md', files)).toEqual({ path: 'plan.md', exists: true })
        expect(resolveMarkdownLink('/projects/2026/plan.md', 'archive/2025/plan.md', files)).toEqual({
            path: 'projects/2026/plan.md',
            exists: true,
        })
        expect(resolveMarkdownLink('my%20note.md', 'projects/a.md', files)).toEqual({ path: 'projects/my note.md', exists: false })
    })

    it('writes a destination the way the original was written', () => {
        expect(markdownDestinationFor('projects/my plan.md', 'index.md')).toBe('projects/my%20plan.md')
        expect(markdownDestinationFor('projects/my plan.md', 'index.md', { target: 'x', angled: true })).toBe('projects/my plan')
        expect(markdownDestinationFor('plan.md', 'projects/2026/x.md', { target: 'y.md' })).toBe('../../plan.md')
    })
})
