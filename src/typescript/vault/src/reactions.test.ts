import { describe, expect, it } from 'vitest'
import { Vault } from './vault.js'
import { memoryVfs } from '@joinezco/storage'
import { ReactionStore, referenceKey } from './reactions.js'

const NOTES = {
    'Plan.md': '# Plan\n\nWe ship it.\n',
    'Review.md': '![[Plan#:~:text=ship%20it]]\nWhich release?\n',
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('A vault’s reactions', () => {
    it('are toggled by an identity and read across every identity, per document', async () => {
        const store = memoryVfs(NOTES)
        const theo = await Vault.open(store, { watch: false, identity: 'theo' })
        const alice = await Vault.open(store, { watch: false, identity: 'alice' })
        expect(theo.reactions.identity).toBe('theo')

        const ref = referenceKey((await theo.comments.in('Review.md'))[0].link)
        expect(ref).toBe('Plan#:~:text=ship%20it')
        await theo.reactions.toggle({ doc: 'Review.md', ref }, '👍')
        await theo.reactions.toggle({ doc: 'Plan.md', ref: null }, '🎉')
        await alice.reactions.toggle({ doc: 'Review.md', ref }, '👍')
        await alice.reactions.toggle({ doc: 'Review.md', ref }, '👀')

        // Kept per identity, one line each, under the state directory.
        const lines = (await store.readFile('.vault/state/theo/reactions.jsonl')).trimEnd().split('\n').map((l) => JSON.parse(l))
        expect(lines).toEqual([
            { at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/), doc: 'Review.md', ref, emoji: '👍' },
            { at: expect.any(String), doc: 'Plan.md', ref: null, emoji: '🎉' },
        ])
        expect(theo.paths()).toEqual(['Plan.md', 'Review.md'])

        // Each vault reads the other's file when asked (nothing cached yet
        // for the other identity).
        const onReview = await theo.reactions.on('Review.md')
        expect(onReview.map((r) => [r.by, r.to.ref, r.emoji])).toEqual([
            ['alice', ref, '👍'],
            ['alice', ref, '👀'],
            ['theo', ref, '👍'],
        ])
        expect((await alice.reactions.on('Plan.md')).map((r) => [r.by, r.emoji])).toEqual([['theo', '🎉']])

        // Toggling again takes it away, and only the identity's own.
        await theo.reactions.toggle({ doc: 'Review.md', ref }, '👍')
        expect((await theo.reactions.on('Review.md')).map((r) => r.by)).toEqual(['alice', 'alice'])
        expect(await store.readFile('.vault/state/theo/reactions.jsonl')).toBe(`${JSON.stringify(lines[1])}\n`)
    })

    it('forget what they read of another identity when the store reports a change', async () => {
        const store = memoryVfs(NOTES)
        const theo = await Vault.open(store, { identity: 'theo' })
        const alice = new ReactionStore(store, { identity: 'alice' })
        expect(await theo.reactions.on('Plan.md')).toEqual([])
        let told = 0
        theo.reactions.subscribe!(() => told++)
        await alice.toggle({ doc: 'Plan.md', ref: null }, '👍')
        // The vault's watch of the state directory drops the cached reading.
        await tick()
        await tick()
        expect((await theo.reactions.on('Plan.md')).map((r) => r.by)).toEqual(['alice'])
        expect(told).toBeGreaterThan(0)
        theo.close()
    })

    it('are read-only without an identity', async () => {
        const vault = await Vault.open(memoryVfs(NOTES), { watch: false })
        expect(vault.reactions.identity).toBeNull()
        await expect(vault.reactions.toggle({ doc: 'Plan.md', ref: null }, '👍')).rejects.toThrow(/read-only/)
        expect(await vault.reactions.on('Plan.md')).toEqual([])
    })

    it('refuse an identity that is not a folder name, and pass over such folders when reading', async () => {
        expect(() => new ReactionStore(memoryVfs(), { identity: 'a/b' })).toThrow(/Not an identity/)
        expect(() => new ReactionStore(memoryVfs(), { identity: '' })).toThrow(/Not an identity/)
        expect(() => new ReactionStore(memoryVfs(), { identity: 'thé' })).toThrow(/Not an identity/)
        await expect(Vault.open(memoryVfs(), { watch: false, identity: 'a b' })).rejects.toThrow(/Not an identity/)
        const store = memoryVfs({
            '.vault/state/ok_1.2-3/reactions.jsonl': '{"at":"2026-09-26T14:02Z","doc":"Plan.md","ref":null,"emoji":"👍"}\nnot json\n',
            '.vault/state/bad name/reactions.jsonl': '{"at":"2026-09-26T14:02Z","doc":"Plan.md","ref":null,"emoji":"👎"}\n',
        })
        const vault = await Vault.open(store, { watch: false })
        expect(await vault.reactions.on('Plan.md')).toEqual([{ by: 'ok_1.2-3', at: '2026-09-26T14:02Z', to: { doc: 'Plan.md', ref: null }, emoji: '👍' }])
    })
})
