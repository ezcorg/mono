import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { memoryVfs } from '@joinezco/storage'
import { Vault } from '@joinezco/vault'
import { getJSONSchema } from 'codemirror-json-schema'
import { createEditor, settingsOf, MarkdownEditor } from './index'
import { createTestContainer, cleanupEditor, waitFor } from '../../test/utils'

/**
 * The reader's settings: files in the vault over the editor's own
 * choices, read as they change; the toolbar's settings mode made from the
 * schema; the file opened as code with the schema's help.
 */

const created: Array<{ editor: MarkdownEditor; container: HTMLElement; vault: Vault }> = []
afterEach(() => {
    created.forEach(({ editor, container, vault }) => {
        cleanupEditor(editor, container)
        vault.close()
    })
    created.length = 0
    for (const key of Object.keys(localStorage)) if (key.startsWith('ezco-mde-') || key.startsWith('ezco-settings:')) localStorage.removeItem(key)
})

const NOTE = '# Note\n\nSome text to comment on, and more of it after.\n'
const COMMENT = ['comments/Note/alice 2026-09-13 12.01.md', '![[Note#:~:text=text%20to%20comment]]\n\nA comment.\n'] as const

async function open(files: Record<string, string>, extra: Record<string, unknown> = {}) {
    const vault = await Vault.open(memoryVfs(files), { identity: 'theo' })
    const container = createTestContainer(`settings-${created.length}`)
    container.style.width = '1100px'
    const editor = createEditor({
        element: container,
        fs: { fs: vault.fs, filepath: 'Note.md', autoSave: true },
        links: { resolver: vault.links, index: vault.links },
        search: vault.search,
        files: vault.files,
        comments: { author: 'theo', index: vault.comments, reactions: vault.reactions },
        settings: { instance: 'test' },
        ...extra,
    })
    created.push({ editor, container, vault })
    await waitFor(() => editor.getText().includes('Some text'), 3000)
    const settings = settingsOf(editor)!
    await settings.ready
    return { editor, container, vault, settings }
}

const root = (editor: MarkdownEditor) => editor.view.dom.closest('.ezco-mde') as HTMLElement
const input = (c: HTMLElement) => c.querySelector('.cm-toolbar-input') as HTMLInputElement
const results = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.cm-search-result')]
const labels = (c: HTMLElement) => results(c).map((r) => r.querySelector('.cm-search-result-label')?.textContent ?? '')
const entry = (c: HTMLElement, text: string) => results(c).find((r) => r.textContent?.includes(text))

