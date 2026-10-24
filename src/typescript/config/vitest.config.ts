import { defineConfig } from 'vitest/config'

// No DOM anywhere: every suite runs in Node over in-memory filesystems.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
})
