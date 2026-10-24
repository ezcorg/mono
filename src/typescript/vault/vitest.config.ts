import { defineConfig } from 'vitest/config'

// The vault is DOM-free: every suite runs in Node, against in-memory vaults
// and the fixture vault on disk.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
})
