import { describe, it, expect } from "vitest";
import { connect, requestProcessGrant } from "./wrpc";
import { open, processSpawn } from "./generated/process";
import { drop } from "./generated/resources";

// Needs a running daemon (`ICANHAZ_CONSENT=auto icanhazd`) serving the process
// capability. `cat` is on PATH on the host.
import { WS } from "./test-ws";

function concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return out;
}

describe("process capability over wRPC (browser → host)", () => {
    it("spawns a grant-pinned `cat` and round-trips stdin → stdout", async () => {
        const t = await connect({ ws: WS });
        // Consent for the `cat` image specifically — the grant pins which program.
        const grant = await requestProcessGrant(t, "cat", [], false, "echo over wRPC");
        // The token once, at open: the `process` object is the capability.
        const proc = await open(t, grant);
        expect(proc.tag, proc.tag === "err" ? proc.val : "").toBe("ok");
        if (proc.tag !== "ok") return;
        const session = await processSpawn(t, proc.val, []);

        const chunks: Uint8Array[] = [];
        const done = new Promise<void>((resolve, reject) => {
            session.onData((chunk) => {
                if (chunk === null) resolve(); // stream end (cat exited)
                else chunks.push(chunk);
            });
            session.onError((e) => reject(new Error(`spawn refused: ${e}`)));
        });

        // Send a line, then EOF — `cat` echoes the line and exits when stdin closes.
        session.stdin(new TextEncoder().encode("hello from the browser\n"));
        session.closeStdin();

        await done;
        session.close();
        // Done with the object: release it on the daemon.
        expect(await drop(t, proc.val)).toBe(true);
        t.close();

        expect(new TextDecoder().decode(concat(chunks))).toContain("hello from the browser");
    }, 15000);

    it("refuses to open the capability for an unknown token", async () => {
        const t = await connect({ ws: WS });
        // The gate runs once, at `open`: a token that is not a live process
        // grant yields no object, so there is nothing to spawn on.
        const refused = await open(t, "bogus-token");
        t.close();
        expect(refused.tag).toBe("err");
        if (refused.tag === "err") expect(refused.val).toContain("denied");
    }, 15000);
});
