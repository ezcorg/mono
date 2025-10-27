import { defineConfig, envField } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
    integrations: [tailwind()],
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
                description: 'Is the app running in development mode?'
            }),
        }
    }
});