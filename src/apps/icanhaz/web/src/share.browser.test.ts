import { describe, it, expect } from "vitest";
import { connect } from "./wrpc";
import { requestScoped, revoke } from "./generated/broker";
import { spawn } from "./generated/process";
import { certificateRoot, createBundle, decodeBundle, openBundle } from "./share";
import { WS } from "./test-ws";

// A share bundle carries certificates, never tokens; opening it at the issuing
// broker yields grants of the recipient's own. The daemon runs with auto consent.

async function processGrant(t: Awaited<ReturnType<typeof connect>>) {
    const res = await requestScoped(
        t,
        { tag: "process", val: { image: "cat", args: [], guestChoosesArgv: true } },
        { when: "true", allow: "true" },
        "share cat",
        undefined,
    );
    if (res.tag !== "ok") throw new Error(`grant refused: ${JSON.stringify(res.val)}`);
    return res.val.token;
}

describe("share bundles (browser ↔ host)", () => {
    it("packages certificates with a document and opens into narrowed grants", async () => {
        const t = await connect({ ws: WS });
        const token = await processGrant(t);
        const text = await createBundle(t, "notes/plan.md", [
            {
                token,
                audience: { tag: "origin", val: location.origin },
                ttlSecs: 120,
                extra: { when: "true", allow: "size(call.args.args) < 2" },
                summary: "run cat here",
            },
            // Meant for someone else: the recipient's broker refuses it for us.
            { token, audience: { tag: "origin", val: "https://other.example" }, ttlSecs: 120, summary: "not ours" },
        ]);
        expect(text.startsWith("ezbundle1.")).toBe(true);
        const bundle = decodeBundle(text);
        expect(bundle.document).toBe("notes/plan.md");
        expect(bundle.grants).toHaveLength(2);
        // The bundle is readable without any key, and holds no bearer token.
        expect(text).not.toContain(token);
        const root = certificateRoot(bundle.grants[0]!.cert);
        expect(root.issuer).toBe(bundle.issuer);
        expect(root.audience).toEqual({ origin: location.origin });

        const opened = await openBundle(t, text);
        expect(opened.document).toBe("notes/plan.md");
        const [mine, theirs] = opened.grants;
        expect(mine && "token" in mine).toBe(true);
        expect(theirs).toEqual({ summary: "not ours", refused: "not-authorized" });
        if (!mine || !("token" in mine)) return;
        // The redeemed grant is narrowed by the share-time clause.
        const ok = await spawn(t, mine.token, []);
        ok.close();
        const denied = await spawn(t, mine.token, ["a", "b"]);
        const err = await new Promise<string>((resolve) => {
            denied.onError((e) => resolve(e));
            denied.onData((chunk) => {
                if (chunk === null) resolve("stream ended without an error");
            });
        });
        denied.close();
        expect(err).toMatch(/out of scope/);

        // Revoking the source voids the bundle. (The certificate meant for
        // another audience is still refused for *that* reason first: a
        // non-audience never learns whether the source is live.)
        await revoke(t, token);
        const again = await openBundle(t, text);
        expect(again.grants).toEqual([
            { summary: "run cat here", refused: "revoked" },
            { summary: "not ours", refused: "not-authorized" },
        ]);
    });

    it("refuses a bundle from another broker and malformed text", async () => {
        const t = await connect({ ws: WS });
        await expect(openBundle(t, "nonsense")).rejects.toThrow(/not a share bundle/);
        const foreign = "ezbundle1." + btoa(JSON.stringify({ v: 1, issuer: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", grants: [] }));
        await expect(openBundle(t, foreign)).rejects.toThrow(/another broker/);
    });
});
