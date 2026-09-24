import { defineConfig } from 'vite'

export default async function getConfig() {
    return defineConfig({
        appType: 'mpa',
        // resolve: {
        //     alias: {
        //         path: 'path-browserify',
        //         process: 'process/browser'
        //     }
        // },
        build: {
            rollupOptions: {
                external: [
                    // "@codemirror/autocomplete",
                    // "@codemirror/commands",
                    // "@codemirror/lang-javascript",
                    // "@codemirror/lang-python",
                    // "@codemirror/lang-rust",
                    // "@codemirror/language",
                    // "@codemirror/lint",
                    // "@codemirror/search",
                    // "@codemirror/state",
                    // "@codemirror/view",
                ]
            }
        },
        worker: {
            format: 'es',
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
                // Pre-bundle LSP deps to avoid mid-test page reloads from dep discovery
                'vscode-languageserver/browser',
                '@volar/language-server/browser',
                'volar-service-typescript',
                'typescript',
            ],
        },
        server: {
            headers: {
                'Cross-Origin-Embedder-Policy': 'credentialless',
                'Cross-Origin-Opener-Policy': 'same-origin',
            },
        },
    })
}