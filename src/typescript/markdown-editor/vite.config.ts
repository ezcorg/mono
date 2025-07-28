import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path';
import { getGitignored, takeSnapshot } from '../codeblock/src/utils/snapshot';
import fs from 'fs/promises';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import multimatch from 'multimatch';

export const viteDefaults = {
  root: process.cwd(),
  include: ['**/*'],
  exclude: ['.git', 'dist', 'build', 'coverage', 'static'],
  gitignore: '.gitignore',
  transform: async (fs: ArrayBuffer) => fs,
  output: './snapshot.bin'
}

export type SnapshotProps = {
  root?: string;
  include?: string[];
  exclude?: string[];
  gitignore?: string | false;
  transform?: (tree: ArrayBuffer) => ArrayBuffer;
  output?: string;
}

export type BuildPathFilterArgs = {
  include: string[],
  exclude: string[],
  gitignore: string | false
}

export const buildPathFilter = async ({ include, exclude, gitignore }: BuildPathFilterArgs) => {
  const ignored = gitignore ? await getGitignored(gitignore) : [];
  exclude = exclude ? exclude.concat(ignored) : [];
  include = include ? include : ['**/*'];

  return (filepath: string) => {

    if (!(include || exclude)) return true;

    const relativePath = path.relative(process.cwd(), filepath);

    const included = include ? !!multimatch(relativePath, include, { partial: true }).length : true;
    const excluded = exclude ? !!multimatch(relativePath, exclude).length : false;

    return included && !excluded;
  };
}

export const snapshot = async (props: SnapshotProps = {}) => {
  const { root, include, exclude, gitignore, transform, output } = { ...viteDefaults, ...props };
  const filter = await buildPathFilter({ include, exclude, gitignore });

  try {
    console.log('Taking snapshot of filesystem', { root, filter });
    const snapshot = await takeSnapshot({ root, filter })
    console.log('Snapshot created', snapshot);
    const fsBuffer = await transform?.(snapshot) || snapshot;
    await fs.writeFile(output, Buffer.from(fsBuffer));
  } catch (e) { console.error(e) }

  return {
    name: '@ezdevlol/snapshot'
  };
};

export default async function getConfig({ command }: { command: string }) {
  const isLibraryBuild = command === 'build';

  return defineConfig({
    build: isLibraryBuild ? {
      lib: {
        entry: path.resolve(__dirname, './src/lib/index.ts'),
        name: 'MarkdownEditor',
        fileName: (format) => `index.${format === 'es' ? 'js' : `${format}.js`}`,
        formats: ['es', 'cjs']
      },
    } : {
      // Regular app build for dev mode
      outDir: 'dist-app'
    },
    optimizeDeps: {
      exclude: ['@ezdevlol/codeblock', '@ezdevlol/snapshot']
    },
    plugins: [
      // Only include snapshot plugin in dev mode
      ...(isLibraryBuild ? [] : [snapshot({
        gitignore: false,
        exclude: ['.git', 'dist', 'build', 'coverage', 'static', 'node_modules', 'public/snapshot.bin', '.vite', '.turbo'],
        output: './public/snapshot.bin'
      }), react()]),
      nodePolyfills({
        include: ['path', 'events', 'process']
      })
    ],
    server: {
      headers: {
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    },
  })
}
