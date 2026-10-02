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
  optimizeDeps: {
    exclude: ['@joinezco/codeblock', '@joinezco/storage', '@joinezco/vault']
  },
  plugins: [
    snapshot({
      exclude: ['.git', 'dist', 'build', 'coverage', 'static', 'node_modules', 'public/snapshot.bin', '.vite', '.turbo'],
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
