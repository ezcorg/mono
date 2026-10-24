/**
 * What Vite pre-bundles for this package's pages, in the demo and under the
 * tests (vite.config.ts and vitest.config.ts take it alike): everything the
 * editor loads lazily. Found mid-run instead, Vite re-optimizes and reloads
 * the page, under an e2e spec or a browser test, and whichever of them was
 * waiting on the page fails.
 */
export const lazyDeps = [
    // A language, on the first file of its kind.
    '@codemirror/lang-cpp',
    '@codemirror/lang-css',
    '@codemirror/lang-html',
    '@codemirror/lang-java',
    '@codemirror/lang-javascript',
    '@codemirror/lang-json',
    '@codemirror/lang-less',
    '@codemirror/lang-markdown',
    '@codemirror/lang-php',
    '@codemirror/lang-python',
    '@codemirror/lang-rust',
    '@codemirror/lang-sass',
    '@codemirror/lang-sql',
    '@codemirror/lang-xml',
    '@codemirror/lang-yaml',
    '@codemirror/legacy-modes/mode/clike',
    '@codemirror/legacy-modes/mode/cmake',
    '@codemirror/legacy-modes/mode/dockerfile',
    '@codemirror/legacy-modes/mode/go',
    '@codemirror/legacy-modes/mode/haskell',
    '@codemirror/legacy-modes/mode/lua',
    '@codemirror/legacy-modes/mode/perl',
    '@codemirror/legacy-modes/mode/properties',
    '@codemirror/legacy-modes/mode/ruby',
    '@codemirror/legacy-modes/mode/shell',
    '@codemirror/legacy-modes/mode/swift',
    '@codemirror/legacy-modes/mode/toml',
    '@codemirror/legacy-modes/mode/vb',
    // The TypeScript language server, in its shared worker.
    'vscode-languageserver/browser',
    '@volar/language-server/browser',
    '@volar/language-service',
    'volar-service-typescript',
    'typescript',
]
