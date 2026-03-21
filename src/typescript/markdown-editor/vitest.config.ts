import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import path from 'path'

export default defineConfig({
    test: {
        // Enable browser testing
        browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [
                {
                    browser: 'chromium',
                    viewport: {
                        width: 1280,
                        height: 720,
                    },
                },
            ],
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
    // @joinezco/codeblock is a workspace link — exclude it from optimization so
    // Vite serves its source directly. Its transitive deps must be listed with
    // the "package > dep" syntax so Vite can resolve them through the excluded package.
    optimizeDeps: {
        exclude: ['@joinezco/codeblock'],
        include: [
            '@joinezco/codeblock > @codemirror/autocomplete',
            '@joinezco/codeblock > @codemirror/commands',
            '@joinezco/codeblock > @codemirror/lang-cpp',
            '@joinezco/codeblock > @codemirror/lang-css',
            '@joinezco/codeblock > @codemirror/lang-html',
            '@joinezco/codeblock > @codemirror/lang-java',
            '@joinezco/codeblock > @codemirror/lang-javascript',
            '@joinezco/codeblock > @codemirror/lang-less',
            '@joinezco/codeblock > @codemirror/lang-markdown',
            '@joinezco/codeblock > @codemirror/lang-php',
            '@joinezco/codeblock > @codemirror/lang-python',
            '@joinezco/codeblock > @codemirror/lang-rust',
            '@joinezco/codeblock > @codemirror/lang-sass',
            '@joinezco/codeblock > @codemirror/lang-sql',
            '@joinezco/codeblock > @codemirror/lang-xml',
            '@joinezco/codeblock > @codemirror/lang-yaml',
            '@joinezco/codeblock > @codemirror/language',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/clike',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/cmake',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/dockerfile',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/go',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/haskell',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/lua',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/perl',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/properties',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/ruby',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/shell',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/swift',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/toml',
            '@joinezco/codeblock > @codemirror/legacy-modes/mode/vb',
            '@joinezco/codeblock > @codemirror/lint',
            '@joinezco/codeblock > @codemirror/search',
            '@joinezco/codeblock > @lezer/highlight',
            '@joinezco/codeblock > @m234/nerd-fonts/fs',
            '@joinezco/codeblock > @volar/language-service',
            '@joinezco/codeblock > comlink',
            '@joinezco/codeblock > lodash',
            '@joinezco/codeblock > minisearch',
            '@joinezco/codeblock > path-browserify',
            'marked',
        ],
    },
    // Server configuration for tests
    server: {
        headers: {
            'Cross-Origin-Embedder-Policy': 'credentialless',
            'Cross-Origin-Opener-Policy': 'same-origin',
        },
    },
})