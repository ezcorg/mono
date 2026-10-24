import { defineConfig } from 'vite'
import { lazyDeps } from './optimize-deps'

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
            include: lazyDeps,
        },
        server: {
            headers: {
                'Cross-Origin-Embedder-Policy': 'credentialless',
                'Cross-Origin-Opener-Policy': 'same-origin',
            },
        },
    })
}