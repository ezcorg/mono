/**
 * What settings there are, as a JSON Schema: their types, defaults,
 * titles and descriptions. A host writes its schema in zod (`fromZod`)
 * or hands one in as is. From the schema come the defaults, the check a
 * file's values go through, and the fields a generated UI shows.
 */
import { z } from 'zod'

/** The part of JSON Schema (draft 7) settings use. */
export interface Schema {
    $schema?: string
    $id?: string
    title?: string
    description?: string
    type?: SchemaType | SchemaType[]
    properties?: Record<string, Schema>
    required?: string[]
    additionalProperties?: boolean | Schema
    enum?: unknown[]
    const?: unknown
    default?: unknown
    minimum?: number
    maximum?: number
    multipleOf?: number
    minLength?: number
    maxLength?: number
    pattern?: string
    items?: Schema
    anyOf?: Schema[]
    oneOf?: Schema[]
    [keyword: string]: unknown
}

export type SchemaType = 'object' | 'boolean' | 'number' | 'integer' | 'string' | 'array' | 'null'

/** The schema zod's `toJSONSchema` makes of `shape`: every key optional
 *  (a file holds any subset), defaults and descriptions kept. */
export function fromZod(schema: z.ZodType, meta: { title?: string; description?: string } = {}): Schema {
    const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as Schema
    return { ...optional(json), ...meta }
}

/** `schema` with nothing required at any level: a settings file says
 *  what it says, and the rest is the default. */
function optional(schema: Schema): Schema {
    const { required: _required, ...rest } = schema
    const out: Schema = rest
    if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, optional(v)]))
    if (out.items) out.items = optional(out.items)
    return out
}

/** A setting a generated UI can show: a switch, a choice, a number or a
 *  line of text. (Objects are groups; arrays are left to the file.) */
export interface Field {
    /** Dotted, from the root: `comments.openOnClick`. */
    path: string
    key: string
    /** The schema's title, else the key as words. */
    label: string
    /** The titles of the groups above it, in order. */
    group: string[]
    description?: string
    kind: 'boolean' | 'number' | 'string' | 'enum'
    /** For a choice: the values offered, in order. */
    options?: { value: unknown; label: string }[]
    default?: unknown
    minimum?: number
    maximum?: number
    step?: number
    integer?: boolean
}

/** The fields of `schema`, depth first, in the schema's order. */
export function fieldsOf(schema: Schema, group: string[] = [], prefix = ''): Field[] {
    const fields: Field[] = []
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        const path = prefix ? `${prefix}.${key}` : key
        const type = typeOf(sub)
        if (type === 'object') {
            fields.push(...fieldsOf(sub, [...group, sub.title ?? humanize(key)], path))
            continue
        }
        const base = { path, key, label: sub.title ?? humanize(key), group, description: sub.description, default: sub.default }
        if (sub.enum) {
            fields.push({ ...base, kind: 'enum', options: sub.enum.map((value) => ({ value, label: typeof value === 'string' ? humanize(value) : String(value) })) })
        } else if (type === 'boolean') {
            fields.push({ ...base, kind: 'boolean' })
        } else if (type === 'number' || type === 'integer') {
            fields.push({ ...base, kind: 'number', minimum: sub.minimum, maximum: sub.maximum, step: sub.multipleOf, integer: type === 'integer' })
        } else if (type === 'string') {
            fields.push({ ...base, kind: 'string' })
        }
        // Arrays and the untyped: the file is the way to them.
    }
    return fields
}

/** The values the schema gives when a file says nothing. */
export function defaultsOf(schema: Schema): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (typeOf(sub) === 'object') out[key] = sub.default !== undefined && isObject(sub.default) ? { ...defaultsOf(sub), ...sub.default } : defaultsOf(sub)
        else if (sub.default !== undefined) out[key] = sub.default
    }
    return out
}

export interface Problem {
    /** Dotted path of the value. */
    path: string
    message: string
}

/**
 * `value` as the schema allows it: a value of the wrong type, not among
 * the choices, or out of range is left out (and reported), so a file's
 * mistake never reaches a setting's reader. Keys the schema does not know
 * are kept, and reported only where the schema forbids them.
 */
