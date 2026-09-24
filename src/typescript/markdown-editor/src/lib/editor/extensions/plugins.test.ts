import { describe, it, expect, afterEach } from 'vitest'
import { userEvent } from '@vitest/browser/context'
import { PluginHost, memoryVfs } from '@joinezco/storage'
import { createEditor, MarkdownEditor } from '../index'
import { createTestContainer, cleanupEditor, getMarkdownContent, waitFor } from '../../../test/utils'

const created: Array<{ editor: MarkdownEditor; container: HTMLElement }> = []
afterEach(() => {
    created.forEach(({ editor, container }) => cleanupEditor(editor, container))
    created.length = 0
})

const MANIFEST = `
id = "ezco.snippets"
name = "Snippets"
version = "0.1.0"

[[contributes.slash-commands]]
title = "Signature"
description = "Sign off"
insert = "— Theo"

[[contributes.themes]]
name = "Paper"
[contributes.themes.variables]
"--ezco-mde-bg" = "#fbf8f1"
`

describe('Plugin contributions in the editor', () => {
    it('adds a plugin’s slash commands, which insert their text', async () => {
        const host = new PluginHost(memoryVfs(), { request: async () => null })
        await host.install(MANIFEST)
        const container = createTestContainer('plugins')
        const editor = createEditor({ element: container, content: 'Thanks,', plugins: host.contributions() })
        created.push({ editor, container })
        await userEvent.click(editor.view.dom)
        editor.commands.focus('end')
        await userEvent.keyboard(' /Signa')
        await waitFor(() => [...document.querySelectorAll('.ezco-mde-slash-item-title')].some((t) => t.textContent === 'Signature'), 3000)
        await userEvent.keyboard('{Enter}')
        expect(getMarkdownContent(editor)).toBe('Thanks, — Theo')
    })

    it('applies a chosen theme’s variables to the editor', async () => {
        const host = new PluginHost(memoryVfs(), { request: async () => null })
        await host.install(MANIFEST)
        const container = createTestContainer('plugins-theme')
        const [paper] = host.contributions().themes
        const editor = createEditor({ element: container, content: 'x', plugins: { theme: paper } })
        created.push({ editor, container })
        const wrapper = container.querySelector('.ezco-mde') as HTMLElement
        expect(wrapper.style.getPropertyValue('--ezco-mde-bg')).toBe('#fbf8f1')
    })
})
