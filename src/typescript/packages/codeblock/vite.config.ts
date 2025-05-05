import { defineConfig } from 'vite'
import { getGitignored, takeSnapshot } from './src/utils/snapshot';
import fs from 'node:fs/promises';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import multimatch from 'multimatch';

const viteDefaults = {
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

    return (path: string) => {
        if (!(include || exclude)) return true;

        const included = include ? !!multimatch(path, include, { partial: true }).length : true;
        const excluded = exclude ? !!multimatch(path, exclude).length : false;
        return included && !excluded;
    };
}

export const snapshot = async (props: SnapshotProps = {}) => {
    const { root, include, exclude, gitignore, transform, output } = { ...viteDefaults, ...props };

    const exists = await fs.stat(output).catch(() => false);

    if (exists) {
        return
    }
    const filter = await buildPathFilter({ include, exclude, gitignore });
    const snapshot = await takeSnapshot({ root, filter })
    const fsBuffer = await transform?.(snapshot) || snapshot;
    await fs.writeFile(output, Buffer.from(fsBuffer));

    return {
        name: '@jsnix/snapshot'
    };
};

export default async function getConfig() {
    return defineConfig({
        build: {
            rollupOptions: {
                external: [
                    "@codemirror/autocomplete",
                    "@codemirror/commands",
                    "@codemirror/lang-javascript",
                    "@codemirror/lang-python",
                    "@codemirror/lang-rust",
                    "@codemirror/language",
                    "@codemirror/lint",
                    "@codemirror/search",
                    "@codemirror/state",
                    "@codemirror/view",
                ]
            }
        },
        plugins: [
            snapshot({
                gitignore: false,
                include: ['example.ts', 'src/**/*', 'index.html', 'vite.config.ts', 'node_modules/@types/**/*', 'node_modules/typescript/**/*', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', '.gitignore'],
                output: './public/snapshot.bin'
            }),
            nodePolyfills({
                include: ['events']
            }),
        ],
        server: {
            headers: {
                'Cross-Origin-Embedder-Policy': 'credentialless',
                'Cross-Origin-Opener-Policy': 'same-origin',
            },
        },
    })
}