export function check(schema: Schema, value: unknown, path = ''): { value: unknown; problems: Problem[] } {
    const problems: Problem[] = []
    const at = (key: string) => (path ? `${path}.${key}` : key)
    const type = typeOf(schema)
    if (schema.enum) {
        if (!schema.enum.some((option) => option === value)) {
            problems.push({ path, message: `must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(', ')}` })
            return { value: undefined, problems }
        }
        return { value, problems }
    }
    if (type === 'object') {
        if (!isObject(value)) {
            problems.push({ path, message: 'must be a mapping' })
            return { value: undefined, problems }
        }
        const out: Record<string, unknown> = {}
        for (const [key, inner] of Object.entries(value)) {
            if (inner === null || inner === undefined) continue
            const sub = schema.properties?.[key]
            if (!sub) {
                if (schema.additionalProperties === false) problems.push({ path: at(key), message: 'is not a setting' })
                else out[key] = inner
                continue
            }
            const checked = check(sub, inner, at(key))
            problems.push(...checked.problems)
            if (checked.value !== undefined) out[key] = checked.value
        }
        return { value: out, problems }
    }
    if (type === 'boolean' && typeof value !== 'boolean') return refused('must be true or false')
    if ((type === 'number' || type === 'integer') && typeof value !== 'number') return refused('must be a number')
    if (type === 'integer' && !Number.isInteger(value)) return refused('must be a whole number')
    if (type === 'string' && typeof value !== 'string') return refused('must be text')
    if (type === 'array' && !Array.isArray(value)) return refused('must be a list')
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) return refused(`must be at least ${schema.minimum}`)
        if (schema.maximum !== undefined && value > schema.maximum) return refused(`must be at most ${schema.maximum}`)
    }
    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) return refused(`must be at least ${schema.minLength} characters`)
        if (schema.maxLength !== undefined && value.length > schema.maxLength) return refused(`must be at most ${schema.maxLength} characters`)
        if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return refused(`must match ${schema.pattern}`)
    }
    return { value, problems }

    function refused(message: string) {
        problems.push({ path, message })
        return { value: undefined, problems }
    }
}

/** The one type a schema names (the first, of several), or none. */
export function typeOf(schema: Schema): SchemaType | undefined {
    if (Array.isArray(schema.type)) return schema.type.find((t) => t !== 'null')
    if (schema.type) return schema.type
    if (schema.properties) return 'object'
    if (schema.enum?.length) {
        const first = schema.enum.find((v) => v !== null)
        if (typeof first === 'string') return 'string'
        if (typeof first === 'number') return 'number'
        if (typeof first === 'boolean') return 'boolean'
    }
    const union = schema.anyOf ?? schema.oneOf
    if (union) return union.map(typeOf).find((t) => t && t !== 'null')
    return undefined
}

/** `openOnClick` → `Open on click`; `show_resolved` → `Show resolved`. */
export function humanize(key: string): string {
    const words = key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toLowerCase()
    return words.charAt(0).toUpperCase() + words.slice(1)
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value at a dotted `path` in `value`, or undefined. */
export function getAt(value: unknown, path: string): unknown {
    if (!path) return value
    let at: unknown = value
    for (const key of path.split('.')) {
        if (!isObject(at)) return undefined
        at = at[key]
    }
    return at
}

/** `value` with `inner` at the dotted `path` (a copy; `undefined` removes the key). */
export function setAt(value: Record<string, unknown>, path: string, inner: unknown): Record<string, unknown> {
    const [head, ...rest] = path.split('.')
    const out = { ...value }
    if (!rest.length) {
        if (inner === undefined) delete out[head]
        else out[head] = inner
        return out
    }
    const next = isObject(out[head]) ? out[head] : {}
    const below = setAt(next, rest.join('.'), inner)
    if (!Object.keys(below).length && inner === undefined) delete out[head]
    else out[head] = below
    return out
}

/** `over` laid over `under`: mappings merged key by key, anything else
 *  replaced; a null or undefined in `over` leaves `under`'s value. */
export function merge(under: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...under }
    for (const [key, value] of Object.entries(over)) {
        if (value === null || value === undefined) continue
        const below = out[key]
        out[key] = isObject(value) && isObject(below) ? merge(below, value) : value
    }
    return out
}
