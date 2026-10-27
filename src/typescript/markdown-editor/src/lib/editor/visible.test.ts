import { describe, it, expect } from 'vitest'
import { frames, trackEditors, waitFor } from '../../test/utils'

/**
 * What the editor draws is there to be seen: every block's glyph in the
 * gutter, a code block's toolbar and its icon, a callout's icon and title,
 * the front matter's header, a fold's chevron and ellipsis, the indicator
 * beside the active block, and the editor's own toolbar. Each is checked
 * in a real browser for a box of some size, for being painted (no
 * `display: none`, `visibility: hidden` or zero opacity up the tree) and
 * for holding something (text, or a drawing), so a glyph that renders to
 * nothing (`</>` once taken for markup) or a style that hides a part is
 * caught here rather than by eye.
 */
const { openVault } = trackEditors()

const NOTE = [
    '---',
    'title: Seen',
    '---',
    '',
    '# Heading',
    '',
    'A paragraph of text.',
    '',
    '* A bullet',
    '',
    '1. A number',
    '',
    '- [ ] A task',
    '',
    '> A quote',
    '',
    '> [!tip] A tip',
    '> Its body.',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '```ts',
    'const answer = 42',
    '```',
    '',
    '---',
    '',
    'The last paragraph.',
].join('\n')

/** Why `el` cannot be seen, or null when it can. */
function unseen(el: Element | null, what: string): string | null {
    if (!el) return `${what}: not in the document`
    const box = el.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) return `${what}: no box (${box.width}×${box.height})`
    for (let node: Element | null = el; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (style.display === 'none') return `${what}: display none on ${node.tagName.toLowerCase()}.${[...node.classList].join('.')}`
        if (style.visibility === 'hidden') return `${what}: visibility hidden on ${node.tagName.toLowerCase()}`
        if (parseFloat(style.opacity) === 0) return `${what}: opacity 0 on ${node.tagName.toLowerCase()}.${[...node.classList].join('.')}`
        if (node === document.body) break
    }
    return null
}

/** `unseen`, and empty as well: nothing drawn in it (no text, no SVG, no generated content). */
function blank(el: Element | null, what: string): string | null {
    const why = unseen(el, what)
    if (why) return why
    const text = el!.textContent?.trim() ?? ''
    const drawn = !!el!.querySelector('svg')
    const before = getComputedStyle(el!, '::before').content
    const generated = before !== 'none' && before !== 'normal' && before !== '""'
    return text || drawn || generated ? null : `${what}: nothing in it`
}

describe('What the editor draws can be seen', () => {
    it('every block’s glyph, the code block’s toolbar, the callout, the front matter, a fold, the indicator and the toolbar', async () => {
        const { editor, container } = await openVault(
            { 'Seen.md': NOTE },
            { path: 'Seen.md', identity: 'theo', autoSave: true, size: { width: 900, height: 700, scroll: true }, services: ['resolver', 'index', 'search', 'files'] },
        )
        await waitFor(() => !!container.querySelector('.ezco-mde-body > .cm-editor .cm-toolbar-state-icon') && !!container.querySelector('.ezco-mde-gutter .ezco-mde-block-icon'), 5000)
        await frames(3)
        const problems: string[] = []
        const note = (why: string | null) => why && problems.push(why)

        // A glyph in the gutter for every block of the note, each with something in it.
        const glyphs = [...container.querySelectorAll<HTMLElement>('.ezco-mde-gutter .ezco-mde-block-icon')]
        expect(glyphs.length).toBe(editor.state.doc.childCount)
        for (const glyph of glyphs) note(blank(glyph, `the ${glyph.dataset.blockType} glyph`))
        expect(glyphs.find((g) => g.dataset.blockType === 'ezcodeBlock')?.textContent).toBe('</>')

        // The code block's toolbar: its icon (a glyph of the icon font) and its field.
        const code = container.querySelector<HTMLElement>('.ezco-mde-body > .cm-editor')!
        note(blank(code.querySelector('.cm-toolbar-state-icon'), 'the code block’s toolbar icon'))
        note(unseen(code.querySelector('.cm-toolbar-input'), 'the code block’s field'))
        note(unseen(code.querySelector('.cm-line'), 'the code'))

        // The callout's icon and title; the front matter's header.
        note(blank(container.querySelector('.ezco-mde-callout-icon'), 'the callout’s icon'))
        note(blank(container.querySelector('.ezco-mde-callout-title'), 'the callout’s title'))
        note(blank(container.querySelector('.ezco-mde-front-matter-head .cm-toolbar-state-icon'), 'the front matter’s glyph'))
        note(blank(container.querySelector('.ezco-mde-front-matter-summary'), 'the front matter’s summary'))

        // The editor's own toolbar, with its icon.
        note(blank(container.querySelector('.ezco-mde-toolbar .cm-toolbar-state-icon'), 'the toolbar’s icon'))
        note(unseen(container.querySelector('.ezco-mde-toolbar .cm-toolbar-input'), 'the toolbar’s field'))

        // The indicator beside the active block, once the note is focused.
        editor.commands.focus(3)
        const indicator = container.querySelector<HTMLElement>('.ezco-mde-block-action-btn')!
        await waitFor(() => indicator.style.opacity === '1', 2000)
        note(unseen(indicator, 'the block indicator'))

        // A fold: its chevron in the gutter and its ellipsis after the line.
        const paragraph = editor.state.doc.child(2)
        expect(paragraph.type.name).toBe('paragraph')
        let at = 0
        editor.state.doc.forEach((_child, offset, i) => {
            if (i === 2) at = offset
        })
        expect(editor.commands.foldBlocks(at, at + paragraph.nodeSize)).toBe(true)
        await frames(3)
        note(blank(container.querySelector('.ezco-mde-block-icon.is-fold'), 'the fold’s chevron'))
        note(blank(container.querySelector('.ezco-mde-fold-ellipsis'), 'the fold’s ellipsis'))

        expect(problems).toEqual([])
    })
})
