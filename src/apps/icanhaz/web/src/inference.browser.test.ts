import { describe, it, expect } from "vitest";
import { connect } from "./wrpc";
import { requestScoped } from "./generated/broker";
import { complete, models } from "./generated/inference";
import { WS } from "./test-ws";

// Needs a running daemon with the loopback provider (`ICANHAZ_ECHO=1`, which the
// test harness sets): `echo` streams the last user turn back and reports usage.

/** Decode `[kind: u8][len: u32 BE][payload]` frames from the concatenated stream. */
function decodeFrames(bytes: Uint8Array): { kind: number; payload: string }[] {
    const out: { kind: number; payload: string }[] = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 0;
    while (i + 5 <= bytes.length) {
        const kind = bytes[i];
        const len = view.getUint32(i + 1);
        out.push({ kind, payload: new TextDecoder().decode(bytes.subarray(i + 5, i + 5 + len)) });
        i += 5 + len;
    }
    return out;
}

async function grant(t: Awaited<ReturnType<typeof connect>>, allow: string, modelsAllowed: string[]) {
    const res = await requestScoped(
        t,
        { tag: "inference", val: { models: modelsAllowed } },
        { when: "true", allow },
        "ask a model over wRPC",
        undefined,
    );
    if (res.tag !== "ok") throw new Error(`grant refused: ${JSON.stringify(res.val)}`);
    return res.val.token;
}

async function collect(session: Awaited<ReturnType<typeof complete>>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
        session.onError((e) => reject(new Error(e)));
        session.onData((chunk) => {
            if (chunk === null) resolve();
            else chunks.push(chunk);
        });
    });
    session.close();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return out;
}

describe("inference capability over wRPC (browser → host)", () => {
    it("lists the models the grant covers and streams a completion with usage", async () => {
        const t = await connect({ ws: WS });
        const token = await grant(t, "true", ["echo"]);

        const listed = await models(t, token);
        expect(listed.tag).toBe("ok");
        if (listed.tag !== "ok") return;
        expect(listed.val.map((m) => m.model)).toEqual(["echo"]);

        const session = await complete(t, token, {
            model: "echo",
            messages: [{ role: "user", content: "hello from the browser" }],
            maxTokens: 0,
            temperature: undefined,
            system: undefined,
        });
        const frames = decodeFrames(await collect(session));
        const text = frames.filter((f) => f.kind === 0).map((f) => f.payload).join("");
        expect(text).toBe("hello from the browser");
        const usage = frames.find((f) => f.kind === 1);
        expect(usage).toBeDefined();
        expect(JSON.parse(usage!.payload)).toEqual({ input_tokens: 4, output_tokens: 4 });
    });

    it("refuses a model outside the grant's allow clause, with the scope as a sentence", async () => {
        const t = await connect({ ws: WS });
        const token = await grant(t, 'call.args.request.model == "nope"', []);
        const session = await complete(t, token, {
            model: "echo",
            messages: [{ role: "user", content: "x" }],
            maxTokens: 0,
            temperature: undefined,
            system: undefined,
        });
        const err = await new Promise<string>((resolve) => {
            session.onError((e) => resolve(e));
            session.onData((chunk) => {
                if (chunk === null) resolve("stream ended without an error");
            });
        });
        session.close();
        expect(err).toContain("out of scope");
        expect(err).toContain("request model is “nope”");
    });

    it("type-checks the scope at grant time", async () => {
        const t = await connect({ ws: WS });
        const res = await requestScoped(
            t,
            { tag: "inference", val: { models: [] } },
            { when: "true", allow: "call.args.request.nope == 1" },
            "bad scope",
            undefined,
        );
        expect(res.tag).toBe("err");
        if (res.tag === "err") expect(res.val.tag).toBe("invalid-scope");
    });
});
