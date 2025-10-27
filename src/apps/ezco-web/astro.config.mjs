import { defineConfig, envField } from 'astro/config';
import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
    vite: {
        plugins: [tailwindcss()],
        worker: {
            format: 'es',
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