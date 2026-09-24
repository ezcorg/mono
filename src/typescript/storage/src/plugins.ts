/**
 * Plugins (RFC §7): one capability model whatever runs the plugin.
 *
 * A plugin's manifest (`manifest.toml`) says what it wants, as capabilities
 * named by their WIT path with an optional scope (`when` and `allow`, CEL;
 * absent means a plain grant), and what it contributes. The host asks for
 * each want through a `Granter` (icanhaz's consent, or the app's own), and
 * the plugin gets a provider whose getters return a capability only if it
 * was granted: what was refused, or never wanted, is simply not there.
 *
 * The installed set is a document in the vault (`.eznote/plugins.toml`),
 * each manifest kept beside it and pinned by its sha256, so a synced vault
 * cannot swap one silently: a manifest that no longer matches its hash is
 * not loaded.
 *
 * Declarative contributions (§7.1) need no code: slash commands that insert
 * text, and themes, which set the editor's variables (`--ezco-mde-*`,
 * `--cm-*`) and nothing else. Code plugins (an iframe page, a component)
 * receive the provider through their bridge; those bridges come later.
 */
import { parse, stringify } from 'smol-toml'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import type { VfsInterface } from './vfs.js'
import { joinPath } from './path.js'

export interface Scope {
    /** Should the holder run at all (per event). */
    when: string
    /** May this call proceed (per call). */
    allow: string
}

/** A capability, named by its WIT path (`icanhaz:nocap/inference`). */
export interface Capability {
    kind: string
    scope: Scope
}

export interface SlashContribution {
    title: string
    description?: string
    /** The text the command puts in the note (Markdown). */
    insert: string
}

export interface ThemeContribution {
    name: string
    /** Values for the editor's variables, and only those. */
    variables: Record<string, string>
}

export interface PluginManifest {
    id: string
    name: string
    version: string
    description?: string
    wants: Capability[]
    contributes: { slashCommands: SlashContribution[]; themes: ThemeContribution[] }
}

/** Asks for a capability on a plugin's behalf: whatever the grant is (a
 *  token, a session), or null when refused. */
export interface Granter {
    request(capability: Capability, reason: string, plugin: PluginManifest): Promise<unknown | null>
}

/** What a plugin holds: a capability if it was granted, else nothing. */
export interface CapabilityProvider {
    get<T = unknown>(kind: string): T | undefined
    granted(): string[]
}

export interface InstalledPlugin {
    manifest: PluginManifest
    /** `sha256:` and the manifest's hash. */
    hash: string
    provider: CapabilityProvider
}

