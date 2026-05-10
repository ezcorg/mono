import { CodeblockFS, type VfsInterface } from "@joinezco/codeblock";
import { files } from "../pages/data/work.js";

// Shared singleton for the `ezco-demo` OPFS bucket.
//
// `CodeblockFS.worker(undefined, "ezco-demo")` opens sync access handles in
// the codeblock SharedWorker's OPFS layer; calling it twice in the same
// document throws `NoModificationAllowedError` because the previous handles
// haven't been released. With Astro's ClientRouter, both demo pages can run
// their init scripts in a single session, so we keep one mounted fs on
// `globalThis` and hand it to every subsequent caller.
//
// Seed errors are swallowed per-file so a partial failure (e.g. a single
// locked handle) doesn't leave the cache holding a rejected Promise — the
// fs itself is still usable for everything else.

declare global {
    // eslint-disable-next-line no-var
    var __ezcoDemoFs: Promise<VfsInterface> | undefined;
}

async function seed(fs: VfsInterface) {
    await Promise.all(
        files.map(async ([path, content]) => {
            try {
                const existing = await fs.exists(path);
                if (!existing) {
                    await fs.writeFile(path, content);
                    return;
                }
                const current = await fs.readFile(path);
                if (!current || current.length === 0) {
                    await fs.writeFile(path, content);
                }
            } catch (err) {
                console.warn(`[demo-fs] seed ${path} failed:`, err);
            }
        }),
    );
}

export function getDemoFs(): Promise<VfsInterface> {
    if (globalThis.__ezcoDemoFs) return globalThis.__ezcoDemoFs;
    const promise = CodeblockFS.worker(undefined, "ezco-demo").then(async (fs) => {
        await seed(fs);
        return fs;
    });
    globalThis.__ezcoDemoFs = promise;
    return promise;
}
