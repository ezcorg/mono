import { describe, it, expect } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { AllSelection, TextSelection } from '@tiptap/pm/state'
import { MarkdownEditor, MarkdownEditorOptions } from './index'
import { clip as clipOn, type ClipPayload, frames, getMarkdownContent, posOf, trackEditors, waitFor } from '../../test/utils'

/**
 * The clipboard, through the events themselves (`copy`, `cut`, `paste` with
 * a real `DataTransfer`), since every handler on the way reads the event:
 * tiptap-markdown's serializer is given a clipboard slice on copy (its
 * top-level parent a Fragment, not the document) and a failure in it leaves
 * the browser to copy the DOM's text instead, code blocks' gutters and all;
 * on paste, `MarkdownBlockPaste`, the link's paste handler, the image
 * attachments and ProseMirror's own HTML and text branches each look at the
 * payload and decide whether the paste is theirs.
 */

// A 1×1 PNG.
const PNG = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
)

const editors = trackEditors()
const open = (content: string, options: Partial<MarkdownEditorOptions> = {}) => editors.make(content, options).editor

/** An editor mounted (Tiptap mounts after a tick) with the caret at its end. */
async function opened(content: string) {
    const editor = open(content)
    await frames(1)
    editor.commands.focus('end')
    return editor
}

async function inVault(files: Record<string, string | Uint8Array>, path: string) {
    const { editor, fs } = await editors.openVault(files, { path, content: '', services: ['resolver'] })
    await frames(1)
    return { editor, fs }
}

/** A clipboard event on the editable (`target` unless given), and what is on the clipboard after. */
const clip = (editor: MarkdownEditor, kind: 'copy' | 'cut' | 'paste', payload: ClipPayload = {}, target: Element = editor.view.dom) => clipOn(target, kind, payload)

/** What a copy of the current selection puts on the clipboard. */
const copied = (editor: MarkdownEditor) => clip(editor, 'copy')

const select = (editor: MarkdownEditor, from: number, to: number) =>
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))

/** The word `text`, selected. */
const selectWord = (editor: MarkdownEditor, text: string) => {
    const from = posOf(editor, text)
    select(editor, from, from + text.length)
}

const kinds = (editor: MarkdownEditor) => editor.state.doc.content.content.map((node) => node.type.name)

/** The marks on the first text node reading `text`, by name. */
const marksOn = (editor: MarkdownEditor, text: string) => {
    let marks: Array<{ type: string; attrs: Record<string, unknown> }> = []
    editor.state.doc.descendants((node) => {
        if (node.isText && node.text === text && !marks.length) marks = node.marks.map((m) => ({ type: m.type.name, attrs: m.attrs }))
    })
    return marks
}

describe('Copy', () => {
    it('copies a selection that ends at the start of the next paragraph as Markdown', () => {
        const editor = open('First **bold** para\n\nSecond para')
        const from = posOf(editor, 'First')
        const to = posOf(editor, 'Second')
        select(editor, from, to)
        const { handled, text } = copied(editor)
        expect(handled).toBe(true)
        expect(text).toBe('First **bold** para')
    })

    it('copies everything, the empty paragraph the caret rests in included', () => {
        const editor = open('# Title\n\nA line.\n\n```js\nlet x = 1\n```')
        // Enter at the end leaves an empty paragraph after the code.
        editor.commands.focus('end')
        editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, editor.schema.nodes.paragraph.create()))
        editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
        const { handled, text } = copied(editor)
        expect(handled).toBe(true)
        expect(text).toBe('# Title\n\nA line.\n\n```js\nlet x = 1\n```')
    })

    it('keeps spacing paragraphs inside a selection', () => {
        const editor = open('A\n\n&nbsp;\n\nB')
        editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
        expect(copied(editor).text).toBe('A\n\n \n\nB')
    })

    it('puts the selection on the clipboard as Markdown text and as HTML', () => {
        const editor = open('First **bold** [para](https://example.com/p)\n\nSecond para')
        select(editor, posOf(editor, 'First'), posOf(editor, 'Second'))
        const { handled, text, html } = copied(editor)
        expect(handled).toBe(true)
        expect(text).toBe('First **bold** [para](https://example.com/p)')
        // The HTML is the nodes as the editor renders them, so another editor
        // takes the marks; ProseMirror notes the slice's depth on the first.
        expect(html).toMatch(/^<p[^>]*data-pm-slice="/)
        expect(html).toContain('<strong>bold</strong>')
        expect(html).toContain('href="https://example.com/p"')
        expect(html).toContain('>para</a>')
    })

    it('leaves the note as it was', () => {
        const editor = open('Nothing *moves*.')
        selectWord(editor, 'moves')
        expect(copied(editor).text).toBe('*moves*')
        expect(getMarkdownContent(editor)).toBe('Nothing *moves*.')
        expect(editor.state.selection.from).toBe(posOf(editor, 'moves'))
        expect(editor.state.selection.to).toBe(posOf(editor, 'moves') + 'moves'.length)
    })
})

