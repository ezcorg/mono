/**
 * Node proof that the *browser-style* wRPC client (src/wrpc.ts) speaks the real
 * wire format: it drives a running `icanhazd` and checks the policy membrane
 * holds end to end. Node ≥22 has the same `WebSocket` global the browser uses
 * (but no `WebTransport`), so `connect()` here selects the WebSocket transport —
 * exercising the exact fallback code path a browser takes on older iOS.
 *
 *   ICANHAZ_URL=ws://127.0.0.1:7777 node --experimental-strip-types test-wrpc.ts
 */
import { FsLite, connect } from "./src/wrpc.ts";

const ws = process.env.ICANHAZ_URL ?? "ws://127.0.0.1:7777";
const dec = new TextDecoder();
const show = (r: { ok: unknown } | { err: string }) =>
    "ok" in r ? `ok(${r.ok instanceof Uint8Array ? JSON.stringify(dec.decode(r.ok)) : JSON.stringify(r.ok)})` : `ERR: ${r.err}`;

async function main() {
    const t = await connect({ ws }); // Node → WebSocket (no WebTransport global)
    console.log(`transport: ${t.kind}`);
    const fs = new FsLite(t);

    let pass = true;
    const expect = (cond: boolean, msg: string) => {
        console.log(`${cond ? "✓" : "✗"} ${msg}`);
        if (!cond) pass = false;
    };

    // Inside the jail: write then read round-trips through the policy component.
    const w = await fs.write("/jail/note.txt", new TextEncoder().encode("via browser-style wRPC"));
    console.log("  write /jail/note.txt ->", show(w));
    expect("ok" in w, "write inside the jail is allowed");

    const r = await fs.read("/jail/note.txt");
    console.log("  read  /jail/note.txt ->", show(r));
    expect("ok" in r && dec.decode(r.ok) === "via browser-style wRPC", "read-back matches what we wrote");

    const hello = await fs.read("/jail/hello.txt");
    console.log("  read  /jail/hello.txt ->", show(hello));
    expect("ok" in hello && dec.decode(hello.ok).includes("inside the jail"), "seeded jail file is readable");

    // Outside the jail: the policy denies it before it reaches the raw fs.
    const passwd = await fs.read("/etc/passwd");
    console.log("  read  /etc/passwd ->", show(passwd));
    expect("err" in passwd, "/etc/passwd is denied by the policy");

    const secret = await fs.read("/secret.txt");
    console.log("  read  /secret.txt ->", show(secret));
    expect("err" in secret, "/secret.txt (outside the jail) is denied");

    t.close();
    console.log(pass ? `\nPASS — wRPC over ${t.kind}; the membrane holds.` : "\nFAIL");
    process.exit(pass ? 0 : 1);
}
main().catch((e) => {
    console.error("test error:", e);
    process.exit(1);
});
