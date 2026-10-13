import { describe, it, expect } from 'vitest'
import { memoryVfs } from '@joinezco/storage'
import { Config, NotPermitted, fromZod, fieldsOf, defaultsOf, check, z } from './index.js'

const schema = fromZod(
    z.object({
        comments: z
            .object({
                openOnClick: z.boolean().default(false).describe('A click on commented text looks at its comment.'),
                step: z.number().min(0).max(64).default(32).describe('How far a card steps out, in pixels.'),
                layout: z.enum(['panel', 'column', 'float']).default('panel'),
            })
            .meta({ title: 'Comments' }),
        editor: z.object({ font: z.string().default('').describe('The face the note is set in.') }).meta({ title: 'The note' }),
    }),
    { title: 'Editor settings' },
)

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

describe('The schema', () => {
    it('lists the fields a UI shows, grouped, with their kinds and defaults', () => {
        const fields = fieldsOf(schema)
        expect(fields.map((f) => f.path)).toEqual(['comments.openOnClick', 'comments.step', 'comments.layout', 'editor.font'])
        expect(fields[0]).toMatchObject({ kind: 'boolean', label: 'Open on click', group: ['Comments'], default: false })
        expect(fields[1]).toMatchObject({ kind: 'number', minimum: 0, maximum: 64, default: 32 })
        expect(fields[2]).toMatchObject({ kind: 'enum', options: [{ value: 'panel', label: 'Panel' }, { value: 'column', label: 'Column' }, { value: 'float', label: 'Float' }] })
        expect(fields[3]).toMatchObject({ kind: 'string', group: ['The note'], description: 'The face the note is set in.' })
        expect(defaultsOf(schema)).toEqual({ comments: { openOnClick: false, step: 32, layout: 'panel' }, editor: { font: '' } })
        // Nothing is required of a file, at any level.
        expect(JSON.stringify(schema)).not.toContain('"required"')
    })

    it('keeps what a file gets right and reports the rest', () => {
        const { value, problems } = check(schema, { comments: { openOnClick: 'yes', step: 99, layout: 'float', extra: 1 }, editor: { font: 'Georgia' } })
        expect(value).toEqual({ comments: { layout: 'float', extra: 1 }, editor: { font: 'Georgia' } })
        expect(problems.map((p) => p.path)).toEqual(['comments.openOnClick', 'comments.step'])
        expect(problems[1].message).toBe('must be at most 64')
    })
})

