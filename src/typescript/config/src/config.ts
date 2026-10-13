/**
 * Settings as files in a folder of any filesystem, read live.
 *
 * A schema (`schema.ts`) says what the settings are and what they are by
 * default. What a person chooses goes in files under a known folder
 * (`.settings` by default), one file per scope, YAML by default (or JSON):
 *
 *     .settings/schema.json                  what the files may say
 *     .settings/<user>/global.yaml           everywhere this user opens the vault
 *     .settings/<user>/devices/<device>.yaml on this device
 *     .settings/<user>/instances/<id>.yaml   in this editor instance (a host's name for it)
 *
 * (Without a user: the same, right under the folder.) A value in a more
 * specific scope wins over a less specific one, and any over the default.
 * The files are watched, so an edit made in any editor, or by a sync of
 * the folder from another device, reaches every reader; a value a file
 * gets wrong is left out, and reported, rather than read.
 *
 * Whose settings these are is the `user` who opens them. Another's
 * (`of`) can be read, and written only where that user's own global
 * file says so (`access: { editors: [name, …] }`, or `'*'`).
 */
import { Document, isMap, parseDocument, parse as parseYaml } from 'yaml'
import { check, defaultsOf, fieldsOf, getAt, isObject, merge, setAt, type Field, type Problem, type Schema } from './schema.js'

export type Scope = 'global' | 'device' | 'instance'
/** The scopes, least specific first. */
export const SCOPES: readonly Scope[] = ['global', 'device', 'instance']
export type Format = 'yaml' | 'json'

/** What the files are kept in: the part of `@joinezco/storage`'s
 *  `VfsInterface` settings need (any of its filesystems will do). */
export interface ConfigFiles {
    readFile(path: string): Promise<string>
    writeFile(path: string, data: string): Promise<void>
    exists(path: string): Promise<boolean>
    mkdir(path: string, options: { recursive: boolean }): Promise<void>
    watch?(path: string, options: { signal: AbortSignal }): AsyncIterable<{ filename: string }>
}

export interface ConfigOptions {
    fs: ConfigFiles
    schema: Schema
    /** Who is reading and writing (an identity). Without one the settings
     *  are the vault's own, under the folder itself. */
    user?: string
    /** Whose settings to open, when not one's own. */
    of?: string
    /** This device's name or id (`deviceId()`); without it there is no
     *  device scope. */
    device?: string
    /** The host's name for this editor instance; without it there is no
     *  instance scope. */
    instance?: string
    /** The folder, vault-relative (`.settings`). */
    root?: string
    /** What a new file is written as (`yaml`); an existing file keeps its kind. */
    format?: Format
    /** Keep `schema.json` in the folder, for other editors to validate the
     *  files against (on by default; written with the first file). */
    writeSchema?: boolean
}

export interface ScopeProblem extends Problem {
    scope: Scope
}

export class NotPermitted extends Error {
    constructor(user: string | undefined, of: string) {
        super(`${user ?? 'This vault'} may not change ${of}'s settings: ${of}'s global settings would have to say \`access: { editors: [${JSON.stringify(user ?? '*')}] }\``)
        this.name = 'NotPermitted'
    }
}

/** The reserved top-level setting: who else may edit these. */
const ACCESS: Schema = {
    type: 'object',
    title: 'Access',
    description: 'Who else may change these settings: names, or "*" for anyone.',
    properties: { editors: { type: 'array', items: { type: 'string' } } },
}

const EXTENSIONS: Record<Format, string> = { yaml: 'yaml', json: 'json' }
/** The file kinds read, in the order tried for a scope. */
const READ_EXTENSIONS = ['yaml', 'yml', 'json']

type Values = Record<string, unknown>

export class Config<T extends Values = Values> {
    /** The schema, with `access` among its properties. */
    readonly schema: Schema
    readonly defaults: T
    readonly root: string
    readonly user: string | undefined
    /** Whose settings these are. */
    readonly of: string | undefined
    readonly device: string | undefined
    readonly instance: string | undefined
    readonly format: Format
    private readonly fs: ConfigFiles
    private readonly files = new Map<Scope, { path: string; values: Values; text: string }>()
    private merged: T
    private problemList: ScopeProblem[] = []
    private readonly listeners = new Set<(config: Config<T>) => void>()
    private readonly stop = new AbortController()
    private reading: Promise<void> | null = null
    private writeSchema = true
    /** Writes, one after another: two sets of one file each see the other's. */
    private writing: Promise<unknown> = Promise.resolve()
    private again = false
    private timer: ReturnType<typeof setTimeout> | null = null

    private constructor(options: ConfigOptions) {
        this.fs = options.fs
        this.schema = withAccess(options.schema)
        this.defaults = defaultsOf(this.schema) as T
        this.root = (options.root ?? '.settings').replace(/\/+$/, '')
        this.user = options.user
        this.of = options.of ?? options.user
        this.device = options.device
        this.instance = options.instance
        this.format = options.format ?? 'yaml'
        this.merged = this.defaults
    }

