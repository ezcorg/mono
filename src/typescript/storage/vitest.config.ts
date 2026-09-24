import { defineConfig } from 'vitest/config'

// Storage is DOM-free: its suites run in Node against in-memory and on-disk
// vaults, no browser needed.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
})
