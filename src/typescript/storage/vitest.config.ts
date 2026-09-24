import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

// Storage is DOM-free, so most suites run in Node against in-memory and
// on-disk vaults. The browser implementation (OPFS, its workers) runs in
// Chromium: `*.browser.test.ts`.
export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'node',
                    environment: 'node',
                    include: ['src/**/*.test.ts'],
                    exclude: ['src/**/*.browser.test.ts'],
                },
            },
            {
                // Pre-bundled up front, so no test's first import has Vite
                // re-optimize and reload the page mid-run.
                optimizeDeps: { include: ['markdown-it', 'minisearch'] },
                test: {
                    name: 'browser',
                    include: ['src/**/*.browser.test.ts'],
                    browser: {
                        enabled: true,
                        provider: playwright(),
                        headless: true,
                        instances: [{ browser: 'chromium' }],
                    },
                },
            },
        ],
    },
})
