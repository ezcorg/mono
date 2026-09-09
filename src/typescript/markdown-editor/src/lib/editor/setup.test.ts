import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import {
    createEditor,
    markdownSetup,
    minimalSetup,
    mountStyles,
    EmojiPicker,
    SlashCommands,
    SelectionMenu,
    LinkMenu,
    Toolbar,
    BlockActions,
    ExtendedCodeblock,
} from './index'
import { createTestContainer, removeTestContainer } from '../../test/utils'

/**
 * The CodeMirror-`basicSetup`-style API: `markdownSetup`/`minimalSetup` return
 * composable extension arrays, every feature is individually exported, and
 * `createEditor` is a thin wrapper over `markdownSetup`. These guard that the
 * decomposition stays faithful + tree-shakeable (opt-out actually drops units).
 */
describe('setup API', () => {
    let containers: HTMLElement[] = []
    const mount = () => {
        const c = createTestContainer(`setup-${containers.length}`)
        containers.push(c)
        return c
    }
    afterEach(() => {
        containers.forEach(removeTestContainer)
        containers = []
    })

    const names = (exts: { name: string }[]) => exts.map((e) => e.name)

    it('markdownSetup() returns a composable array that builds a working editor', () => {
        const exts = markdownSetup()
        expect(Array.isArray(exts)).toBe(true)
        const n = names(exts)
        expect(n).toContain(EmojiPicker.name)
        expect(n).toContain(SlashCommands.name)
        expect(n).toContain(Toolbar.name)

        mountStyles() // must not throw
        const editor = new Editor({ element: mount(), extensions: markdownSetup(), content: '' })
        editor.commands.setContent('**bold**')
        expect((editor.storage as any).markdown.getMarkdown()).toContain('bold')
        editor.destroy()
    })

    it('codeblock:false drops the heavy CodeMirror extension', () => {
        expect(names(markdownSetup())).toContain(ExtendedCodeblock.name)
        expect(names(markdownSetup({ codeblock: false }))).not.toContain(ExtendedCodeblock.name)
    })

    it('feature flags opt individual chrome out', () => {
        const n = names(markdownSetup({
            emoji: false,
            slashCommands: false,
            toolbar: false,
            blockActions: false,
            selectionMenu: false,
            linkMenu: false,
        }))
        for (const ext of [EmojiPicker, SlashCommands, Toolbar, BlockActions, SelectionMenu, LinkMenu]) {
            expect(n).not.toContain(ext.name)
        }
    })

    it('extra extensions are appended', () => {
        const before = markdownSetup().length
        expect(markdownSetup({ extensions: [SelectionMenu] }).length).toBe(before + 1)
    })

    it('minimalSetup() is lean — no chrome, no CodeMirror — but still round-trips markdown', () => {
        const n = names(minimalSetup())
        for (const ext of [EmojiPicker, SlashCommands, Toolbar, BlockActions, SelectionMenu, LinkMenu, ExtendedCodeblock]) {
            expect(n).not.toContain(ext.name)
        }
        expect(minimalSetup().length).toBeLessThan(markdownSetup().length)

        const editor = new Editor({ element: mount(), extensions: minimalSetup() })
        editor.commands.setContent('# Heading\n\nsome text')
        const md = (editor.storage as any).markdown.getMarkdown()
        expect(md).toContain('# Heading')
        editor.destroy()
    })

    it('createEditor still composes the full default set', () => {
        const editor = createEditor({ element: mount(), content: 'hi' })
        const n = editor.extensionManager.extensions.map((e) => e.name)
        expect(n).toContain(EmojiPicker.name)
        expect(n).toContain(Toolbar.name)
        expect(n).toContain(ExtendedCodeblock.name)
        editor.destroy()
    })
})
