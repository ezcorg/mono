import { describe, it, expect } from 'vitest'
import { createTestContainer, createTestEditor, getMarkdownContent, tick, trackEditors } from '../../../test/utils'
import { slugify } from './slug-utils'

describe('Heading anchors', () => {
    const { created } = trackEditors()

    async function make(content: string) {
        const container = createTestContainer(`ha-${created.length}`)
        const editor = await createTestEditor(container, { content })
        created.push({ editor, container })
        return { editor, container }
    }

    it('slugifies + strips diacritics', () => {
        expect(slugify('Hello World!')).toBe('hello-world')
        expect(slugify('  Café & Co  ')).toBe('cafe-co')
        expect(slugify('***')).toBe('')
    })

    it('gives each heading a deduped slug id in the DOM', async () => {
        const { container } = await make('# Intro\n\n## Intro\n\n### Café')
        await tick(40)
        const ids = [
            ...container.querySelectorAll('.ezco-mde-body h1, .ezco-mde-body h2, .ezco-mde-body h3'),
        ].map((h) => h.id)
        expect(ids).toEqual(['intro', 'intro-1', 'cafe'])
    })

    it('does not leak ids into the Markdown serialization', async () => {
        const { editor } = await make('# Intro\n\n## Intro')
        await tick(40)
        const md = getMarkdownContent(editor)
        expect(md).not.toContain('id=')
        expect(md).not.toContain('intro-1')
        expect(md.trim()).toBe('# Intro\n\n## Intro')
    })
})
