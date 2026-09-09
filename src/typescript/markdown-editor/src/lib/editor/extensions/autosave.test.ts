import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
import { FileSystem } from './filesystem'

/**
 * Autosave + file-navigation race.
 *
 * Repro of the reported bug: with `autoSave: true`, opening a second file
 * (test.md → README.md) could write the *newly loaded* file's content to the
 * *previous* file's path — the debounced save fired against a stale filepath.
 */

type Files = Record<string, string>

function makeMockFs(initial: Files) {
    const files: Files = { ...initial }
    const writes: Array<{ path: string; data: string }> = []
    const fs: any = {
        readFile: async (p: string) => {
            if (!(p in files)) throw new Error('ENOENT: ' + p)
            return files[p]
        },
        writeFile: async (p: string, data: string) => {
            files[p] = data
            writes.push({ path: p, data })
        },
        // Unused by these tests, but VfsInterface-shaped so nothing throws.
        watch: async function* () {},
        mkdir: async () => {},
        readDir: async () => [],
        exists: async (p: string) => p in files,
        stat: async () => ({}),
        unlink: async (p: string) => { delete files[p] },
    }
    return { fs, files, writes }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

function makeEditor(fs: any, filepath: string, autoSave: boolean) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const editor = new Editor({
        element: el,
        extensions: [
            StarterKit,
            Markdown.configure({ html: false }),
            FileSystem.configure({ fs, filepath, autoSave }),
        ],
    })
    return { editor, el }
}

describe('FileSystem autosave / file navigation', () => {
    let editor: Editor | undefined
    let el: HTMLElement | undefined
    afterEach(() => {
        editor?.destroy()
        el?.remove()
        editor = undefined
        el = undefined
    })

    it('does not write the newly-opened file content to the previous file path', async () => {
        const { fs, files, writes } = makeMockFs({ 'test.md': '# Test\n', 'README.md': '# Readme\n' })
        ;({ editor, el } = makeEditor(fs, 'test.md', true))
        await tick(150) // initial load of test.md settles

        // Replicate a file open: swap in the new content, then point the
        // persistence layer at the new path (the order the toolbar uses).
        const readme = await fs.readFile('README.md')
        editor!.commands.setContent(readme)
        ;(editor!.storage as any).persistence.options.filepath = 'README.md'

        await tick(700) // let the 500ms debounced autosave fire

        // The bug writes README's content into test.md.
        expect(writes.some((w) => w.path === 'test.md' && /Readme/.test(w.data))).toBe(false)
        expect(files['test.md']).toBe('# Test\n')
    })

    it('flushes unsaved edits to the outgoing file before loading the next', async () => {
        const { fs, files } = makeMockFs({ 'test.md': '# Test\n', 'README.md': '# Readme\n' })
        ;({ editor, el } = makeEditor(fs, 'test.md', true))
        await tick(150)

        // Edit test.md (schedules a debounced save) then immediately navigate.
        editor!.commands.setContent('# Test edited\n')
        await (editor!.storage as any).persistence.loadFile('README.md')
        await tick(50)

        // The outgoing edit must be persisted to test.md — not lost, and never
        // written to README.
        expect(files['test.md']).toMatch(/Test edited/)
        expect(files['test.md']).not.toMatch(/Readme/)
        expect(files['README.md']).toBe('# Readme\n')
    })

    it('autosaves edits to the newly opened file, not the previous one', async () => {
        const { fs, files } = makeMockFs({ 'test.md': '# Test\n', 'README.md': '# Readme\n' })
        ;({ editor, el } = makeEditor(fs, 'test.md', true))
        await tick(150)

        await (editor!.storage as any).persistence.loadFile('README.md')
        editor!.commands.setContent('# Readme edited\n') // edit the now-current file
        await tick(700)

        expect(files['README.md']).toMatch(/Readme edited/)
        expect(files['test.md']).toBe('# Test\n') // untouched
    })
})