describe('Cut', () => {
    it('cuts the selection as Markdown and takes it out of the note', async () => {
        const editor = await opened('Keep **this**, drop *that*.')
        const from = posOf(editor, ', drop')
        select(editor, from, posOf(editor, '.'))
        const { handled, text, html } = clip(editor, 'cut')
        expect(handled).toBe(true)
        expect(text).toBe(', drop *that*')
        expect(html).toContain('<em>that</em>')
        expect(getMarkdownContent(editor)).toBe('Keep **this**.')
        // The caret stands where the cut text was.
        expect(editor.state.selection.empty).toBe(true)
        expect(editor.state.selection.from).toBe(from)
    })

    it('cuts a selected block out whole', async () => {
        const editor = await opened('# Title\n\n* one\n* two\n\nAfter.')
        // The list, selected as a node (what the block menu selects).
        editor.commands.setNodeSelection(posOf(editor, 'one') - 3)
        expect(editor.state.selection.constructor.name).toBe('NodeSelection')
        const { handled, text, html } = clip(editor, 'cut')
        expect(handled).toBe(true)
        expect(text).toBe('* one\n* two')
        expect(html).toMatch(/^<ul/)
        expect(getMarkdownContent(editor)).toBe('# Title\n\nAfter.')
        expect(kinds(editor)).toEqual(['heading', 'paragraph'])
    })

    it('does nothing with an empty selection', async () => {
        const editor = await opened('Stay.')
        const { handled, text } = clip(editor, 'cut')
        expect(handled).toBe(false)
        expect(text).toBe('')
        expect(getMarkdownContent(editor)).toBe('Stay.')
    })
})

