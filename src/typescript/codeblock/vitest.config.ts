import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globalSetup: ['src/e2e/globalSetup.ts'],
    },
});
