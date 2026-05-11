import { defineConfig, envField } from 'astro/config';
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
    vite: {
        plugins: [
            tailwindcss()
        ],
        worker: {
            format: 'es',
        },
        server: {
            headers: {
                'Cross-Origin-Embedder-Policy': 'credentialless',
                'Cross-Origin-Opener-Policy': 'same-origin',
            },
        },
        optimizeDeps: {
            include: [
                '@codemirror/lang-javascript',
                '@codemirror/lang-python',
                '@codemirror/lang-rust',
                '@codemirror/lang-css',
                '@codemirror/lang-sass',
                '@codemirror/lang-less',
                '@codemirror/lang-html',
                '@codemirror/lang-json',
                '@codemirror/lang-xml',
                '@codemirror/lang-markdown',
                '@codemirror/lang-sql',
                '@codemirror/lang-php',
                '@codemirror/lang-java',
                '@codemirror/lang-cpp',
                '@codemirror/lang-yaml',
                // Force a fresh pre-bundle of flatpickr — without it
                // Vite has been serving the cached `.vite/deps/flatpickr.js`
                // with an empty Content-Type that the browser rejects
                // as `NS_ERROR_CORRUPTED_CONTENT`.
                'flatpickr',
            ],
            // Skip pre-bundling for our workspace packages. Vite caches
            // pre-bundles by content hash, and that cache wasn't
            // invalidating when the workspace package's `dist/` files
            // were rebuilt — so changes to `@joinezco/markdown-editor`
            // or `@joinezco/codeblock` could appear to do nothing in
            // the browser until `node_modules/.vite` was wiped by
            // hand. Excluding them makes Vite serve their built files
            // directly on each request.
            exclude: [
                '@joinezco/markdown-editor',
                '@joinezco/codeblock',
                '@joinezco/shared',
            ],
        },
    },
    site: 'https://tbrockman.github.io',
    base: '/',
    output: 'static',
    build: {
        assets: 'assets'
    },
    env: {
        schema: {
            DEV: envField.boolean({
                default: false,
                description: 'Is the app running in development mode?',
                context: "client",
                access: "public",
            }),
        }
    }
});