describe('Settings', () => {
    it('reads the schema’s defaults, a file in the vault over them (the face, the measure, a comment’s click), and the file again as it changes', async () => {
        const { editor, vault, settings } = await open({
            'Note.md': NOTE,
            [COMMENT[0]]: COMMENT[1],
            '.settings/theo/global.yaml': 'editor:\n  font: Georgia, serif\n  measure: 30\ncomments:\n  openOnClick: true\n',
        })
        expect(settings.get('editor.font')).toBe('Georgia, serif')
        expect(settings.get('comments.openOnClick')).toBe(true)
        expect(settings.chosen('comments.step')).toBeUndefined()
        expect(settings.get('comments.step')).toBe(32)
        expect(settings.get('comments.anchored')).toBe(false)
        expect(settings.scopes()).toEqual(['global', 'device', 'instance'])
        expect(settings.file('instance')).toBe('.settings/theo/instances/test.yaml')
        // The schema beside the files, for other editors.
        // (The schema goes beside the files once one is written.)
        await settings.set('comments.step', 24, 'instance')
        await waitFor(async () => vault.fs.exists('.settings/schema.json'), 3000)
        expect(JSON.parse(await vault.fs.readFile('.settings/schema.json')).title).toBe('Editor settings')
        expect(settings.get('comments.step')).toBe(24)
        // The note set in the chosen face, at the chosen measure.
        // (The editor's own face lists Georgia as a fallback: the chosen one leads.)
        await waitFor(() => getComputedStyle(editor.view.dom).fontFamily.startsWith('Georgia'), 2000)
        const host = editor.view.dom.parentElement as HTMLElement
        // (The measure is in `--ezco-mde-text-base`, which may be in rems.)
        const base = () => {
            const v = getComputedStyle(host).getPropertyValue('--ezco-mde-text-base').trim()
            return v.endsWith('rem') ? parseFloat(v) * parseFloat(getComputedStyle(document.documentElement).fontSize) : parseFloat(v)
        }
        expect(getComputedStyle(host).maxWidth).toBe(`${base() * 30}px`)
        // A click on the commented text looks at the comment, as the file asks.
        const comments = (editor.storage as any).comments
        await waitFor(() => comments.comments().length === 1 && comments.comments()[0].target.range, 3000)
        const r = comments.comments()[0].target.range
        const at = editor.view.coordsAtPos(r.from + 2)
        const box = editor.view.dom.getBoundingClientRect()
        await userEvent.click(editor.view.dom, { position: { x: at.left - box.left, y: at.top - box.top + 4 } })
        await waitFor(() => comments.active() === comments.comments()[0].id, 2000)
        // The file changed by hand (or by a sync): the editor follows.
        await vault.fs.writeFile('.settings/theo/global.yaml', 'editor:\n  measure: 40\n')
        await waitFor(() => settings.get('editor.measure') === 40, 3000)
        expect(settings.get('editor.font')).toBe('')
        await waitFor(() => getComputedStyle(editor.view.dom).fontFamily.startsWith('"Source Serif 4"'), 2000)
        expect(getComputedStyle(host).maxWidth).toBe(`${base() * 40}px`)
        // A value the file gets wrong is left out, and the editor's own stands.
        await vault.fs.writeFile('.settings/theo/global.yaml', 'editor:\n  measure: 400\n')
        await waitFor(() => settings.config!.problems().length === 1, 3000)
        expect(settings.get('editor.measure')).toBe(38)
    })

    it('offers the settings in the toolbar: switches, choices and values, in a chosen scope, and the file to open as code with its schema', async () => {
        const { editor, container, vault, settings } = await open({ 'Note.md': NOTE })
        await userEvent.click(input(container))
        await userEvent.clear(input(container))
        // (`setting` is enough: the toolbar enters its settings mode on it.)
        await userEvent.type(input(container), 'setting')
        await waitFor(() => labels(container).some((l) => l.startsWith('Change settings for')), 3000)
        expect(input(container).value).toBe('settings/')
        // The scope first (the device, where a choice from the chrome goes),
        // then every setting of the schema, grouped, then the file.
        expect(labels(container)[0]).toBe('Change settings for: this device')
        expect(labels(container)).toContain('Comments › Open on click: off')
        expect(labels(container)).toContain('The note › Measure: 38')
        expect(labels(container)).toContain('Properties › Collapsed: on')
        expect(labels(container).at(-1)).toBe(`Open the settings file (${settings.file('device')})`)
        // A switch flipped: the device's file has it, and the entry says so.
        entry(container, 'Open on click: off')!.click()
        await waitFor(() => settings.get('comments.openOnClick') === true, 2000)
        await waitFor(() => labels(container).includes('Comments › Open on click: on'), 2000)
        const deviceFile = settings.file('device')!
        await waitFor(async () => (await vault.fs.exists(deviceFile)) && (await vault.fs.readFile(deviceFile)).includes('openOnClick: true'), 3000)
        expect(await vault.fs.exists('.settings/theo/global.yaml')).toBe(false)
        // The scope cycled (the device, this editor, everywhere, round
        // again): a value typed then goes to the global file.
        entry(container, 'Change settings for')!.click()
        await waitFor(() => labels(container)[0] === 'Change settings for: this editor', 2000)
        entry(container, 'Change settings for')!.click()
        await waitFor(() => labels(container)[0] === 'Change settings for: everywhere', 2000)
        entry(container, 'Measure: 38')!.click()
        await waitFor(() => input(container).value === '38', 2000)
        await userEvent.clear(input(container))
        await userEvent.type(input(container), '30{Enter}')
        await waitFor(() => settings.get('editor.measure') === 30, 2000)
        await waitFor(() => labels(container).includes('The note › Measure: 30'), 2000)
        await waitFor(async () => (await vault.fs.exists('.settings/theo/global.yaml')) && (await vault.fs.readFile('.settings/theo/global.yaml')).includes('measure: 30'), 3000)
        expect(settings.chosen('editor.measure')).toBe(30)
        // Out of range: refused, the setting as it was.
        entry(container, 'Measure: 30')!.click()
        await waitFor(() => input(container).value === '30', 2000)
        await userEvent.clear(input(container))
        await userEvent.type(input(container), '500{Enter}')
        await new Promise((r) => setTimeout(r, 200))
        expect(settings.get('editor.measure')).toBe(30)
        // Narrowed by what is typed after `settings/`.
        await userEvent.clear(input(container))
        await userEvent.type(input(container), 'settings/anch')
        await waitFor(() => labels(container).filter((l) => !l.startsWith('Change') && !l.startsWith('Open')).join() === 'Comments › Anchored: off', 2000)
        // The file, opened as code: the YAML in a code view with the
        // schema (completion and checking) and the note's chrome put away.
        await userEvent.clear(input(container))
        await userEvent.type(input(container), 'setting')
        await waitFor(() => !!entry(container, 'Open the settings file'), 3000)
        entry(container, 'Open the settings file')!.click()
        const persistence = (editor.storage as any).persistence
        await waitFor(() => persistence.options.filepath === '.settings/theo/global.yaml' && !!persistence.codeView, 4000)
        expect(root(editor).classList.contains('ezco-mde--code-file')).toBe(true)
        const code = persistence.codeView as { state: unknown; dom: HTMLElement; dispatch: (tr: unknown) => void }
        expect(code.dom.textContent).toContain('measure: 30')
        await waitFor(() => (getJSONSchema(code.state as never) as { title?: string } | void)?.title === 'Editor settings', 4000)
        expect(input(container).value).toBe('.settings/theo/global.yaml')
        // A wrong value typed is marked by the schema's check.
        const text = (code as unknown as { state: { doc: { toString(): string } } }).state.doc.toString()
        code.dispatch({ changes: { from: text.length, insert: '\ncomments:\n  step: "wide"\n' } })
        await waitFor(() => !!code.dom.querySelector('.cm-lintRange, .cm-lintRange-error, .cm-lintPoint'), 6000)
    })

    it('keeps the panel’s choices and the fold as settings; without settings, in this browser as before', async () => {
        const { container, vault, settings } = await open({ 'Note.md': NOTE, [COMMENT[0]]: COMMENT[1] })
        const margin = () => container.querySelector('.ezco-mde-comment-margin') as HTMLElement
        await waitFor(() => !!margin()?.classList.contains('is-panel'), 3000)
        // Anchored by the file: the panel becomes a column, level with the text.
        await vault.fs.mkdir('.settings/theo', { recursive: true })
        await vault.fs.writeFile('.settings/theo/global.yaml', 'comments:\n  anchored: true\n  step: 8\n')
        await waitFor(() => settings.get('comments.anchored') === true, 3000)
        await waitFor(() => !margin().classList.contains('is-panel') && !margin().classList.contains('is-floating'), 3000)
        expect(getComputedStyle(margin()).getPropertyValue('--ezco-mde-comment-step').trim()).toBe('8px')
        // Put away from the file: nothing beside the note.
        await vault.fs.writeFile('.settings/theo/global.yaml', 'comments:\n  anchored: true\n  panel: false\n')
        await waitFor(() => margin().classList.contains('is-floating'), 3000)

        // Without settings, the choice is this browser's, as it was.
        const plain = await Vault.open(memoryVfs({ 'Note.md': NOTE, [COMMENT[0]]: COMMENT[1] }), { identity: 'theo' })
        const box = createTestContainer(`settings-${created.length}`)
        box.style.width = '1100px'
        const editor = createEditor({
            element: box,
            fs: { fs: plain.fs, filepath: 'Note.md' },
            comments: { author: 'theo', index: plain.comments, reactions: plain.reactions },
            settings: false,
        })
        created.push({ editor, container: box, vault: plain })
        expect(settingsOf(editor)).toBeNull()
        await waitFor(() => !!box.querySelector('.ezco-mde-comment-margin')?.classList.contains('is-panel'), 3000)
        editor.commands.toggleCommentsPanel()
        await waitFor(() => localStorage.getItem('ezco-mde-comments-panel') === 'float', 2000)
        expect(await plain.fs.exists('.settings')).toBe(false)
    })
})
