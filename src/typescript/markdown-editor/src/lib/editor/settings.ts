/**
 * The editor's settings: what a reader may choose over the editor's own
 * choices, kept as files (`@joinezco/config`) in the vault the editor is
 * over, in scopes (everywhere, this device, this editor instance), YAML by
 * default. A setting exists wherever the editor's preference over a range
 * of choices might not be the reader's: declare it here (the schema), with
 * its default and a line saying what it does, and read it where the
 * choice is made through `settingsOf(editor)`, so a change in a file (or
 * from the toolbar's settings mode) reaches the feature at once.
 *
 * The schema is the source of the quick UI (the toolbar's `settings`
 * entries, built from `fields()`), of `schema.json` beside the files, and
 * of the completion and checking the settings file gets when opened as
 * code (`settings-file.ts`).
 */
import { Extension, type Editor } from '@tiptap/core'
import { Config, defaultsOf, deviceId, fromZod, z, type ConfigFiles, type Format, type Scope } from '@joinezco/config'
import { localFiles } from './settings-memory'
import { persistenceOf } from './extensions/filesystem'

export const EditorSettingsSchema = z.object({
    editor: z
        .object({
            font: z.string().default('').describe('The face the note is set in (a CSS font-family); empty for the editor’s own, Source Serif 4.'),
            measure: z.number().min(20).max(120).default(38).describe('How wide the note’s text column is, in ems of its text size.'),
        })
        .meta({ title: 'The note' }),
    comments: z
        .object({
            panel: z.boolean().default(true).describe('Show every comment in a panel beside the note, where there is room.'),
            anchored: z.boolean().default(false).describe('Keep each comment level with its text, scrolling with the note, rather than in a list of its own.'),
            showResolved: z.boolean().default(false).describe('Keep resolved comments in the panel.'),
            openOnClick: z.boolean().default(false).describe('A click on commented text looks at its comment (the mark beside the note always does).'),
            step: z.number().min(0).max(64).default(32).describe('How far a comment in the panel steps out towards its text as the note is read past it, in pixels.'),
            inline: z.boolean().default(true).describe('Open a comment within the note, under the text it is about, so what follows moves down; off, it floats over the note.'),
        })
        .meta({ title: 'Comments' }),
    frontMatter: z
        .object({
            collapsed: z.boolean().default(true).describe('Fold a note’s properties (its front matter) to one line until opened.'),
        })
        .meta({ title: 'Properties' }),
})

export type EditorSettings = z.infer<typeof EditorSettingsSchema>

/** The schema as JSON Schema: `schema.json` beside the files, and what the
 *  settings file is checked and completed against when opened as code. */
export const editorSettingsJsonSchema = fromZod(EditorSettingsSchema, { title: 'Editor settings', description: 'What the editor does by default, and what you would rather it did.' })

export interface SettingsOptions {
    /** Where the files are kept: the editor's own filesystem by default. */
    fs?: ConfigFiles
    /** Whose settings (an identity): the comments' author by default. */
    user?: string
    /** This device's name; `deviceId()` (kept in this browser) by default.
     *  `false` for no device scope. */
    device?: string | false
    /** The host's name for this editor instance, for settings that are its
     *  alone; without one there is no instance scope. */
    instance?: string
    /** The folder, vault-relative (`.settings`). */
    root?: string
    /** What a new file is written as (`yaml`). */
    format?: Format
    /** Where a choice made from the editor's own chrome (the panel's
     *  switches) goes: the device by default, so a choice made on a laptop
     *  stays the laptop's. */
    chromeScope?: Scope
}

/** A dotted path into the settings (`comments.openOnClick`). */
export type SettingPath =
    | 'editor.font'
    | 'editor.measure'
    | 'comments.panel'
    | 'comments.anchored'
    | 'comments.showResolved'
    | 'comments.openOnClick'
    | 'comments.step'
    | 'comments.inline'
    | 'frontMatter.collapsed'

type At<P extends string> = P extends `${infer H}.${infer R}` ? (H extends keyof EditorSettings ? At2<EditorSettings[H], R> : never) : never
type At2<O, R extends string> = R extends keyof O ? O[R] : never

