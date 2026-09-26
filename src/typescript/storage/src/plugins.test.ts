import { describe, expect, it } from 'vitest'
import { memoryVfs } from './memory.js'
import { PluginHost, readManifest, type Capability, type Granter } from './plugins.js'

const MANIFEST = `
id = "ezco.snippets"
name = "Snippets"
version = "0.1.0"
description = "Things one types often."

[[wants]]
kind = "icanhaz:nocap/inference"
[wants.scope]
when = "true"
allow = 'call.args.request.model == "echo"'

[[wants]]
kind = "icanhaz:nocap/net"

[[contributes.slash-commands]]
title = "Signature"
description = "Sign off"
insert = "— Theo"

[[contributes.themes]]
name = "Paper"
[contributes.themes.variables]
"--ezco-mde-bg" = "#fbf8f1"
"--cm-background" = "#f5f1e6"
`

/** Grants what it is told to, and remembers what it was asked. */
function granter(allowed: string[]) {
    const asked: Capability[] = []
    const g: Granter = {
        async request(capability) {
            asked.push(capability)
            return allowed.includes(capability.kind) ? { kind: capability.kind, token: `grant-for-${capability.kind}` } : null
        },
    }
    return { granter: g, asked }
}

describe('Plugin manifests', () => {
    it('read what a plugin wants and contributes, a missing scope being a plain grant', () => {
        const manifest = readManifest(MANIFEST)
        expect(manifest).toMatchObject({ id: 'ezco.snippets', name: 'Snippets', version: '0.1.0' })
        expect(manifest.wants).toEqual([
            { kind: 'icanhaz:nocap/inference', scope: { when: 'true', allow: 'call.args.request.model == "echo"' } },
            { kind: 'icanhaz:nocap/net', scope: { when: 'true', allow: 'true' } },
        ])
        expect(manifest.contributes.slashCommands).toEqual([{ title: 'Signature', description: 'Sign off', insert: '— Theo' }])
        expect(manifest.contributes.themes[0].variables).toEqual({ '--ezco-mde-bg': '#fbf8f1', '--cm-background': '#f5f1e6' })
    })

    it('refuse what they cannot hold', () => {
        expect(() => readManifest('name = "x"\nversion = "1"')).toThrow(/id/)
        expect(() => readManifest('id = "x"\nname = "x"\nversion = "1"\n[[wants]]\nkind = ""')).toThrow(/kind/)
        // A theme sets the editor's variables and nothing else.
        const bad = (name: string, value: string) =>
            `id = "x"\nname = "x"\nversion = "1"\n[[contributes.themes]]\nname = "t"\n[contributes.themes.variables]\n"${name}" = "${value}"`
        expect(() => readManifest(bad('color', 'red'))).toThrow(/variable/)
        expect(() => readManifest(bad('--ezco-mde-bg', 'url(https://evil.example/x)'))).toThrow(/value/)
        expect(() => readManifest(bad('--ezco-mde-bg', 'red; } body { display: none'))).toThrow(/value/)
    })
})

describe('The plugin host', () => {
    it('asks for each thing a plugin wants, and gives it only what was granted', async () => {
        const { granter: g, asked } = granter(['icanhaz:nocap/inference'])
        const host = new PluginHost(memoryVfs(), g)
        const plugin = await host.install(MANIFEST)
        expect(asked.map((c) => c.kind)).toEqual(['icanhaz:nocap/inference', 'icanhaz:nocap/net'])
        expect(plugin.provider.get('icanhaz:nocap/inference')).toEqual({ kind: 'icanhaz:nocap/inference', token: 'grant-for-icanhaz:nocap/inference' })
        // Refused, and never wanted: nothing.
        expect(plugin.provider.get('icanhaz:nocap/net')).toBeUndefined()
        expect(plugin.provider.get('icanhaz:nocap/fs')).toBeUndefined()
        expect(plugin.provider.granted()).toEqual(['icanhaz:nocap/inference'])
    })

    it('keeps the installed set in the vault, pinned by hash, and loads it again', async () => {
        const fs = memoryVfs()
        const first = new PluginHost(fs, granter(['icanhaz:nocap/inference']).granter)
        const installed = await first.install(MANIFEST)
        expect(installed.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
        expect(await fs.readFile('.vault/plugins.toml')).toContain(installed.hash)

        const again = new PluginHost(fs, granter(['icanhaz:nocap/inference']).granter)
        const loaded = await again.load()
        expect(loaded.map((p) => [p.manifest.id, p.hash])).toEqual([['ezco.snippets', installed.hash]])
        // A manifest changed behind the host is not trusted under the old hash.
        await fs.writeFile(`.vault/plugins/${installed.hash.slice('sha256:'.length)}/manifest.toml`, MANIFEST.replace('Theo', 'someone else'))
        expect(await new PluginHost(fs, granter([]).granter).load()).toEqual([])
    })

    it('gathers what installed plugins contribute, and forgets a plugin removed', async () => {
        const host = new PluginHost(memoryVfs(), granter([]).granter)
        await host.install(MANIFEST)
        expect(host.contributions().slashCommands.map((c) => c.title)).toEqual(['Signature'])
        expect(host.contributions().themes.map((t) => t.name)).toEqual(['Paper'])
        await host.uninstall('ezco.snippets')
        expect(host.contributions()).toEqual({ slashCommands: [], themes: [] })
    })
})
