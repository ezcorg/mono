import { describe, it, expect, afterAll } from 'vitest'
import { page, userEvent } from '@vitest/browser/context'
import { settingsOf, codeblockRegistry, type MarkdownEditor } from './index'
import { frames, rangeOf, trackEditors, waitFor } from '../../test/utils'

/**
 * The note rendered: one note with every block kind the editor knows and a
 * comment on a passage, at two widths in both themes, measured where the
 * owner has corrected things before: each gutter glyph level with its
 * block's first line, the gutter at the note's edge, the comments panel
 * beside the note where it fits and floating where it does not, nothing
 * wider than the host, the composer's buttons in its bubble, and every
 * colour of the surfaces one of the theme's own tokens (a literal that
 * does not follow the theme is caught).
 */

type Theme = 'light' | 'dark'

const { openVault } = trackEditors({
    also: () => {
        codeblockRegistry.setTheme({ dark: false })
        document.documentElement.removeAttribute('data-theme')
    },
})
afterAll(async () => {
    await page.viewport(1280, 720)
})

const NOTE = [
    '---',
    'title: Everything',
    'tags: [render, smoke]',
    '---',
    '',
    '# Heading one',
    '',
    'A paragraph with **bold**, *italic*, `code`, a [link](https://example.com) and a wikilink to [[Other]].',
    '',
    '## Heading two',
    '',
    'Second paragraph, the one with a comment: review this sentence with care.',
    '',
    '### Heading three',
    '',
    '* A bullet',
    '* Another bullet',
    '',
    '- A dash',
    '- Another dash',
    '',
    '1. First',
    '2. Second',
    '',
    'Between the lists.',
    '',
    'a. Alpha',
    'b. Beta',
    '',
    '- [ ] A task',
    '- [x] A task done',
    '',
    '- Outer',
    '  - Inner',
    '    - Deeper',
    '',
    '> A quotation, one line long.',
    '',
    '> [!note] A callout',
    '> With a body of its own.',
    '',
    '| Column A | Column B |',
    '| --- | --- |',
    '| cell | cell |',
    '',
    '```ts',
    'const answer = 42',
    '```',
    '',
    '$$',
    'E = mc^2',
    '$$',
    '',
    '![A picture|200](pic.png)',
    '',
    'A footnote reference[^1].',
    '',
    '[^1]: The footnote itself.',
    '',
    '---',
    '',
    'The last paragraph.',
    '',
].join('\n')

// A 1×1 PNG: an image the note can show.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))

const FILES: Record<string, string | Uint8Array> = {
    'Everything.md': NOTE,
    'Other.md': '# Other\n',
    'pic.png': PNG,
    'comments/Everything/alice 2026-09-13 12.01.md': '![[Everything#:~:text=review%20this%20sentence]]\n\nIs it right?\n',
}

/** The theme as the demo's screenshot script sets it: the attribute on the root, the code blocks told. */
function setTheme(theme: Theme, editor?: MarkdownEditor) {
    document.documentElement.setAttribute('data-theme', theme)
    editor?.commands.setCodeblockTheme({ dark: theme === 'dark' })
}

async function open(width: number, theme: Theme) {
    setTheme(theme)
    const made = await openVault(FILES, {
        path: 'Everything.md',
        identity: 'theo',
        autoSave: true,
        size: { width, height: 700, scroll: true },
        services: ['resolver', 'index', 'search', 'files', 'comments'],
    })
    const { editor, container } = made
    setTheme(theme, editor)
    await settingsOf(editor)?.ready
    await waitFor(() => !!container.querySelector('.cm-editor') && !!container.querySelector('.ezco-mde-gutter .ezco-mde-block-icon'), 5000)
    // The picture arrives from the vault after the note: measured once it
    // has its size, so the blocks after it have their places.
    await waitFor(() => {
        const img = container.querySelector('img')
        return !!img && img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().height > 10
    }, 5000)
    await frames(3)
    return made
}

const margin = (c: HTMLElement) => c.querySelector('.ezco-mde-comment-margin') as HTMLElement
const glyphs = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.ezco-mde-gutter .ezco-mde-block-icon')]
/** `a` within `b`, to the pixel. */
const inside = (a: DOMRect, b: DOMRect) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1
const describeEl = (el: Element) => `${el.tagName.toLowerCase()}${[...el.classList].map((c) => `.${c}`).join('')}`

