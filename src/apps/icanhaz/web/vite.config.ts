import { defineConfig } from "vite";

// Shared Vite config for both the dev server (`npm run dev`, the editor-demo
// page) AND the vitest browser runner (vitest.config.ts merges this in). The
// markdown-editor pulls in @joinezco/codeblock, which ships web-worker URLs and
// a large transitive dep graph; the settings below let Vite serve the
// workspace-linked editor across the monorepo without mangling those workers.
export default defineConfig({
    optimizeDeps: {
        // @joinezco/codeblock is a workspace package shipping web workers;
        // excluding it from dep pre-bundling keeps esbuild from rewriting its
        // `new Worker(new URL(...))` URLs (mirrors eznote + the markdown-editor
        // demo). A plain markdown file spawns none of those workers, but its
        // import graph still resolves codeblock's whole index — so its
        // transitive deps are pre-bundled up front (the "pkg > dep" syntax
        // resolves them *through* the excluded package) to avoid a mid-run
        // re-optimize + page reload (the cold-cache flake). List copied from
        // markdown-editor's own proven vitest.config.ts.
        exclude: ["@joinezco/codeblock"],
        include: [
            "@joinezco/codeblock > @codemirror/autocomplete",
            "@joinezco/codeblock > @codemirror/commands",
            "@joinezco/codeblock > @codemirror/lang-cpp",
            "@joinezco/codeblock > @codemirror/lang-css",
            "@joinezco/codeblock > @codemirror/lang-html",
            "@joinezco/codeblock > @codemirror/lang-java",
            "@joinezco/codeblock > @codemirror/lang-javascript",
            "@joinezco/codeblock > @codemirror/lang-less",
            "@joinezco/codeblock > @codemirror/lang-markdown",
            "@joinezco/codeblock > @codemirror/lang-php",
            "@joinezco/codeblock > @codemirror/lang-python",
            "@joinezco/codeblock > @codemirror/lang-rust",
            "@joinezco/codeblock > @codemirror/lang-sass",
            "@joinezco/codeblock > @codemirror/lang-sql",
            "@joinezco/codeblock > @codemirror/lang-xml",
            "@joinezco/codeblock > @codemirror/lang-yaml",
            "@joinezco/codeblock > @codemirror/language",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/clike",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/cmake",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/dockerfile",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/go",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/haskell",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/lua",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/perl",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/properties",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/ruby",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/shell",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/swift",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/toml",
            "@joinezco/codeblock > @codemirror/legacy-modes/mode/vb",
            "@joinezco/codeblock > @codemirror/lint",
            "@joinezco/codeblock > @codemirror/search",
            "@joinezco/codeblock > @lezer/highlight",
            "@joinezco/codeblock > @m234/nerd-fonts/fs",
            "@joinezco/codeblock > @volar/language-service",
            "@joinezco/codeblock > comlink",
            "@joinezco/codeblock > lodash",
            "@joinezco/codeblock > minisearch",
            "@joinezco/codeblock > path-browserify",
            "@joinezco/codeblock > @marimo-team/codemirror-ai",
            "@joinezco/codeblock > vscode-languageserver-protocol",
            "@joinezco/codeblock > @jsonjoy.com/json-pack/lib/cbor/CborDecoder",
            "@joinezco/codeblock > @jsonjoy.com/json-pack/lib/cbor/CborEncoder",
            "@joinezco/codeblock > @jsonjoy.com/util/lib/buffers/Writer",
            "@joinezco/codeblock > @codemirror/lsp-client > marked",
            "multimatch",
        ],
    },
    resolve: {
        alias: {
            // The emoji picker lazy-loads the ~550KB `emojibase-data` dataset via
            // a dynamic import. A plain markdown file never opens the picker, but
            // Vite's dep crawler would still discover that node_modules dataset and
            // re-optimize (the cold-cache reload flake). Redirect it to the tiny
            // local fixture the markdown-editor package ships for exactly this
            // reason — a non-node_modules file is never an "optimized dep".
            "emojibase-data/en/compact.json":
                "/Users/theo/dev/mono/src/typescript/markdown-editor/src/test/fixtures/emoji-stub.json",
        },
    },
    server: {
        // The editor + codeblock dist are workspace-linked from outside this
        // package's root (src/typescript/*), so Vite must be allowed to serve
        // across the monorepo. Covers the emoji fixture above too.
        fs: { allow: ["/Users/theo/dev/mono"] },
        // Cross-origin isolation so codeblock's SharedArrayBuffer-backed workers
        // work in the dev demo (harmless for the markdown-only proof).
        headers: {
            "Cross-Origin-Embedder-Policy": "credentialless",
            "Cross-Origin-Opener-Policy": "same-origin",
        },
    },
});
