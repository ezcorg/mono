import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { add as addComponent, all } from "./generated/components";
import { wrpcFilesystem } from "./vfs";
import { editorLinks, openLinks, requestLinksGrant } from "./links";
import { createEditor } from "@joinezco/markdown-editor";
import { LINKS, WS } from "./test-ws";

// The links example, the way the editor uses it: a page adds the component,
// holds a filesystem grant for its vault, asks for a `links` grant lending
// that, and gets an index that reads the vault on the daemon. Needs the
// daemon the harness starts (auto consent, a throwaway jail).

describe("a novel capability in the editor: backlinks", () => {
    it("is fetched from another daemon's registry when the page names it by hash and source", async () => {
        const t = await connect({ ws: WS });
        const fsGrant = await requestFilesystemGrant(t, "the vault");
        const fs = await wrpcFilesystem(t, fsGrant);
        const dir = `links-remote-${Date.now()}`;
        await fs.mkdir(dir, { recursive: false });
        await fs.writeFile(`${dir}/a.md`, `see [[b]]\n`);
        await fs.writeFile(`${dir}/b.md`, `# b\n`);

        // Nothing is added here, and the daemon holds no such component yet
        // (this case runs first): it resolves the provider from the source,
        // checks the hash, keeps it with the publisher as provenance, and only
        // then decides the grant.
        expect((await all(t)).some((c) => c.hash === LINKS.provider), "the consumer starts without it").toBe(false);
        const token = await requestLinksGrant(t, { provider: LINKS.provider, source: LINKS.source, filesystemGrant: fsGrant });
        const held = (await all(t)).find((c) => c.hash === LINKS.provider);
        expect(held?.provenance?.source).toBe(LINKS.source);
        const index = await openLinks(t, token);
        const into = await index.backlinks(`${dir}/b.md`);
        expect(into.map((l) => l.source)).toEqual([`${dir}/a.md`]);
        await index.close();

        // A wrong hash for that source is refused before consent.
        await expect(
            requestLinksGrant(t, { provider: `sha256:${"11".repeat(32)}`, source: LINKS.source, filesystemGrant: fsGrant }),
        ).rejects.toThrow(/no-provider/);
        t.close();
    }, 30000);

    it("indexes the vault through the lent filesystem grant, and a scoped grant cannot rename", async () => {
        const t = await connect({ ws: WS });
        const wasm = new Uint8Array(await (await fetch("/fixtures/links.wasm")).arrayBuffer());
        const added = await addComponent(t, wasm, undefined);
        expect(added.tag, added.tag === "err" ? added.val : "").toBe("ok");
        if (added.tag !== "ok") return;

        const fsGrant = await requestFilesystemGrant(t, "the vault");
        const fs = await wrpcFilesystem(t, fsGrant);
        const stamp = Date.now();
        const dir = `links-${stamp}`;
        await fs.mkdir(dir, { recursive: false });
        await fs.writeFile(`${dir}/index.md`, `# Index\n\nSee [[plan]] and [gone](missing.md).\n`);
        await fs.writeFile(`${dir}/plan.md`, `# Plan\n\nBack to [index](index.md).\n`);

        // Read-only by clause: the index answers, rename is refused before the component runs.
        const scopedToken = await requestLinksGrant(t, {
            provider: added.val.hash,
            filesystemGrant: fsGrant,
            allow: 'call.method != "rename"',
        });
        const scoped = await openLinks(t, scopedToken);
        const into = await scoped.backlinks(`${dir}/plan.md`);
        expect(into.map((l) => [l.source, l.line])).toEqual([[`${dir}/index.md`, 3]]);
        const dangling = await scoped.unresolved();
        expect(dangling.some((l) => l.source === `${dir}/index.md` && l.target === `${dir}/missing.md`)).toBe(true);
        await expect(scoped.rename(`${dir}/plan.md`, `${dir}/planning.md`)).rejects.toThrow();
        expect(await fs.exists(`${dir}/plan.md`)).toBe(true);
        await scoped.close();

        // Unrestricted: rename moves the note and rewrites the link to it.
        const token = await requestLinksGrant(t, { provider: added.val.hash, filesystemGrant: fsGrant });
        const index = await openLinks(t, token);
        expect(await index.rename(`${dir}/plan.md`, `${dir}/planning.md`)).toBe(1);
        expect(await fs.exists(`${dir}/plan.md`)).toBe(false);
        expect(await fs.readFile(`${dir}/index.md`)).toContain("[[planning]]");
        await index.close();
        t.close();
    }, 30000);

    it("is the editor's link index and resolver: its panel and its links answer from the daemon", async () => {
        const t = await connect({ ws: WS });
        const wasm = new Uint8Array(await (await fetch("/fixtures/links.wasm")).arrayBuffer());
        const added = await addComponent(t, wasm, undefined);
        if (added.tag !== "ok") throw new Error(added.val);
        const fsGrant = await requestFilesystemGrant(t, "the vault");
        const fs = await wrpcFilesystem(t, fsGrant);
        const dir = `links-editor-${Date.now()}`;
        await fs.mkdir(dir, { recursive: false });
        await fs.writeFile(`${dir}/a.md`, `# A\n\nsee [[b]] and [[ghost]]\n`);
        await fs.writeFile(`${dir}/b.md`, `# B\n`);

        const token = await requestLinksGrant(t, { provider: added.val.hash, filesystemGrant: fsGrant });
        const links = editorLinks(openLinks(t, token), fs);
        const el = document.createElement("div");
        document.body.append(el);
        const editor = createEditor({ element: el, fs: { fs, filepath: `${dir}/b.md` }, links });
        const until = async (cond: () => boolean) => {
            for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
            expect(cond()).toBe(true);
        };
        const text = (sel: string) => [...el.querySelectorAll(sel)].map((n) => n.textContent);

        // The panel under b: a links here, as the daemon's index says.
        await until(() => text(".ezco-mde-links-name").includes("a"));

        // In a: the wikilink to b resolves, the one to ghost does not, and the
        // panel lists ghost as not written yet.
        await editor.storage.persistence.loadFile(`${dir}/a.md`);
        await until(() => text(".ezco-mde-wikilink.is-unresolved").join() === "ghost");
        await until(() => text(".ezco-mde-links-dangling .ezco-mde-links-name").join() === "ghost");

        editor.destroy();
        el.remove();
        await links.index.close();
        t.close();
    }, 30000);
});
