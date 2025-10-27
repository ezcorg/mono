import { defineConfig } from 'vite'
import { getGitignored } from './src/utils/snapshot';
import path from 'path';
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
    include?: string[],
    exclude?: string[],
    gitignore?: string | false | undefined
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
        // console.log('Taking snapshot of filesystem', { root, filter });
        // const snapshot = await takeSnapshot({ root, filter })
        // console.log('Snapshot created', snapshot);
        // const fsBuffer = await transform?.(snapshot) || snapshot;
        // await fs.writeFile(output, Buffer.from(fsBuffer));
    } catch (e) { console.error(e) }

    return {
        name: '@joinezco/snapshot'
    };
};

export default async function getConfig() {
    return defineConfig({
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
        plugins: [
            snapshot({
                gitignore: false,
                exclude: ['.git', 'dist', 'build', 'coverage', 'static', 'public/snapshot.bin', '.vite', '.turbo'],
                output: './public/snapshot.bin'
            }),
            // nodePolyfills({
            //     include: ['events', 'process']
            // }),
        ],
        server: {
            headers: {
                'Cross-Origin-Embedder-Policy': 'credentialless',
                'Cross-Origin-Opener-Policy': 'same-origin',
            },
        },
    })
}