    /** The settings read, and watched from here on. (Nothing is written
     *  by opening them: `schema.json` goes beside the files with the first
     *  file written.) */
    static async open<T extends Values = Values>(options: ConfigOptions): Promise<Config<T>> {
        const config = new Config<T>(options)
        config.writeSchema = options.writeSchema !== false
        await config.reload()
        config.watch()
        return config
    }

    /** The scopes there are: `global`, and `device` and `instance` when named. */
    scopes(): Scope[] {
        return SCOPES.filter((scope) => scope === 'global' || (scope === 'device' ? !!this.device : !!this.instance))
    }

    /** The folder a user's files are in. */
    private folder(): string {
        return this.of ? `${this.root}/${this.of}` : this.root
    }

    /** Where a scope's file goes when it is made. */
    private fileFor(scope: Scope, format = this.format): string | null {
        const ext = EXTENSIONS[format]
        if (scope === 'global') return `${this.folder()}/global.${ext}`
        if (scope === 'device') return this.device ? `${this.folder()}/devices/${this.device}.${ext}` : null
        return this.instance ? `${this.folder()}/instances/${this.instance}.${ext}` : null
    }

    /** The file a scope's values are in: the one there is, else the one a
     *  write would make. */
    file(scope: Scope): string | null {
        return this.files.get(scope)?.path ?? this.fileFor(scope)
    }

    /** Where the schema is kept beside the files. */
    get schemaFile(): string {
        return `${this.root}/schema.json`
    }

    /** Every value, the scopes laid over the defaults. */
    get(): T
    /** The value at a dotted `path` (`comments.openOnClick`). */
    get<V = unknown>(path: string): V
    get(path?: string): unknown {
        return path ? getAt(this.merged, path) : this.merged
    }

    /** What a scope's own file says (nothing from below it). */
    at(scope: Scope): Values {
        return this.files.get(scope)?.values ?? {}
    }

    /** What the files got wrong, if anything. */
    problems(): ScopeProblem[] {
        return this.problemList
    }

    /** The fields a generated UI shows (`access` is the file's alone). */
    fields(): Field[] {
        return fieldsOf(this.schema).filter((f) => f.path !== 'access' && !f.path.startsWith('access.'))
    }

    /** Whether `user` may write these settings. */
    async permitted(): Promise<boolean> {
        if (!this.of || this.of === this.user) return true
        const editors = getAt(this.at('global'), 'access.editors')
        return Array.isArray(editors) && editors.some((e) => e === '*' || e === this.user)
    }

    /** Set the value at `path` in `scope`'s file (`undefined` takes it out);
     *  the value is there to read at once, and in the file soon after. */
    set(path: string, value: unknown, scope: Scope = 'global'): Promise<void> {
        const next = this.writing.then(() => this.put(path, value, scope))
        this.writing = next.catch(() => undefined)
        return next
    }

    private async put(path: string, value: unknown, scope: Scope): Promise<void> {
        if (!(await this.permitted())) throw new NotPermitted(this.user, this.of!)
        const current = this.files.get(scope)
        const target = current?.path ?? this.fileFor(scope)
        if (!target) throw new Error(`There is no ${scope} scope here: no ${scope} was named`)
        const values = setAt(current?.values ?? {}, path, value)
        const text = this.serialize(target, current?.text, path, value)
        this.files.set(scope, { path: target, values, text })
        this.recompute()
        this.notify()
        await this.write(target, text)
    }

    /** `text` to `path`, its folder made, the schema beside the files. */
    private async write(path: string, text: string) {
        const dir = path.slice(0, path.lastIndexOf('/'))
        if (dir) await this.fs.mkdir(dir, { recursive: true })
        await this.fs.writeFile(path, text)
        if (this.writeSchema) await this.keepSchema().catch((error) => console.warn('[config] The schema could not be written beside the settings', error))
    }

    async unset(path: string, scope: Scope = 'global'): Promise<void> {
        return this.set(path, undefined, scope)
    }

    /** The scope's file, made (empty but for the schema's name) when there
     *  is none yet: for opening it to edit. Its path. */
    ensure(scope: Scope): Promise<string> {
        const next = this.writing.then(() => this.make(scope))
        this.writing = next.catch(() => undefined)
        return next
    }

    private async make(scope: Scope): Promise<string> {
        const have = this.files.get(scope)
        if (have) return have.path
        const target = this.fileFor(scope)
        if (!target) throw new Error(`There is no ${scope} scope here: no ${scope} was named`)
        if (!(await this.permitted())) throw new NotPermitted(this.user, this.of!)
        const text = this.serialize(target, undefined, '', undefined)
        this.files.set(scope, { path: target, values: {}, text })
        await this.write(target, text)
        return target
    }

    /** What the files say, laid over one another, without the defaults:
     *  the value at `path` someone chose, or undefined. */
    chosen(path: string): unknown {
        let merged: Values = {}
        for (const scope of SCOPES) {
            const file = this.files.get(scope)
            if (file) merged = merge(merged, file.values)
        }
        return getAt(merged, path)
    }