/** Everything of the editor that reaches past its container's sides
 *  (hidden things, the menus in their tippy roots and what has no box
 *  left out), named with its edges. */
function pastTheSides(container: HTMLElement): string[] {
    const box = container.getBoundingClientRect()
    const out: string[] = []
    for (const el of container.querySelectorAll('.ezco-mde, .ezco-mde *')) {
        if (el.closest('[hidden], [data-tippy-root]')) continue
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height) continue
        if (r.right > box.right + 1 || r.left < box.left - 1) out.push(`${describeEl(el)} ${Math.round(r.left)}–${Math.round(r.right)}`)
    }
    return out
}

/** Every colour the theme declares (each `--*` custom property in the
 *  editor's stylesheets that is a colour), as the browser computes it on
 *  the root and on the editor's wrapper in the theme now set; and
 *  transparent, which a surface on the note may be. */
function themeColours(container: HTMLElement): Set<string> {
    const names = new Set<string>()
    const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
            if (rule instanceof CSSStyleRule) for (let i = 0; i < rule.style.length; i++) if (rule.style.item(i).startsWith('--')) names.add(rule.style.item(i))
            if (rule instanceof CSSGroupingRule) walk(rule.cssRules)
        }
    }
    for (const sheet of Array.from(document.styleSheets)) {
        try {
            walk(sheet.cssRules)
        } catch {
            // A sheet from elsewhere: not readable, not the theme's.
        }
    }
    const probe = document.createElement('span')
    container.append(probe)
    const colours = new Set<string>(['rgba(0, 0, 0, 0)'])
    const wrapper = container.querySelector('.ezco-mde') as HTMLElement
    for (const name of names) {
        for (const el of [document.documentElement, wrapper]) {
            const value = getComputedStyle(el).getPropertyValue(name).trim()
            if (!value) continue
            probe.style.color = ''
            probe.style.color = value
            if (!probe.style.color) continue
            colours.add(getComputedStyle(probe).color)
        }
    }
    probe.remove()
    return colours
}

/** The computed colour and background of `el`, each asserted to be one of the theme's. */
function themed(el: Element | null, allowed: Set<string>, what: string): { color: string; background: string } {
    expect(el, what).not.toBeNull()
    const style = getComputedStyle(el!)
    const got = { color: style.color, background: style.backgroundColor }
    expect(allowed.has(got.color), `${what}: color ${got.color} is no token of the theme`).toBe(true)
    expect(allowed.has(got.background), `${what}: background ${got.background} is no token of the theme`).toBe(true)
    return got
}

/** How light a colour is (its channels' mean, 0 to 255), read through a probe so `#hex` and `rgb()` compare alike. */
function lightness(colour: string): number {
    const probe = document.createElement('span')
    document.body.append(probe)
    probe.style.color = colour
    const computed = getComputedStyle(probe).color
    probe.remove()
    const channels = computed.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? []
    if (channels.length !== 3) throw new Error(`not a colour: ${colour} (${computed})`)
    return (channels[0] + channels[1] + channels[2]) / 3
}

/** What light rendered as, for dark to differ from. */
const seen: Partial<Record<Theme, Record<string, string>>> = {}

