import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path';
import fs from 'fs/promises';
import multimatch from 'multimatch';
import { takeSnapshot } from '@joinezco/storage';
import { nodeVfs } from '@joinezco/storage/node';

export type SnapshotProps = {
  root?: string;
  include?: string[];
  exclude?: string[];
  output?: string;
}

/** Put the files under `root` (the package itself) in a snapshot the demo
 *  page opens its vault with. */
export const snapshot = async (props: SnapshotProps = {}) => {
  const {
    root = process.cwd(),
    include = ['**/*'],
    exclude = [],
    output = './snapshot.bin',
  } = props;
  const keep = (vaultPath: string) =>
    !!multimatch(vaultPath, include, { partial: true }).length && !multimatch(vaultPath, exclude).length;

  try {
    const bytes = await takeSnapshot(nodeVfs(root), { filter: (vaultPath) => keep(vaultPath) });
    await fs.writeFile(path.resolve(root, output), bytes);
    console.log(`Snapshot of ${root} written to ${output} (${bytes.length} bytes)`);
  } catch (e) { console.error(e) }

  return {
    name: '@joinezco/snapshot'
  };
};

export default defineConfig({
  build: {
    // Regular app build for dev mode
    outDir: 'dist-app'
  },
  // The workspace packages are served as source; their dependencies must
  // then be named for Vite to pre-bundle them, and all of CodeMirror in one
  // go, so that a language loaded later by the code block and the editor
  // it loads into are made by one copy of @codemirror/state (two copies
  // parse nothing: no highlighting, no error). Mirrors vitest.config.ts.
  optimizeDeps: {
    exclude: ['@joinezco/codeblock', '@joinezco/storage', '@joinezco/vault', '@joinezco/config'],
    include: [
      '@joinezco/config > yaml',
      '@joinezco/config > zod',
      '@joinezco/codemirror-json-schema',
      '@joinezco/codemirror-json-schema/yaml',
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
      // The TypeScript language server a code block starts in its worker:
      // listed so the first file to open one does not trigger a
      // re-optimize and reload mid-run.
      '@joinezco/codeblock > @volar/language-server/browser',
      '@joinezco/codeblock > volar-service-typescript',
      '@joinezco/codeblock > vscode-languageserver/browser',
      '@joinezco/codeblock > typescript',
      '@joinezco/codeblock > comlink',
      '@joinezco/codeblock > lodash',
      '@joinezco/vault > markdown-it',
      '@joinezco/vault > minisearch',
      '@joinezco/storage > @noble/hashes/blake3',
      '@joinezco/storage > @noble/hashes/utils',
      '@joinezco/codeblock > path-browserify',
      '@joinezco/codeblock > @marimo-team/codemirror-ai',
      '@joinezco/codeblock > vscode-languageserver-protocol',
      '@joinezco/codeblock > @codemirror/lsp-client > marked',
      'katex',
      'yaml',
    ],
  },
  plugins: [
    snapshot({
      exclude: ['.git', 'dist', 'build', 'coverage', 'static', 'node_modules', 'public/snapshot.bin', '.vite', '.turbo', 'fonts'],
      output: './public/snapshot.bin'
    }),
    react()
  ],
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'credentialless',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
})
