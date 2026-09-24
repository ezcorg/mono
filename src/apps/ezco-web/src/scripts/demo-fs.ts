import { CodeblockFS } from "@joinezco/codeblock";
import { Vault, type VfsInterface } from "@joinezco/storage";
import { files } from "../data/demo-files.js";

// Shared singleton for the `ezco-demo` OPFS bucket, as a vault: one index
// behind every demo on the page (the codeblocks, the editor and every
// codeblock embedded in it search the same one, and see each other's files).
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
    var __ezcoDemoVault: Promise<Vault> | undefined;
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

export function getDemoVault(): Promise<Vault> {
    if (globalThis.__ezcoDemoVault) return globalThis.__ezcoDemoVault;
    const promise = CodeblockFS.worker(undefined, "ezco-demo").then(async (store) => {
        const vault = new Vault(store);
        await seed(vault.fs);
        return vault;
    });
    globalThis.__ezcoDemoVault = promise;
    return promise;
}
