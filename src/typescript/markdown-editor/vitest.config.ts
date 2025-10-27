import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
    test: {
        // Enable browser testing
        browser: {
            enabled: true,
            name: 'chromium',
            provider: 'playwright',
            // Headless mode for CI, can be disabled for debugging
            headless: true,
            // Browser viewport
            viewport: {
                width: 1280,
                height: 720,
            },
        },
        // Test environment setup
        environment: 'happy-dom',
        setupFiles: ['./src/test/setup.ts'],
        // Test file patterns
        include: [
            'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
            'tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'
        ],
        // Global test configuration
        globals: true,
        // Coverage configuration
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/',
                'src/test/',
                '**/*.d.ts',
                '**/*.config.*',
                'dist/',
                'coverage/',
            ],
        },
        // Test timeout
        testTimeout: 10000,
        // Hook timeout
        hookTimeout: 10000,
    },
    // Resolve configuration for tests
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@/lib': path.resolve(__dirname, './src/lib'),
        },
    },
    // Optimize deps for testing
    optimizeDeps: {
        exclude: ['@joinezco/codeblock'],
    },
    // Server configuration for tests
    server: {
        headers: {
            'Cross-Origin-Embedder-Policy': 'credentialless',
            'Cross-Origin-Opener-Policy': 'same-origin',
        },
    },
})