describe('Settings in files', () => {
    it('reads the defaults, writes a scope to its file (YAML, with the schema beside), and lays scopes over one another', async () => {
        const fs = memoryVfs()
        const config = await Config.open({ fs, schema, user: 'theo', device: 'laptop', instance: 'notes' })
        expect(config.get()).toMatchObject({ comments: { openOnClick: false, step: 32 } })
        expect(config.scopes()).toEqual(['global', 'device', 'instance'])
        expect(config.file('global')).toBe('.settings/theo/global.yaml')
        expect(config.file('device')).toBe('.settings/theo/devices/laptop.yaml')
        expect(config.file('instance')).toBe('.settings/theo/instances/notes.yaml')
        // Opening writes nothing; the first file written brings the schema beside it.
        expect(await fs.exists('.settings')).toBe(false)

        await config.set('comments.step', 40)
        expect(config.get('comments.step')).toBe(40)
        expect(JSON.parse(await fs.readFile('.settings/schema.json')).properties.comments.properties.step.maximum).toBe(64)
        const text = await fs.readFile('.settings/theo/global.yaml')
        expect(text).toContain('# yaml-language-server: $schema=../schema.json')
        expect(text).toContain('step: 40')
        // The device over the vault, the instance over the device.
        await config.set('comments.step', 48, 'device')
        expect(config.get('comments.step')).toBe(48)
        await config.set('comments.step', 56, 'instance')
        expect(config.get('comments.step')).toBe(56)
        expect(config.at('global')).toEqual({ comments: { step: 40 } })
        await config.unset('comments.step', 'instance')
        expect(config.get('comments.step')).toBe(48)
        // Two values set at once, to one file: the file ends with both.
        await Promise.all([config.set('comments.openOnClick', true, 'device'), config.set('comments.layout', 'float', 'device')])
        const device = await fs.readFile('.settings/theo/devices/laptop.yaml')
        expect(device).toContain('openOnClick: true')
        expect(device).toContain('layout: float')
        expect(device).toContain('step: 48')
        expect(await fs.readFile('.settings/theo/instances/notes.yaml')).not.toContain('step')
        // Another reader of the same files sees the same.
        const other = await Config.open({ fs, schema, user: 'theo', device: 'laptop' })
        expect(other.get('comments.step')).toBe(48)
        config.close()
        other.close()
    })

    it('keeps a file’s comments and order as a value is set, and writes JSON when asked', async () => {
        const fs = memoryVfs({
            '.settings/global.yaml': '# mine\ncomments:\n  layout: column # beside the text\n  step: 8\n',
        })
        const config = await Config.open({ fs, schema })
        expect(config.get('comments.layout')).toBe('column')
        await config.set('comments.openOnClick', true)
        const text = await fs.readFile('.settings/global.yaml')
        expect(text).toContain('# mine')
        expect(text).toContain('layout: column # beside the text')
        expect(text.indexOf('layout')).toBeLessThan(text.indexOf('openOnClick'))
        config.close()

        const jsonFs = memoryVfs()
        const json = await Config.open({ fs: jsonFs, schema, format: 'json', device: 'd1' })
        await json.set('editor.font', 'Georgia', 'device')
        expect(json.file('device')).toBe('.settings/devices/d1.json')
        expect(JSON.parse(await jsonFs.readFile('.settings/devices/d1.json'))).toEqual({ editor: { font: 'Georgia' } })
        json.close()
    })

    it('follows the files as they change, and leaves a wrong value out', async () => {
        const fs = memoryVfs()
        const config = await Config.open({ fs, schema, user: 'theo' })
        const seen: unknown[] = []
        config.subscribe((c) => seen.push(c.get('comments.step')))
        await fs.mkdir('.settings/theo', { recursive: true })
        await fs.writeFile('.settings/theo/global.yaml', 'comments:\n  step: 12\n')
        await tick()
        expect(config.get('comments.step')).toBe(12)
        expect(seen).toEqual([12])
        await fs.writeFile('.settings/theo/global.yaml', 'comments:\n  step: 999\n  layout: float\n')
        await tick()
        expect(config.get('comments.step')).toBe(32)
        expect(config.get('comments.layout')).toBe('float')
        expect(config.problems()).toEqual([{ scope: 'global', path: 'comments.step', message: 'must be at most 64' }])
        // A file that cannot be read is reported, not read.
        await fs.writeFile('.settings/theo/global.yaml', 'comments: [\n')
        await tick()
        expect(config.get('comments.layout')).toBe('panel')
        expect(config.problems()[0].message).toContain('could not be read')
        config.close()
    })

    it('lets a user change another’s settings only where that user says so', async () => {
        const fs = memoryVfs()
        const alice = await Config.open({ fs, schema, user: 'alice' })
        await alice.set('comments.step', 20)
        const theo = await Config.open({ fs, schema, user: 'theo', of: 'alice' })
        expect(theo.get('comments.step')).toBe(20)
        expect(theo.file('global')).toBe('.settings/alice/global.yaml')
        await expect(theo.set('comments.step', 24)).rejects.toBeInstanceOf(NotPermitted)
        expect(await fs.readFile('.settings/alice/global.yaml')).toContain('step: 20')
        await alice.set('access.editors', ['theo'])
        await tick()
        await theo.set('comments.step', 24)
        await tick()
        expect(alice.get('comments.step')).toBe(24)
        // The grant taken away, the next write is refused again.
        await alice.set('access.editors', [])
        await tick()
        await expect(theo.set('comments.step', 28)).rejects.toBeInstanceOf(NotPermitted)
        // The reserved setting is the file's, never a UI field.
        expect(alice.fields().some((f) => f.path.startsWith('access'))).toBe(false)
        alice.close()
        theo.close()
    })
})