describe('The note rendered, every block kind and a comment', () => {
    const cases: Array<[Theme, number]> = [['light', 1400], ['light', 1000], ['dark', 1400], ['dark', 1000]]
    for (const [theme, width] of cases) {
        const beside = width >= 1400
        it(`at ${width}px in ${theme}: glyphs on their lines, the panel ${beside ? 'beside the note' : 'floating'}, nothing past the host, the composer in its bubble, every colour a token`, async () => {
            await page.viewport(Math.max(1280, width + 100), 800)
            const { editor, container, comments } = await open(width, theme)
            const box = container.getBoundingClientRect()
            const note = editor.view.dom

            // ── Every block has its glyph, on its block's first line ──
            const blocks = [...note.children] as HTMLElement[]
            expect(glyphs(container).length).toBe(editor.state.doc.childCount)
            expect(blocks.length).toBe(editor.state.doc.childCount)
            const kinds = (editor.getJSON().content ?? []).map((b) => b.type)
            for (const kind of ['frontMatter', 'heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'callout', 'table', 'ezcodeBlock', 'mathBlock', 'horizontalRule']) {
                expect(kinds, `a ${kind} in the note`).toContain(kind)
            }
            expect(note.querySelector('img'), 'an image').not.toBeNull()
            expect(note.querySelector('a[href]'), 'a link').not.toBeNull()
            const misplaced = () => {
                const out: string[] = []
                glyphs(container).forEach((g, i) => {
                    if (g.classList.contains('is-active')) return
                    const block = blocks[i].getBoundingClientRect()
                    const top = g.getBoundingClientRect().top
                    if (top < block.top - 1 || top >= block.top + Math.max(block.height, 20)) out.push(`${kinds[i]}: glyph at ${top.toFixed(1)}, block ${block.top.toFixed(1)}–${block.bottom.toFixed(1)}`)
                })
                return out
            }
            // (Placed again as the blocks settle: given a moment, then held to.)
            await waitFor(() => misplaced().length === 0, 2000).catch(() => undefined)
            expect(misplaced()).toEqual([])
            // Glyphs stand in the gutter's column, none past it.
            const gutter = (container.querySelector('.ezco-mde-gutter') as HTMLElement).getBoundingClientRect()
            for (const g of glyphs(container)) {
                const r = g.getBoundingClientRect()
                if (!r.width) continue
                expect(r.left, 'a glyph in the gutter').toBeGreaterThanOrEqual(gutter.left - 1)
                expect(r.right, 'a glyph in the gutter').toBeLessThanOrEqual(gutter.right + 1)
            }

            // ── The gutter meets the note; the comments where there is room ──
            const noteBox = note.getBoundingClientRect()
            expect(Math.abs(gutter.right - noteBox.left)).toBeLessThan(1)
            const annotations = (container.querySelector('.ezco-mde-annotations') as HTMLElement).getBoundingClientRect()
            expect(annotations.left).toBeGreaterThanOrEqual(noteBox.right - 1)
            if (beside) {
                await waitFor(() => margin(container).classList.contains('is-panel') && !margin(container).hidden, 3000)
                await frames(3)
                const panel = margin(container).getBoundingClientRect()
                expect(annotations.right).toBeLessThanOrEqual(panel.left + 1)
                expect(panel.left).toBeGreaterThanOrEqual(noteBox.right)
                expect(panel.right).toBeLessThanOrEqual(box.right + 1)
                // The note keeps its measure beside the panel.
                expect(noteBox.width).toBeCloseTo(parseFloat(getComputedStyle(note.parentElement!).maxWidth), 0)
                await waitFor(() => container.querySelectorAll('.ezco-mde-comment-card:not([hidden])').length === 1, 3000)
            } else {
                await waitFor(() => margin(container).classList.contains('is-floating') || margin(container).classList.contains('is-overlay'), 3000)
                expect(margin(container).classList.contains('is-panel')).toBe(false)
                expect(noteBox.width).toBeGreaterThan(400)
            }
            // The comment's mark in the annotation column, on its line.
            const mark = container.querySelector('.ezco-mde-annotations .ezco-mde-comment-mark') as HTMLElement
            expect(mark).not.toBeNull()
            const commented = editor.view.coordsAtPos(comments.comments()[0].target.range!.from)
            expect(mark.getBoundingClientRect().top).toBeGreaterThanOrEqual(commented.top - 2)
            expect(mark.getBoundingClientRect().top).toBeLessThan(commented.bottom)

            // ── Nothing wider than the host ──
            expect(pastTheSides(container)).toEqual([])

            // ── The composer: its buttons in its bubble ──
            const { from, to } = rangeOf(editor, 'review this sentence')
            editor.commands.setTextSelection({ from, to })
            editor.commands.startComment()
            await waitFor(() => !!container.querySelector('.ezco-mde-comment-card.is-draft .ezco-mde-comment-text'), 3000)
            const draft = container.querySelector('.ezco-mde-comment-card.is-draft') as HTMLElement
            const cancel = [...draft.querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement
            const post = draft.querySelector('.ezco-mde-comment-button.is-primary') as HTMLButtonElement
            expect(cancel).not.toBeUndefined()
            expect(post?.textContent).toBe('Comment')
            await waitFor(() => post.getBoundingClientRect().width > 0 && draft.style.top !== '', 3000)
            const bubble = cancel.closest('.ezco-mde-comment-bubble') as HTMLElement
            expect(bubble).not.toBeNull()
            expect(post.closest('.ezco-mde-comment-bubble')).toBe(bubble)
            expect(inside(cancel.getBoundingClientRect(), bubble.getBoundingClientRect()), 'Cancel in the bubble').toBe(true)
            expect(inside(post.getBoundingClientRect(), bubble.getBoundingClientRect()), 'Comment in the bubble').toBe(true)
            // Over the note, by its text, in every layout.
            expect(note.parentElement!.contains(draft)).toBe(true)
            expect(draft.getBoundingClientRect().top).toBeGreaterThanOrEqual(editor.view.coordsAtPos(to, -1).bottom - 1)
            expect(pastTheSides(container)).toEqual([])

            // ── Colours: every surface one of the theme's tokens ──
            const allowed = themeColours(container)
            const root = getComputedStyle(document.documentElement)
            const tokens = { bg: root.getPropertyValue('--ezco-mde-bg').trim(), fg: root.getPropertyValue('--ezco-mde-fg').trim() }
            expect(tokens.bg).not.toBe('')
            expect(tokens.fg).not.toBe('')
            const colours: Record<string, string> = { bg: tokens.bg, fg: tokens.fg }
            const record = (what: string, got: { color: string; background: string }) => {
                colours[`${what} color`] = got.color
                colours[`${what} background`] = got.background
            }
            record('note', themed(note, allowed, 'the note'))
            record('wrapper', themed(container.querySelector('.ezco-mde'), allowed, 'the editor'))
            record('composer bubble', themed(bubble, allowed, 'the composer bubble'))
            record('composer field', themed(draft.querySelector('.ezco-mde-comment-text'), allowed, 'the composer field'))
            themed(post, allowed, 'the Comment button')
            themed(cancel, allowed, 'the Cancel button')
            if (beside) {
                record('panel head', themed(margin(container).querySelector('.ezco-mde-comment-margin-head'), allowed, 'the panel head'))
                record('card bubble', themed(container.querySelector('.ezco-mde-comment-card:not(.is-draft) .ezco-mde-comment-bubble'), allowed, 'a card bubble'))
            }
            const toolbar = container.querySelector('.ezco-mde-toolbar')
            record('toolbar', themed(toolbar, allowed, 'the toolbar'))
            record('toolbar input', themed(toolbar!.querySelector('.cm-toolbar-input'), allowed, 'the toolbar input'))
            // A code block's editor, not the front matter's (folded, that one
            // has no surface of its own by design).
            const code = container.querySelector('.ezco-mde-body > .cm-editor') as HTMLElement
            colours['code background'] = getComputedStyle(code).backgroundColor
            cancel.click()
            await waitFor(() => !container.querySelector('.ezco-mde-comment-card.is-draft'), 3000)
            // The slash menu, opened as a person does: `/` on a new line.
            editor.commands.focus('end')
            await frames(2)
            await userEvent.keyboard('{Enter}/')
            await waitFor(() => !!document.querySelector('.ezco-mde-slash-menu'), 3000)
            record('slash menu', themed(document.querySelector('.ezco-mde-slash-menu'), allowed, 'the slash menu'))
            await userEvent.keyboard('{Escape}')
            await waitFor(() => !document.querySelector('.ezco-mde-slash-menu'), 3000)

            // ── Dark differs from light, through the tokens ──
            if (theme === 'light') {
                seen.light = colours
            } else {
                const light = seen.light!
                expect(colours.bg).not.toBe(light.bg)
                expect(colours.fg).not.toBe(light.fg)
                for (const what of ['note color', 'composer bubble background', 'toolbar background', 'slash menu background', 'slash menu color', 'code background']) {
                    expect(colours[what], `${what} in dark should differ from light's ${light[what]}`).not.toBe(light[what])
                }
                // Darker surfaces, lighter text: the code blocks flipped with the note.
                for (const what of ['bg', 'composer bubble background', 'toolbar background', 'slash menu background', 'code background']) {
                    expect(lightness(colours[what]), `${what} in dark (${colours[what]}) should be darker than light's ${light[what]}`).toBeLessThan(lightness(light[what]))
                }
                for (const what of ['fg', 'note color', 'slash menu color']) {
                    expect(lightness(colours[what]), `${what} in dark (${colours[what]}) should be lighter than light's ${light[what]}`).toBeGreaterThan(lightness(light[what]))
                }
            }
        }, 30000)
    }
})
