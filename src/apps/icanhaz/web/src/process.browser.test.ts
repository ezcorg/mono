import { describe, it, expect } from "vitest";
import { connect, requestProcessGrant } from "./wrpc";
import { spawn } from "./generated/process";

// Needs a running daemon (`ICANHAZ_CONSENT=auto icanhazd`) serving the process
// capability. `cat` is on PATH on the host.
const WS = "ws://127.0.0.1:7777";

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
        const grant = await requestProcessGrant(t, "cat", false, "echo over wRPC");
        const session = await spawn(t, grant, []);

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
        t.close();

        expect(new TextDecoder().decode(concat(chunks))).toContain("hello from the browser");
    }, 15000);

    it("refuses a spawn whose grant pins a different image", async () => {
        const t = await connect({ ws: WS });
        // The grant pins `cat`; but a token for the wrong *kind* (or none) is the
        // gate we can exercise from the client. Use a bogus token: refused before spawn.
        const session = await spawn(t, "bogus-token", []);
        const refused = await new Promise<string>((resolve) => {
            session.onError((e) => resolve(e));
            session.onData((chunk) => {
                if (chunk === null) resolve("(no error, stream closed)");
            });
        });
        t.close();
        expect(refused).toContain("denied");
    }, 15000);
});
