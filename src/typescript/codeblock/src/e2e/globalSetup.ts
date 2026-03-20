import { createServer, type ViteDevServer } from 'vite';
import path from 'path';

let server: ViteDevServer;

export async function setup() {
    const root = path.resolve(__dirname, '../..');
    server = await createServer({
        root,
        configFile: path.join(root, 'vite.config.ts'),
        server: { port: 0, strictPort: false },
    });
    await server.listen();
    const url = server.resolvedUrls!.local[0].replace(/\/$/, '');

    // Warm up the module cache
    await fetch(url).catch(() => {});

    // Expose the URL to tests via env var
    process.env.CODEBLOCK_DEV_SERVER = url;
}

export async function teardown() {
    await server?.close();
}
