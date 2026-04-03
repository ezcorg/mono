/**
 * Dev proxy server that bridges browser HTTP requests to the local `claude` CLI.
 *
 * Receives POST /api/ai/edit with JSON body { prompt, selection, codeBefore, codeAfter }
 * and streams back the `claude` CLI response.
 *
 * Usage:
 *   npx tsx src/ai/proxy-server.ts
 *   # or with custom port:
 *   PORT=3141 npx tsx src/ai/proxy-server.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT) || 3141;

function cors(res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
    });
}

const server = createServer(async (req, res) => {
    cors(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url === '/api/ai/edit') {
        try {
            const body = JSON.parse(await readBody(req));
            const { prompt, selection, codeBefore, codeAfter, model } = body as {
                prompt: string;
                selection: string;
                codeBefore: string;
                codeAfter: string;
                model?: string;
            };

            const systemPrompt = [
                'You are an inline code editor. The user has selected a region of code and wants you to modify it.',
                'You will receive the selected code along with surrounding context (code before and after the selection).',
                '',
                'RULES:',
                '- Return ONLY the replacement code for the selected region.',
                '- Do NOT include any explanation, markdown fencing, or surrounding code.',
                '- Maintain consistent style (indentation, naming conventions) with the surrounding code.',
                '- The output must be directly insertable in place of the selection.',
            ].join('\n');

            const userPrompt = [
                `INSTRUCTION: ${prompt}`,
                '',
                '--- CODE BEFORE SELECTION ---',
                codeBefore.slice(-2000),
                '--- SELECTED CODE ---',
                selection,
                '--- CODE AFTER SELECTION ---',
                codeAfter.slice(0, 2000),
                '',
                'Return ONLY the replacement for the selected code:',
            ].join('\n');

            const args = [
                '-p', userPrompt,
                '--system-prompt', systemPrompt,
                '--no-session-persistence',
                '--output-format', 'text',
            ];
            if (model) args.push('--model', model);

            const claude = spawn('claude', args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env },
            });

            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });

            claude.stdout.on('data', (chunk: Buffer) => {
                res.write(chunk);
            });

            claude.stderr.on('data', (chunk: Buffer) => {
                console.error('[claude stderr]', chunk.toString());
            });

            claude.on('close', (code) => {
                if (code !== 0) {
                    console.error(`[claude] exited with code ${code}`);
                }
                res.end();
            });

            claude.on('error', (err) => {
                console.error('[claude] spawn error:', err);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                }
                res.end(JSON.stringify({ error: err.message }));
            });

            // Handle client disconnect
            req.on('close', () => {
                if (!claude.killed) claude.kill('SIGTERM');
            });
        } catch (err: any) {
            console.error('[proxy] error:', err);
            if (!res.headersSent) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`[codeblock-ai-proxy] Listening on http://localhost:${PORT}`);
    console.log(`[codeblock-ai-proxy] POST /api/ai/edit — proxy to claude CLI`);
    console.log(`[codeblock-ai-proxy] GET  /health       — health check`);
});
