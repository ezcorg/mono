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