    /** Hear every change: a `set` here (at once), or the files (as read). */
    subscribe(listener: (config: Config<T>) => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    /** Read the files again (they are watched; this is for when they cannot be). */
    reload(): Promise<void> {
        if (this.reading) {
            this.again = true
            return this.reading
        }
        this.reading = (async () => {
            do {
                this.again = false
                await this.read()
            } while (this.again)
        })().finally(() => (this.reading = null))
        return this.reading
    }

    close() {
        this.stop.abort()
        if (this.timer) clearTimeout(this.timer)
        this.listeners.clear()
    }

    // ── Files ──────────────────────────────────────────────────────────

    private async read() {
        const was = JSON.stringify([...this.files.values()].map((f) => [f.path, f.values]))
        const files = new Map<Scope, { path: string; values: Values; text: string }>()
        const problems: ScopeProblem[] = []
        for (const scope of this.scopes()) {
            const found = await this.find(scope)
            if (!found) continue
            const { path, text } = found
            let raw: unknown
            try {
                raw = path.endsWith('.json') ? JSON.parse(text) : parseYaml(text)
            } catch (error) {
                problems.push({ scope, path: '', message: `${path} could not be read: ${(error as Error).message}` })
                files.set(scope, { path, values: {}, text })
                continue
            }
            const checked = check(this.schema, raw ?? {}, '')
            problems.push(...checked.problems.map((p) => ({ scope, ...p })))
            files.set(scope, { path, values: (isObject(checked.value) ? checked.value : {}) as Values, text })
        }
        this.files.clear()
        for (const [scope, file] of files) this.files.set(scope, file)
        this.problemList = problems
        this.recompute()
        if (JSON.stringify([...this.files.values()].map((f) => [f.path, f.values])) !== was) this.notify()
    }

    /** The file a scope has, of any kind. */
    private async find(scope: Scope): Promise<{ path: string; text: string } | null> {
        const base = this.fileFor(scope, 'yaml')?.replace(/\.yaml$/, '')
        if (!base) return null
        for (const ext of READ_EXTENSIONS) {
            const path = `${base}.${ext}`
            if (!(await this.fs.exists(path).catch(() => false))) continue
            try {
                return { path, text: await this.fs.readFile(path) }
            } catch {
                return null
            }
        }
        return null
    }

    private recompute() {
        let merged: Values = this.defaults
        for (const scope of SCOPES) {
            const file = this.files.get(scope)
            if (file) merged = merge(merged, file.values)
        }
        this.merged = merged as T
    }

    /** Every listener told; one that throws is reported, and the rest
     *  (and the write under way) go on. */
    private notify() {
        for (const listener of this.listeners) {
            try {
                listener(this)
            } catch (error) {
                console.error('[config] A settings listener failed', error)
            }
        }
    }

    /** The file's text with `value` at `path`: a YAML document keeps its
     *  comments and order; JSON is written afresh. A new YAML file names
     *  the schema for other editors. */
    private serialize(path: string, text: string | undefined, dotted: string, value: unknown): string {
        const keys = dotted ? dotted.split('.') : []
        if (path.endsWith('.json')) {
            let values: Values = {}
            try {
                const parsed = text ? JSON.parse(text) : {}
                if (isObject(parsed)) values = parsed
            } catch {
                // Written afresh.
            }
            return JSON.stringify(dotted ? setAt(values, dotted, value) : values, null, 2) + '\n'
        }
        const parsed = text ? parseDocument(text) : null
        let doc: Document
        if (parsed && isMap(parsed.contents)) doc = parsed
        else {
            doc = new Document({})
            const up = path.slice(this.root.length + 1).split('/').length - 1
            doc.commentBefore = ` yaml-language-server: $schema=${'../'.repeat(up)}schema.json`
        }
        if (!keys.length) return doc.toString()
        if (value === undefined) doc.deleteIn(keys)
        else doc.setIn(keys, value)
        return doc.toString()
    }

    private async keepSchema() {
        const text = JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', ...this.schema }, null, 2) + '\n'
        const have = (await this.fs.exists(this.schemaFile)) ? await this.fs.readFile(this.schemaFile) : null
        if (have === text) return
        await this.fs.mkdir(this.root, { recursive: true })
        await this.fs.writeFile(this.schemaFile, text)
    }

    private watch() {
        if (!this.fs.watch) return
        const folder = this.folder()
        void (async () => {
            try {
                for await (const event of this.fs.watch!(this.root, { signal: this.stop.signal })) {
                    const name = event.filename.replace(/^\/+/, '')
                    // Our folder's files (the watched path may be reported
                    // from the root or from the folder itself).
                    if (name.startsWith(folder) || name.startsWith(folder.slice(this.root.length + 1)) || name === this.schemaFile) this.later()
                }
            } catch {
                // Not watched (the folder is not there yet, or the
                // filesystem cannot): `reload` is the way.
            }
        })()
    }

    private later() {
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
            this.timer = null
            void this.reload()
        }, 30)
    }
}

/** `schema` with the reserved `access` setting among its properties. */
function withAccess(schema: Schema): Schema {
    if (schema.properties?.access) return schema
    return { ...schema, type: 'object', properties: { ...schema.properties, access: ACCESS } }
}
