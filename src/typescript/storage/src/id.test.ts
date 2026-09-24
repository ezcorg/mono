import { describe, expect, it } from 'vitest'
import { frontMatterOf, newNoteId, noteIdOf } from './id.js'

describe('note ids', () => {
    it('are 26-character ULIDs that sort by time', () => {
        const a = newNoteId(1_700_000_000_000)
        const b = newNoteId(1_700_000_000_001)
        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
        expect(a < b).toBe(true)
        expect(newNoteId()).not.toBe(newNoteId())
    })

    it('are read from front matter, quoted or not', () => {
        expect(noteIdOf('---\nid: 01J9K\ntitle: x\n---\n# Body')).toBe('01J9K')
        expect(noteIdOf('---\ntitle: x\nid: "01J9K"\n...\n')).toBe('01J9K')
        expect(noteIdOf('---\nid:\n---\n')).toBeNull()
        expect(noteIdOf('# No front matter\nid: 1')).toBeNull()
        expect(noteIdOf('---\n  nested:\n    id: 1\n---')).toBeNull()
    })

    it('finds the front matter block, empty included', () => {
        expect(frontMatterOf('---\n---\nbody')).toBe('')
        expect(frontMatterOf('---\na: 1\nb: 2\n---')).toBe('a: 1\nb: 2')
        expect(frontMatterOf('--- \na: 1\n---')).toBeNull()
        expect(frontMatterOf('text\n---\na: 1\n---')).toBeNull()
    })
})
