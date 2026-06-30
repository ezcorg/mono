import { describe, it, expect } from "vitest";
import { connect, requestTerminalGrant, requestFilesystemGrant, brokerGranted, openTerminal, getPairing, clearPairing } from "./wrpc";
import * as gen from "./generated/broker";
import * as term from "./generated/terminal";
import * as fsmount from "./generated/fs-mount";
import * as wasifs from "./generated/wasi-filesystem";

// A real browser webpage consuming the capability. Run against a daemon in
// auto-consent mode: `ICANHAZ_CONSENT=auto icanhazd`.
const WS = "ws://127.0.0.1:7777";

describe("icanhaz browser consumer", () => {
    it("the daemon attributes a grant to this page's real Origin", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestTerminalGrant(t, "browser e2e");
        expect(grant.length).toBeGreaterThan(0);

        // The browser sent its real Origin on the WS handshake; the daemon should
        // have bound the grant to a `web-origin` principal === this page's origin.
        const granted = await brokerGranted(t);
        const mine = granted.find((g) => g.holder.id === location.origin);
        expect(mine, `expected a grant for ${location.origin}; got ${JSON.stringify(granted)}`).toBeTruthy();
        expect(mine!.holder.kind).toBe("web-origin");
    });

    it("opens a real terminal over wRPC streams and the shell echoes back", async () => {
        const t = await connect({ ws: WS });
        const term = await openTerminal(t, { cols: 80, rows: 24 });
        let out = "";
        term.onOutput((b) => {
            out += new TextDecoder().decode(b);
        });
        const done = new Promise<void>((resolve) => {
            term.onExit(() => resolve());
            setTimeout(resolve, 10000);
        });
        await new Promise((r) => setTimeout(r, 1500)); // let the login shell settle
        term.write("echo browser-wrpc-works\n");
        await new Promise((r) => setTimeout(r, 500));
        term.write("exit\n");
        await done;
        t.close();
        expect(out).toContain("browser-wrpc-works");
    }, 20000);

    it("pairs the origin: stores a secret and reuses it on reconnect", async () => {
        await clearPairing();
        const t1 = await connect({ ws: WS });
        await requestTerminalGrant(t1, "first");
        t1.close();
        const s1 = await getPairing();
        expect(s1, "a pairing secret should be stored after first approval").toBeTruthy();

        // Reconnect + request again: the stored secret is presented; the daemon
        // recognizes it (origin-bound) and returns no NEW secret — so the stored
        // value is unchanged, proving the durable pairing was reused.
        const t2 = await connect({ ws: WS });
        await requestTerminalGrant(t2, "second");
        t2.close();
        expect(await getPairing()).toBe(s1);
    });

    it("GENERATED broker bindings round-trip against the daemon", async () => {
        const t = await connect({ ws: WS });
        // Generated encode: capability-kind variant + nested terminal-request + option.
        const want: gen.CapabilityKind = { tag: "terminal", val: { shell: undefined, jailed: false } };
        const g = await gen.request(t, want, "generated-binding test", undefined);
        expect(g.tag === "ok", `denied: ${JSON.stringify(g)}`).toBe(true);
        if (g.tag === "ok") expect(g.val.token.length).toBeGreaterThan(0);

        // A filesystem want exercises flags (fs-rights → fixed bytes) + a nested
        // record/list on the wire; the daemon granting it proves the encoding.
        const fsWant: gen.CapabilityKind = { tag: "filesystem", val: { roots: [{ path: "/jail/", rights: { read: true, write: true, create: true } }] } };
        const fg = await gen.request(t, fsWant, "generated fs flags", undefined);
        expect(fg.tag === "ok", `fs denied: ${JSON.stringify(fg)}`).toBe(true);

        // Generated decode: list<grant-info> with nested principal record + enum.
        const list = await gen.granted(t);
        expect(list.length).toBeGreaterThan(0);
        expect(list.some((x) => x.holder.kind === "web-origin" && x.holder.id === location.origin)).toBe(true);
    });

    it("GENERATED streaming terminal session opens + echoes", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestTerminalGrant(t, "generated streaming");
        const s = await term.open(t, grant, 80, 24); // generated session: input streams [1]/[2], output [0]
        const dec = new TextDecoder();
        const enc = new TextEncoder();
        let out = "";
        const done = new Promise<void>((resolve) => {
            s.onData((c) => (c ? (out += dec.decode(c)) : resolve()));
            setTimeout(resolve, 8000);
        });
        await new Promise((r) => setTimeout(r, 1500));
        s.stdin(enc.encode("echo gen-stream-works\n"));
        await new Promise((r) => setTimeout(r, 500));
        s.stdin(enc.encode("exit\n"));
        await done;
        s.close();
        expect(out).toContain("gen-stream-works");
    }, 20000);

    it("GENERATED wasi:filesystem bindings: grant → mount → read a real file", async () => {
        const t = await connect({ ws: WS });

        // The gate: a bogus token gets no descriptor.
        const denied = await fsmount.openRoot(t, "bogus-token");
        expect(denied.tag).toBe("err");

        // A consented filesystem grant exchanges for the root descriptor...
        const grant = await requestFilesystemGrant(t, "browser wasi:filesystem");
        const mounted = await fsmount.openRoot(t, grant);
        expect(mounted.tag, `mount denied: ${JSON.stringify(mounted)}`).toBe("ok");
        if (mounted.tag !== "ok") return;
        const root = mounted.val; // a wasi:filesystem descriptor (opaque handle)

        // ...then it's native wasi:filesystem: open + read the jail's hello.txt.
        const opened = await wasifs.descriptorOpenAt(t, root, {}, "hello.txt", {}, { read: true });
        expect(opened.tag, `open denied: ${JSON.stringify(opened)}`).toBe("ok");
        if (opened.tag !== "ok") return;
        const read = await wasifs.descriptorRead(t, opened.val, 1024n, 0n);
        expect(read.tag, `read denied: ${JSON.stringify(read)}`).toBe("ok");
        if (read.tag !== "ok") return;
        const [bytes] = read.val;
        expect(new TextDecoder().decode(bytes)).toContain("hello");

        // Write: the non-streaming `write` returns the bytes-written (a commit ack),
        // so the read-back is deterministic — no polling. (write-via-stream returns
        // a wasi:io output-stream, which wRPC's wasmtime bridge doesn't serve; the
        // non-streaming write is the correct path over wRPC.)
        const created = await wasifs.descriptorOpenAt(t, root, {}, "written.txt", { create: true, truncate: true }, { read: true, write: true });
        expect(created.tag, `create denied: ${JSON.stringify(created)}`).toBe("ok");
        if (created.tag !== "ok") return;
        const wrote = await wasifs.descriptorWrite(t, created.val, new TextEncoder().encode("plain-write-works"), 0n);
        // (val is a Filesize bigint on success — don't JSON.stringify it.)
        expect(wrote.tag, `write denied: ${wrote.tag === "err" ? wrote.val : ""}`).toBe("ok");
        const rb = await wasifs.descriptorRead(t, created.val, 1024n, 0n);
        expect(rb.tag, `read-back denied: ${rb.tag === "err" ? rb.val : ""}`).toBe("ok");
        if (rb.tag !== "ok") return;
        expect(new TextDecoder().decode(rb.val[0])).toContain("plain-write-works");

        // Streaming read LAST: read-via-stream rides a NATIVE wRPC stream (the
        // file's bytes flow on a sub-channel). Kept last because its mid-stream
        // close races the server's stream teardown and can stall a following call.
        const stream = await wasifs.descriptorReadViaStream(t, opened.val, 0n);
        const dec = new TextDecoder();
        let streamed = "";
        const sdone = new Promise<void>((resolve) => {
            stream.onData((chunk) => (chunk ? (streamed += dec.decode(chunk)) : resolve()));
            stream.onError(() => resolve());
            setTimeout(resolve, 5000);
        });
        await sdone;
        stream.close();
        expect(streamed).toContain("hello");
    });
});
