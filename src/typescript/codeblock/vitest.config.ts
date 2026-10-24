import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { lazyDeps } from './optimize-deps';

export default defineConfig({
    test: {
        projects: [
            {
                // Pieces that need no browser (jsdom where they touch the DOM).
                test: {
                    name: 'unit',
                    include: ['src/**/*.test.ts'],
                    exclude: ['src/**/*.browser.test.ts', 'src/e2e/**'],
                },
            },
            {
                // The editor in Chromium: loading, saving, previews.
                optimizeDeps: {
                    // What the editor loads lazily, and the vault's own
                    // dependencies (a workspace link, served as source).
                    include: [...lazyDeps, 'lodash', 'path-browserify', 'comlink', '@joinezco/vault > minisearch', '@joinezco/vault > markdown-it'],
                },
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
            {
                // The example page and fixtures in Chrome, over a dev server.
                test: {
                    name: 'e2e',
                    include: ['src/e2e/**/*.spec.ts'],
                    globalSetup: ['src/e2e/globalSetup.ts'],
                },
            },
        ],
    },
});