export interface SettingsStorage {
    /** The value at `path`, the files laid over the defaults (the defaults
     *  alone until the files are read). */
    get<P extends SettingPath>(path: P): At<P>
    /** The value at `path` someone chose (in any scope's file), or
     *  undefined: for a feature whose own default is the host's to give. */
    chosen<P extends SettingPath>(path: P): At<P> | undefined
    /** Set a value in a scope's file (`chromeScope` by default). */
    set<P extends SettingPath>(path: P, value: At<P>, scope?: Scope): Promise<void>
    /** Hear every change, from the files or from here. */
    subscribe(listener: () => void): () => void
    /** The store, once the files are read. */
    config: Config<EditorSettings> | null
    /** Resolves once the files are read. */
    ready: Promise<void>
    /** The scope a choice from the chrome goes to. */
    chromeScope: Scope
    /** The schema as JSON Schema. */
    schema: typeof editorSettingsJsonSchema
    /** Whether `path` is one of the settings files (the editor opens it
     *  as code with the schema's help). */
    isSettingsFile(path: string): boolean
    /** The file a scope's settings are in. */
    file(scope: Scope): string | null
    scopes(): Scope[]
}

/** The editor's settings, or null in an editor made without them. */
export function settingsOf(editor: Editor): SettingsStorage | null {
    const s = (editor.storage as unknown as Record<string, unknown>).settings as SettingsStorage | undefined
    return s && typeof s.get === 'function' ? s : null
}

/** The editor's own choices: what every setting is until a file says otherwise. */
const defaults = defaultsOf(editorSettingsJsonSchema) as EditorSettings

function getAt(value: unknown, path: string): unknown {
    let at: unknown = value
    for (const key of path.split('.')) {
        if (typeof at !== 'object' || at === null) return undefined
        at = (at as Record<string, unknown>)[key]
    }
    return at
}

export const Settings = Extension.create<SettingsOptions, SettingsStorage>({
    name: 'settings',

    addOptions() {
        return { fs: undefined, user: undefined, device: undefined, instance: undefined, root: undefined, format: undefined, chromeScope: 'device' }
    },

    addStorage() {
        // (Tiptap copies what is returned here: the methods reach the
        // store through `this`, the copy, never through a closure.)
        const listeners = new Set<() => void>()
        const storage: SettingsStorage & { notify(): void } = {
            config: null,
            ready: Promise.resolve(),
            chromeScope: 'device',
            schema: editorSettingsJsonSchema,
            get(path) {
                return (this.config ? this.config.get(path) : getAt(defaults, path)) as never
            },
            chosen(path) {
                return this.config?.chosen(path) as never
            },
            async set(path, value, scope) {
                if (!this.config) await this.ready
                if (!this.config) return
                const to = scope ?? this.chromeScope
                await this.config.set(path, value, this.config.scopes().includes(to) ? to : 'global')
            },
            subscribe(listener) {
                listeners.add(listener)
                return () => listeners.delete(listener)
            },
            isSettingsFile(path) {
                const root = this.config?.root ?? '.settings'
                const clean = path.replace(/^\/+/, '')
                return clean === root || clean.startsWith(`${root}/`)
            },
            file(scope) {
                return this.config?.file(scope) ?? null
            },
            scopes() {
                return this.config?.scopes() ?? ['global']
            },
            notify() {
                for (const l of listeners) l()
            },
        }
        return storage
    },

    onBeforeCreate() {
        const storage = this.storage
        const options = this.options
        storage.chromeScope = options.chromeScope ?? 'device'
        const fs = options.fs ?? (persistenceOf(this.editor)?.options.fs as ConfigFiles | undefined)
        const notify = () => (storage as SettingsStorage & { notify(): void }).notify()
        storage.ready = (async () => {
            const files: ConfigFiles = fs ?? localFiles()
            const config = await Config.open<EditorSettings>({
                fs: files,
                schema: editorSettingsJsonSchema,
                user: options.user ?? ((this.editor.storage as Record<string, any>).comments?.author?.() as string | null | undefined) ?? undefined,
                device: options.device === false ? undefined : options.device ?? deviceId(),
                instance: options.instance,
                root: options.root,
                format: options.format,
                // Nothing of the editor's writes into a vault it was not given.
                writeSchema: !!fs,
            })
            if (this.editor.isDestroyed) {
                config.close()
                return
            }
            storage.config = config
            config.subscribe(notify)
            notify()
        })().catch((error) => {
            console.warn('[Settings] The settings could not be read', error)
        })
    },

    onCreate() {
        // The note's face and measure: the tokens set on the editor's root
        // when a choice differs from the editor's own.
        const storage = this.storage
        const editor = this.editor
        const apply = () => {
            if (editor.isDestroyed) return
            const root = (editor.view.dom.closest('.ezco-mde') as HTMLElement | null) ?? editor.view.dom
            const font = storage.get('editor.font')
            root.style.setProperty('--ezco-mde-font', font || '')
            const measure = storage.get('editor.measure')
            root.style.setProperty('--ezco-mde-measure', measure === 38 ? '' : `calc(var(--ezco-mde-text-base) * ${measure})`)
        }
        apply()
        storage.subscribe(apply)
    },

    onDestroy() {
        this.storage.config?.close()
        this.storage.config = null
    },
})

