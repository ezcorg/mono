import { describe, it, expect } from 'vitest'
import { getMarkdownContent, trackEditors } from '../../../test/utils'

/**
 * Text stays text: what is typed as prose is written as it was typed, and
 * only what would read back as syntax is escaped.
 */

const editors = trackEditors()
const open = (content: string) => editors.make(content).editor

describe('Angle brackets', () => {
    it.each(['a -> b, and x < y > z', 'Use <T> for a type, or <div> as text', 'a <= b >= c'])('round-trips %j as written', (md) => {
        expect(getMarkdownContent(open(md))).toBe(md)
    })

    it('escapes a typed `<` only where it would open an autolink', () => {
        const editor = open('Plain text.')
        const typed = 'See <https://example.com> and <me@example.com>, not <b> or 3 < 4.'
        editor.view.dispatch(editor.state.tr.insertText(typed, 1, editor.state.doc.content.size - 1))
        expect(getMarkdownContent(editor)).toBe('See \\<https://example.com> and \\<me@example.com>, not <b> or 3 < 4.')
        // And that reads back as the same text.
        const again = open(getMarkdownContent(editor))
        expect(again.getText()).toBe('See <https://example.com> and <me@example.com>, not <b> or 3 < 4.')
    })
})
