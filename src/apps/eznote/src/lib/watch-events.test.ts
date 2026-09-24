import { describe, expect, it } from 'vitest'
import { watchEventsOf } from './watch-events'

const notes = '/Users/a/Documents/eznote'

describe('Tauri watch events', () => {
    it('report both sides of a rename', () => {
        expect(
            watchEventsOf(notes, {
                type: { modify: { kind: 'rename', mode: 'both' } },
                paths: [`${notes}/plan.md`, `${notes}/projects/plan.md`],
            }),
        ).toEqual([
            { eventType: 'rename', filename: 'plan.md' },
            { eventType: 'rename', filename: 'projects/plan.md' },
        ])
    })

    it('tell new contents from entries coming and going', () => {
        expect(watchEventsOf(notes, { type: { modify: { kind: 'data', mode: 'content' } }, paths: [`${notes}/a.md`] })).toEqual([
            { eventType: 'change', filename: 'a.md' },
        ])
        expect(watchEventsOf(notes, { type: { create: { kind: 'file' } }, paths: [`${notes}\\b.md`] })).toEqual([
            { eventType: 'rename', filename: 'b.md' },
        ])
        expect(watchEventsOf(notes, { type: 'any', paths: [] })).toEqual([])
    })
})