// ── The toolbar's settings mode ─────────────────────────────────────────

import type { SettingsEntry } from '@joinezco/codeblock'
import { humanize } from '@joinezco/config'

const SCOPE_LABELS: Record<Scope, string> = { global: 'everywhere', device: 'this device', instance: 'this editor' }

/** The scope entry's key, and the file's. */
export const SCOPE_KEY = '$scope'
export const FILE_KEY = '$file'

/** The toolbar's settings entries: the scope a change goes to, every field
 *  (a switch, a choice to cycle, a value to type), and the file to open. */
export function settingsEntries(settings: SettingsStorage, scope: Scope, filter: string): SettingsEntry[] {
    const q = filter.trim().toLowerCase()
    const entries: SettingsEntry[] = []
    const scopes = settings.scopes()
    if (scopes.length > 1) entries.push({ id: `Change settings for: ${SCOPE_LABELS[scope]}`, settingKey: SCOPE_KEY, type: 'settings-cycle', icon: '\u2B6E', currentValue: scope })
    for (const field of settings.config?.fields() ?? []) {
        const value = settings.get(field.path as SettingPath) as unknown
        const name = [...field.group, field.label].join(' › ')
        if (q && !`${name} ${field.description ?? ''}`.toLowerCase().includes(q)) continue
        if (field.kind === 'boolean') entries.push({ id: `${name}: ${value ? 'on' : 'off'}`, settingKey: field.path, type: 'settings-toggle', icon: value ? '\u2713' : '\u2717', currentValue: String(value) })
        else if (field.kind === 'enum') entries.push({ id: `${name}: ${field.options?.find((o) => o.value === value)?.label ?? String(value)}`, settingKey: field.path, type: 'settings-cycle', icon: '\u21BB', currentValue: String(value) })
        else entries.push({ id: `${name}: ${value === '' ? 'default' : String(value)}`, settingKey: field.path, type: 'settings-input', icon: field.kind === 'number' ? '#' : 'Aa', currentValue: String(value ?? '') })
    }
    const file = settings.file(scope)
    if (file && (!q || 'open settings file'.includes(q))) entries.push({ id: `Open the settings file (${file})`, settingKey: FILE_KEY, type: 'settings-action', icon: '\u2261', currentValue: file })
    return entries
}

/** A switch flipped or a choice cycled from the toolbar (the scope entry
 *  gives the next scope; a value to type is left to `confirmSettingsInput`). */
export async function applySettingsEntry(settings: SettingsStorage, scope: Scope, entry: SettingsEntry): Promise<Scope> {
    if (entry.settingKey === SCOPE_KEY) {
        const scopes = settings.scopes()
        return scopes[(scopes.indexOf(scope) + 1) % scopes.length]
    }
    const field = settings.config?.fields().find((f) => f.path === entry.settingKey)
    if (!field) return scope
    const path = field.path as SettingPath
    if (field.kind === 'boolean') await settings.set(path, !settings.get(path) as never, scope)
    else if (field.kind === 'enum' && field.options?.length) {
        const at = field.options.findIndex((o) => o.value === settings.get(path))
        await settings.set(path, field.options[(at + 1) % field.options.length].value as never, scope)
    }
    return scope
}

/** A value typed for a setting in the toolbar: a number checked against
 *  the field's bounds, text as it is; empty takes the choice away. */
export async function confirmSettingsInput(settings: SettingsStorage, scope: Scope, key: string, raw: string): Promise<boolean> {
    const field = settings.config?.fields().find((f) => f.path === key)
    if (!field) return false
    const path = field.path as SettingPath
    if (!raw.trim()) {
        await settings.config?.unset(path, scope)
        return true
    }
    if (field.kind === 'number') {
        const n = Number(raw)
        if (!Number.isFinite(n) || (field.integer && !Number.isInteger(n))) return false
        if ((field.minimum !== undefined && n < field.minimum) || (field.maximum !== undefined && n > field.maximum)) return false
        await settings.set(path, n as never, scope)
        return true
    }
    await settings.set(path, raw as never, scope)
    return true
}

export { humanize }
