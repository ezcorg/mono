#!/usr/bin/env node

/**
 * lazy-pack — generate a lazy-loadable filesystem image.
 *
 * Usage:
 *   lazy-pack <input-dir> -o <output-dir> [--chunk-strategy package|directory] [--prefetch <glob>] [--base-url <url>]
 *
 * Output:
 *   <output-dir>/fs.json          — manifest
 *   <output-dir>/chunks/*.tar.gz  — content chunks
 */

import { pack } from './pack.js';
import path from 'node:path';

function usage(): never {
    console.error(`
Usage: lazy-pack <input-dir> -o <output-dir> [options]

Options:
  -o, --out <dir>           Output directory (required)
  --chunk-strategy <name>   "package" (default) or "directory"
  --prefetch <glob>         Glob for files whose chunks should be prefetched
                            (can be specified multiple times)
  --exclude <glob>          Glob for paths to exclude (can be specified multiple times)
  --base-url <url>          Base URL for chunk references (default: "./chunks/")
  -h, --help                Show this help
`.trim());
    process.exit(1);
}

async function main() {
    const args = process.argv.slice(2);
    let inputDir: string | undefined;
    let outputDir: string | undefined;
    let chunkStrategy: 'package' | 'directory' = 'package';
    let prefetchGlobs: string[] = [];
    let excludeGlobs: string[] = [];
    let baseUrl = './chunks/';

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-o' || arg === '--out') {
            outputDir = args[++i];
        } else if (arg === '--chunk-strategy') {
            const val = args[++i];
            if (val !== 'package' && val !== 'directory') {
                console.error(`Invalid chunk strategy: ${val}`);
                usage();
            }
            chunkStrategy = val;
        } else if (arg === '--prefetch') {
            prefetchGlobs.push(args[++i]);
        } else if (arg === '--exclude') {
            excludeGlobs.push(args[++i]);
        } else if (arg === '--base-url') {
            baseUrl = args[++i];
        } else if (arg === '-h' || arg === '--help') {
            usage();
        } else if (!inputDir) {
            inputDir = arg;
        } else {
            console.error(`Unexpected argument: ${arg}`);
            usage();
        }
    }

    if (!inputDir || !outputDir) usage();

    const absInput = path.resolve(inputDir);
    const absOutput = path.resolve(outputDir);

    console.log(`Packing ${absInput} → ${absOutput}`);
    console.log(`  strategy: ${chunkStrategy}`);
    console.log(`  base URL: ${baseUrl}`);
    if (prefetchGlobs.length) console.log(`  prefetch: ${prefetchGlobs.join(', ')}`);
    if (excludeGlobs.length) console.log(`  exclude: ${excludeGlobs.join(', ')}`);

    const result = await pack({
        inputDir: absInput,
        outputDir: absOutput,
        chunkStrategy,
        prefetchGlobs,
        excludeGlobs,
        baseUrl,
    });

    console.log(`Done: ${result.fileCount} files in ${result.chunkCount} chunks`);
    console.log(`  manifest: ${path.relative(process.cwd(), result.manifestPath)}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