const VARIABLE = /^--(?:ezco-mde|cm)-[a-z0-9-]+$/
const UNSAFE_VALUE = /url\(|[;{}<>\\]|@import|expression\(/i

/** A manifest's text, checked: what it wants, what it contributes. */
export function readManifest(text: string): PluginManifest {
    const raw = parse(text) as Record<string, any>
    const str = (value: unknown, what: string) => {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`A plugin manifest needs ${what}`)
        return value
    }
    const wants = ((raw.wants ?? []) as any[]).map((want, i): Capability => ({
        kind: str(want?.kind, `a kind for want ${i + 1}`),
        scope: {
            when: typeof want?.scope?.when === 'string' ? want.scope.when : 'true',
            allow: typeof want?.scope?.allow === 'string' ? want.scope.allow : 'true',
        },
    }))
    const contributes = (raw.contributes ?? {}) as Record<string, any>
    const slashCommands = ((contributes['slash-commands'] ?? []) as any[]).map((c, i): SlashContribution => ({
        title: str(c?.title, `a title for slash command ${i + 1}`),
        ...(typeof c?.description === 'string' ? { description: c.description } : {}),
        insert: typeof c?.insert === 'string' ? c.insert : str(undefined, `text to insert for slash command ${i + 1}`),
    }))
    const themes = ((contributes.themes ?? []) as any[]).map((t, i): ThemeContribution => {
        const variables: Record<string, string> = {}
        for (const [name, value] of Object.entries((t?.variables ?? {}) as Record<string, unknown>)) {
            if (!VARIABLE.test(name)) throw new Error(`Theme ${i + 1} may set only the editor's variables (--ezco-mde-*, --cm-*), not ${name}`)
            if (typeof value !== 'string' || value.length > 200 || UNSAFE_VALUE.test(value)) {
                throw new Error(`Theme ${i + 1} has a value for ${name} that is not a plain CSS value`)
            }
            variables[name] = value
        }
        return { name: str(t?.name, `a name for theme ${i + 1}`), variables }
    })
    return {
        id: str(raw.id, 'an id'),
        name: str(raw.name, 'a name'),
        version: str(raw.version, 'a version'),
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
        wants,
        contributes: { slashCommands, themes },
    }
}

const encoder = new TextEncoder()
const hashOf = (text: string) => `sha256:${bytesToHex(sha256(encoder.encode(text)))}`

export interface PluginHostOptions {
    /** Where the log of what is installed lives (default `.eznote`). */
    dir?: string
}

export class PluginHost {
    private readonly dir: string
    private readonly installed = new Map<string, InstalledPlugin>()

    constructor(
        private readonly fs: VfsInterface,
        private readonly granter: Granter,
        options: PluginHostOptions = {},
    ) {
        this.dir = options.dir ?? '.eznote'
    }

    /** Install the plugin whose manifest is `text`: ask for what it wants,
     *  keep the manifest in the vault by its hash, and add it to the set. */
    async install(text: string): Promise<InstalledPlugin> {
        const manifest = readManifest(text)
        const hash = hashOf(text)
        const folder = this.manifestFolder(hash)
        if (!(await this.fs.exists(folder))) await this.fs.mkdir(folder, { recursive: true })
        await this.fs.writeFile(joinPath(folder, 'manifest.toml'), text)
        const plugin = await this.activate(manifest, hash)
        this.installed.set(manifest.id, plugin)
        await this.record()
        return plugin
    }

    /** The installed set, as the vault records it. A manifest that no longer
     *  matches its hash is left out. */
    async load(): Promise<InstalledPlugin[]> {
        this.installed.clear()
        const listing = await this.fs.readFile(joinPath(this.dir, 'plugins.toml')).catch(() => '')
        const entries = ((parse(listing || '') as { plugin?: { id: string; hash: string }[] }).plugin ?? []) as { id: string; hash: string }[]
        for (const entry of entries) {
            const text = await this.fs.readFile(joinPath(this.manifestFolder(entry.hash), 'manifest.toml')).catch(() => null)
            if (text === null || hashOf(text) !== entry.hash) continue
            const manifest = readManifest(text)
            this.installed.set(manifest.id, await this.activate(manifest, entry.hash))
        }
        return [...this.installed.values()]
    }

    async uninstall(id: string): Promise<void> {
        if (!this.installed.delete(id)) return
        await this.record()
    }

    plugins(): InstalledPlugin[] {
        return [...this.installed.values()]
    }

    /** What installed plugins contribute, together. */
    contributions(): PluginManifest['contributes'] {
        const plugins = this.plugins()
        return {
            slashCommands: plugins.flatMap((p) => p.manifest.contributes.slashCommands),
            themes: plugins.flatMap((p) => p.manifest.contributes.themes),
        }
    }

    private async activate(manifest: PluginManifest, hash: string): Promise<InstalledPlugin> {
        const grants = new Map<string, unknown>()
        for (const want of manifest.wants) {
            const grant = await this.granter.request(want, `${manifest.name} wants ${want.kind}`, manifest).catch(() => null)
            if (grant !== null && grant !== undefined) grants.set(want.kind, grant)
        }
        return {
            manifest,
            hash,
            provider: {
                get: <T>(kind: string) => grants.get(kind) as T | undefined,
                granted: () => [...grants.keys()],
            },
        }
    }

    private manifestFolder(hash: string): string {
        return joinPath(this.dir, 'plugins', hash.replace(/^sha256:/, ''))
    }

    private async record(): Promise<void> {
        const plugin = this.plugins().map((p) => ({ id: p.manifest.id, hash: p.hash }))
        if (!(await this.fs.exists(this.dir))) await this.fs.mkdir(this.dir, { recursive: true })
        await this.fs.writeFile(joinPath(this.dir, 'plugins.toml'), stringify({ plugin }))
    }
}
