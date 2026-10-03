import { describe, it, expect } from 'vitest'
import { fenceFor } from './codeblock'

/**
 * The fence a code block is written with. A closing fence is backticks and
 * nothing else, so only a bare run inside the code can end the block early:
 * the fence is made longer than any such run. A run with a language or a
 * path after it only opens a fence, and changes nothing.
 */
describe('A code block’s fence', () => {
    it('is three backticks when nothing inside could close it', () => {
        expect(fenceFor('const x = 1\n')).toBe('```')
        expect(fenceFor('')).toBe('```')
        // An opener with a language inside (unclosed) cannot close the block.
        expect(fenceFor('# A\n\n```ts\nconst x = 1\n')).toBe('```')
        // Nor can a tilde fence, or backticks after other text.
        expect(fenceFor('~~~\ncode\n~~~\n')).toBe('```')
        expect(fenceFor('see ```\n')).toBe('```')
    })

    it('is longer than any bare run inside, which is what a closing fence is', () => {
        expect(fenceFor('# A\n\n```ts\nconst x = 1\n```\n\nafter\n')).toBe('````')
        // Up to three spaces before the run still make a closing fence.
        expect(fenceFor('   ```   \n')).toBe('````')
        // One more than the longest, however long.
        expect(fenceFor('````md\n```\n````\n')).toBe('`````')
    })
})
