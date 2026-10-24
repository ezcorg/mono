import { describe, expect, it } from 'vitest'
import { handleFromHome } from './identity'

describe('The local handle', () => {
    it('is the home folder’s name, as a comment handle can be written', () => {
        expect(handleFromHome('/Users/theo')).toBe('theo')
        expect(handleFromHome('/home/theo/')).toBe('theo')
        expect(handleFromHome('C:\\Users\\Théo Brockman')).toBe('TheoBrockman')
        expect(handleFromHome('/')).toBe('me')
    })
})
