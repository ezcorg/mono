import { browserVfs } from "@joinezco/storage/browser";
import { Vault, type VfsInterface } from "@joinezco/storage";
import { files } from "../data/demo-files.js";

// The `ezco-demo` vault (the origin's OPFS, through storage's workers) as
// one Vault: one index behind every demo on the page (the codeblocks, the
// editor and every codeblock embedded in it search the same one, and see each
// other's files). With Astro's ClientRouter both demo pages can run their init
// scripts in one session, so the vault is kept on `globalThis` and handed to
// every later caller rather than indexed twice.
//
// Seed errors are swallowed per file so one failure doesn't leave the cache
// holding a rejected Promise; the vault is still usable for everything else.

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
    const promise = browserVfs("ezco-demo").then(async (store) => {
        const vault = new Vault(store);
        await seed(vault.fs);
        return vault;
    });
    globalThis.__ezcoDemoVault = promise;
    return promise;
}