describe('Paste', () => {
    it('pastes plain text, a newline in it a line break', async () => {
        const editor = await opened('')
        const { handled } = clip(editor, 'paste', { text: 'line one\nline two' })
        expect(handled).toBe(true)
        expect(kinds(editor)).toEqual(['paragraph'])
        expect(editor.state.doc.firstChild!.content.content.map((n) => n.type.name)).toEqual(['text', 'hardBreak', 'text'])
        // A hard break is written with a backslash before the newline.
        expect(getMarkdownContent(editor)).toBe('line one\\\nline two')
    })

    it('pastes plain text with blank lines as paragraphs', async () => {
        const editor = await opened('')
        // As a browser delivers text copied from a plain field: the text,
        // and its own wrapper for HTML.
        const text = 'One.\nstill one\n\nTwo.\n\n\nThree.'
        const { handled } = clip(editor, 'paste', { text, html: `<meta charset="utf-8">${text.replace(/\n/g, '<br>')}` })
        expect(handled).toBe(true)
        expect(kinds(editor)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph'])
        expect(editor.state.doc.content.content.map((n) => n.textContent)).toEqual(['One.still one', 'Two.', '', 'Three.'])
        // The newline inside the first paragraph is a hard break (no text of its own).
        expect(editor.state.doc.firstChild!.content.content.map((n) => n.type.name)).toEqual(['text', 'hardBreak', 'text'])
        expect(getMarkdownContent(editor)).toBe('One.\\\nstill one\n\nTwo.\n\n \n\nThree.')
    })

    it('pastes plain text into the middle of a paragraph, around the caret', async () => {
        const editor = await opened('Before after.')
        editor.commands.setTextSelection(posOf(editor, ' after'))
        clip(editor, 'paste', { text: ' then' })
        expect(getMarkdownContent(editor)).toBe('Before then after.')
        expect(editor.state.selection.from).toBe(posOf(editor, ' after'))
    })

    it('pastes Markdown as blocks: a heading, a list and a fence', async () => {
        const editor = await opened('')
        const md = '# Title\n\n* one\n* two\n\n```js\nlet x = 1\n```'
        const { handled } = clip(editor, 'paste', { text: md })
        expect(handled).toBe(true)
        // The empty paragraph the paste landed in stays after the fence, the
        // caret's place past it (a slice ending in a fence or a list cannot
        // take the rest of a paragraph).
        expect(kinds(editor)).toEqual(['heading', 'bulletList', 'ezcodeBlock', 'paragraph'])
        expect(editor.state.doc.lastChild!.textContent).toBe('')
        const [heading, list, code] = editor.state.doc.content.content
        expect(heading.attrs.level).toBe(1)
        expect(heading.textContent).toBe('Title')
        expect(list.childCount).toBe(2)
        expect(list.child(1).textContent).toBe('two')
        expect(code.attrs.language).toBe('js')
        expect(code.textContent).toBe('let x = 1')
        expect(getMarkdownContent(editor)).toBe(md)
    })

    it('pastes Markdown after text, the first block joining the paragraph', async () => {
        const editor = await opened('Intro')
        clip(editor, 'paste', { text: 'more\n\n> quoted\n\n1. first\n2. second' })
        expect(kinds(editor)).toEqual(['paragraph', 'blockquote', 'orderedList', 'paragraph'])
        expect(getMarkdownContent(editor)).toBe('Intromore\n\n> quoted\n\n1. first\n2. second')
    })

    it('pastes inline Markdown as marks', async () => {
        const editor = await opened('')
        clip(editor, 'paste', { text: 'Some **bold**, *italic* and `code` with [a link](https://example.com/).' })
        expect(kinds(editor)).toEqual(['paragraph'])
        expect(marksOn(editor, 'bold')).toEqual([{ type: 'bold', attrs: {} }])
        expect(marksOn(editor, 'italic')).toEqual([{ type: 'italic', attrs: {} }])
        expect(marksOn(editor, 'code')).toEqual([{ type: 'code', attrs: {} }])
        expect(marksOn(editor, 'a link').map((m) => [m.type, m.attrs.href])).toEqual([['link', 'https://example.com/']])
        expect(getMarkdownContent(editor)).toBe('Some **bold**, *italic* and `code` with [a link](https://example.com/).')
    })

    it('pastes HTML: bold, a link and a list as marks and blocks', async () => {
        const editor = await opened('')
        const { handled } = clip(editor, 'paste', {
            text: 'Some bold and a link\n\none\ntwo',
            html: '<meta charset="utf-8"><p>Some <b>bold</b> and <a href="https://example.com/">a link</a></p><ul><li>one</li><li>two</li></ul>',
        })
        expect(handled).toBe(true)
        expect(kinds(editor)).toEqual(['paragraph', 'bulletList', 'paragraph'])
        expect(marksOn(editor, 'bold')).toEqual([{ type: 'bold', attrs: {} }])
        expect(marksOn(editor, 'a link').map((m) => [m.type, m.attrs.href])).toEqual([['link', 'https://example.com/']])
        const list = editor.state.doc.child(1)
        expect(list.childCount).toBe(2)
        expect(list.child(0).type.name).toBe('listItem')
        expect(list.child(0).firstChild!.type.name).toBe('paragraph')
        expect(getMarkdownContent(editor)).toBe('Some **bold** and [a link](https://example.com/)\n\n* one\n* two')
    })

    it('pastes HTML headings and quotes as blocks, not the Markdown of the text payload', async () => {
        const editor = await opened('')
        // A rich copy from a web page: the text side reads like Markdown
        // would, but the HTML is the source of the blocks.
        clip(editor, 'paste', { text: '# Not a heading\n\n> Not a quote', html: '<h2>Real heading</h2><blockquote><p>Real quote</p></blockquote>' })
        expect(kinds(editor)).toEqual(['heading', 'blockquote', 'paragraph'])
        expect(editor.state.doc.firstChild!.attrs.level).toBe(2)
        expect(getMarkdownContent(editor)).toBe('## Real heading\n\n> Real quote')
    })

    it('pastes a URL onto a selection as its link', async () => {
        const editor = await opened('Read the docs today')
        selectWord(editor, 'docs')
        const { handled } = clip(editor, 'paste', { text: 'https://example.com/docs' })
        expect(handled).toBe(true)
        expect(marksOn(editor, 'docs').map((m) => [m.type, m.attrs.href])).toEqual([['link', 'https://example.com/docs']])
        expect(getMarkdownContent(editor)).toBe('Read the [docs](https://example.com/docs) today')
        // The selection is kept, the link on it.
        expect(editor.state.selection.from).toBe(posOf(editor, 'docs'))
        expect(editor.state.selection.to).toBe(posOf(editor, 'docs') + 4)
    })

    it('pastes a URL with nothing selected as a link to itself, written as an autolink', async () => {
        const editor = await opened('')
        clip(editor, 'paste', { text: 'https://example.com/docs' })
        expect(marksOn(editor, 'https://example.com/docs').map((m) => [m.type, m.attrs.href])).toEqual([['link', 'https://example.com/docs']])
        expect(getMarkdownContent(editor)).toBe('<https://example.com/docs>')
    })

    it('pastes text that is not a URL over a selection, replacing it', async () => {
        const editor = await opened('Read the docs today')
        selectWord(editor, 'docs')
        clip(editor, 'paste', { text: 'manual' })
        expect(getMarkdownContent(editor)).toBe('Read the manual today')
    })

    it('pastes into a code block as text, through CodeMirror, Markdown markers and all', async () => {
        const editor = await opened('```js\nlet x = 1\n```')
        await waitFor(() => !!editor.view.dom.querySelector('.cm-content'), 3000)
        const content = editor.view.dom.querySelector('.cm-content') as HTMLElement
        const before = kinds(editor)
        expect(before[0]).toBe('ezcodeBlock')
        // Pasted where CodeMirror's cursor is (the start of the code), with
        // both payloads as a browser would send them: only the text counts.
        const { handled } = clip(editor, 'paste', { text: '# not a heading\n* not a list\n', html: '<h1>not a heading</h1><ul><li>not a list</li></ul>' }, content)
        expect(handled).toBe(true)
        await waitFor(() => editor.state.doc.firstChild!.textContent.startsWith('# not a heading'), 3000)
        // No heading or list was made of it: the blocks are as they were.
        expect(kinds(editor)).toEqual(before)
        expect(editor.state.doc.firstChild!.textContent).toBe('# not a heading\n* not a list\nlet x = 1')
        expect(content.textContent).toBe('# not a heading* not a listlet x = 1')
        expect(getMarkdownContent(editor)).toBe('```js\n# not a heading\n* not a list\nlet x = 1\n```')
    })

    it('pastes an image into the vault’s attachments and links it from the note', async () => {
        const { editor, fs } = await inVault({ 'notes/n.md': 'Before. After.' }, 'notes/n.md')
        editor.commands.setTextSelection(posOf(editor, ' After'))
        const { handled } = clip(editor, 'paste', { files: [new File([PNG], 'shot.png', { type: 'image/png' })] })
        expect(handled).toBe(true)
        await waitFor(() => getMarkdownContent(editor).includes('!['), 3000)
        const files = (await fs.readDir('attachments')).map(([name]) => name)
        expect(files).toHaveLength(1)
        expect(files[0]).toMatch(/^shot-[0-9a-f]{8}\.png$/)
        expect([...(await fs.readBytes(`attachments/${files[0]}`))]).toEqual([...PNG])
        const image = editor.state.doc.nodeAt(posOf(editor, 'Before.') + 'Before.'.length)!
        expect(image.type.name).toBe('image')
        expect(image.attrs.src).toBe(`../attachments/${files[0]}`)
        expect(image.attrs.alt).toBe('shot')
        expect(getMarkdownContent(editor)).toBe(`Before.![shot](../attachments/${files[0]}) After.`)
    })

    it('leaves an image paste to the browser when the note is not in a vault', async () => {
        const editor = await opened('No vault.')
        const { handled } = clip(editor, 'paste', { files: [new File([PNG], 'shot.png', { type: 'image/png' })] })
        expect(handled).toBe(false)
        await frames(1)
        expect(getMarkdownContent(editor)).toBe('No vault.')
    })
})

describe('Copy and paste through the browser’s clipboard', () => {
    it('round-trips a selection with its marks by ⌘C and ⌘V', async () => {
        const editor = await opened('Copy **me** [now](https://example.com/)\n\nEnd')
        editor.commands.focus('start')
        // The first paragraph, to its end (two past it is the start of the next).
        select(editor, posOf(editor, 'Copy'), posOf(editor, 'End') - 2)
        await userEvent.copy()
        editor.commands.focus('end')
        await userEvent.keyboard('{Enter}')
        expect(editor.state.doc.childCount).toBe(3)
        await userEvent.paste()
        await waitFor(() => getMarkdownContent(editor).endsWith('End\n\nCopy **me** [now](https://example.com/)'), 3000)
        expect(editor.state.doc.childCount).toBe(3)
        expect(getMarkdownContent(editor)).toBe('Copy **me** [now](https://example.com/)\n\nEnd\n\nCopy **me** [now](https://example.com/)')
        expect(marksOn(editor, 'me')).toEqual([{ type: 'bold', attrs: {} }])
    })
})
