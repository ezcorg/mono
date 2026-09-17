import { describe, it, expect } from "vitest";
import { connect } from "./wrpc";
import { add, all, get, remove } from "./generated/components";
import { WS } from "./test-ws";

// The component store: code by hash. The daemon seeds it with the shipped
// fs-passthrough; a page may add and fetch components, not remove them.

describe("component store over wRPC (browser → host)", () => {
    it("lists the shipped passthrough, serves its bytes, and validates what is added", async () => {
        const t = await connect({ ws: WS });
        const listed = await all(t);
        const passthrough = listed.find((c) => c.exports.some((e) => e.startsWith("icanhaz:fspass/mount")));
        expect(passthrough, listed.map((c) => c.hash).join(",")).toBeDefined();
        if (!passthrough) return;
        expect(passthrough.hash.startsWith("sha256:")).toBe(true);
        expect(passthrough.imports.some((i) => i.startsWith("icanhaz:fspass/gate"))).toBe(true);

        const bytes = await get(t, passthrough.hash);
        expect(bytes.tag).toBe("ok");
        if (bytes.tag === "ok") expect(BigInt(bytes.val.length)).toBe(passthrough.size);

        // Adding what is there is idempotent; garbage is refused with a reason.
        if (bytes.tag === "ok") {
            const again = await add(t, bytes.val, undefined);
            expect(again.tag).toBe("ok");
            if (again.tag === "ok") expect(again.val.hash).toBe(passthrough.hash);
        }
        const junk = await add(t, new TextEncoder().encode("not wasm"), undefined);
        expect(junk.tag).toBe("err");
        if (junk.tag === "err") expect(junk.val).toMatch(/not a WebAssembly component/);

        // A page cannot remove components.
        const refused = await remove(t, passthrough.hash);
        expect(refused).toEqual({ tag: "err", val: expect.stringMatching(/local hosts/) });
    });
});
