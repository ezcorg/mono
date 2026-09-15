import { describe, it, expect } from "vitest";
import { connect } from "./wrpc";
import { certify, identity, redeem, requestScoped, revoke } from "./generated/broker";
import { spawn } from "./generated/process";
import { WS } from "./test-ws";

// Certificates: a grant travels as a signed sturdy reference (`ezcap1.…`)
// bound to an audience, and is redeemed at the issuing broker for a grant
// narrowed by every clause in its chain. The daemon runs with auto consent.

async function processGrant(t: Awaited<ReturnType<typeof connect>>, allow: string) {
    const res = await requestScoped(
        t,
        { tag: "process", val: { image: "cat", args: [], guestChoosesArgv: true } },
        { when: "true", allow },
        "share cat",
        undefined,
    );
    if (res.tag !== "ok") throw new Error(`grant refused: ${JSON.stringify(res.val)}`);
    return res.val.token;
}

/** The chain is public: read its root without any key. */
function decodeCert(cert: string): { root: { instance: string; issuer: string; audience: unknown; expires: number } } {
    const body = cert.replace(/^ezcap1\./, "").replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(body));
}

describe("certificates over wRPC (browser → host)", () => {
    it("issues a certificate the same origin redeems for a narrowed grant", async () => {
        const t = await connect({ ws: WS });
        const token = await processGrant(t, "true");
        const me = await identity(t);
        expect(me).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const issued = await certify(
            t,
            token,
            { tag: "origin", val: location.origin },
            60n,
            { when: "true", allow: "size(call.args.args) < 2" },
        );
        expect(issued.tag).toBe("ok");
        if (issued.tag !== "ok") return;
        const cert = issued.val;
        expect(cert.startsWith("ezcap1.")).toBe(true);
        const root = decodeCert(cert).root;
        expect(root.issuer).toBe(me);
        expect(root.instance).not.toBe(token); // never the bearer token
        expect(root.audience).toEqual({ origin: location.origin });

        const redeemed = await redeem(t, cert);
        expect(redeemed.tag).toBe("ok");
        if (redeemed.tag !== "ok") return;
        // The redeemed grant is usable, within the chain's clause…
        const ok = await spawn(t, redeemed.val.token, []);
        ok.close();
        // …and refused outside it (two args), with the clause as a sentence.
        const denied = await spawn(t, redeemed.val.token, ["a", "b"]);
        const err = await new Promise<string>((resolve) => {
            denied.onError((e) => resolve(e));
            denied.onData((chunk) => {
                if (chunk === null) resolve("stream ended without an error");
            });
        });
        denied.close();
        expect(err).toMatch(/out of scope/);
        expect(err).toContain("args");
    });

    it("refuses another audience, a tampered chain, and a revoked source", async () => {
        const t = await connect({ ws: WS });
        const token = await processGrant(t, "true");

        const elsewhere = await certify(t, token, { tag: "origin", val: "https://other.example" }, 60n, {
            when: "true",
            allow: "true",
        });
        expect(elsewhere.tag).toBe("ok");
        if (elsewhere.tag !== "ok") return;
        const refused = await redeem(t, elsewhere.val);
        expect(refused).toEqual({ tag: "err", val: { tag: "not-authorized" } });

        const mine = await certify(t, token, { tag: "origin", val: location.origin }, 60n, { when: "true", allow: "true" });
        expect(mine.tag).toBe("ok");
        if (mine.tag !== "ok") return;
        const tampered = mine.val.slice(0, -4) + "AAAA";
        expect(await redeem(t, tampered)).toEqual({ tag: "err", val: { tag: "not-authorized" } });

        // A clause that does not compile against `process` is refused when certifying.
        const bad = await certify(t, token, { tag: "any" }, 60n, { when: "true", allow: "call.args.nope == 1" });
        expect(bad.tag).toBe("err");
        if (bad.tag === "err") expect(bad.val.tag).toBe("invalid-scope");

        await revoke(t, token);
        expect(await redeem(t, mine.val)).toEqual({ tag: "err", val: { tag: "revoked" } });
    });
});
