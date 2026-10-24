import { describe, it, expect } from "vitest";
import { connect } from "./wrpc";
import { requestScoped } from "./generated/broker";
import { open, sessionComplete, sessionModels, type SessionCompleteSession } from "./generated/inference";
import { WS } from "./test-ws";

// Needs a running daemon with the loopback provider (`ICANHAZ_ECHO=1`, which the
// test harness sets): `echo` streams the last user turn back and reports usage.

/** Decode `[kind: u8][len: u32 BE][payload]` frames from the concatenated stream. */
function decodeFrames(bytes: Uint8Array): { kind: number; payload: string }[] {
    const out: { kind: number; payload: string }[] = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 0;
    while (i + 5 <= bytes.length) {
        const kind = bytes[i] ?? 0;
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

/** The token once: `open` yields the session object every call runs on. */
async function session(t: Awaited<ReturnType<typeof connect>>, token: string): Promise<Uint8Array> {
    const s = await open(t, token);
    if (s.tag !== "ok") throw new Error(`inference refused: ${s.val}`);
    return s.val;
}

async function collect(session: SessionCompleteSession): Promise<Uint8Array> {
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
        const s = await session(t, await grant(t, "true", ["echo"]));

        const listed = await sessionModels(t, s);
        expect(listed.tag).toBe("ok");
        if (listed.tag !== "ok") return;
        expect(listed.val.map((m) => m.model)).toEqual(["echo"]);

        const call = await sessionComplete(t, s, {
            model: "echo",
            messages: [{ role: "user", content: "hello from the browser", toolCalls: [], toolCallId: undefined }],
            tools: [],
            maxTokens: 0,
            temperature: undefined,
            system: undefined,
        });
        const frames = decodeFrames(await collect(call));
        const text = frames.filter((f) => f.kind === 0).map((f) => f.payload).join("");
        expect(text).toBe("hello from the browser");
        const usage = frames.find((f) => f.kind === 1);
        expect(usage).toBeDefined();
        expect(JSON.parse(usage!.payload)).toEqual({ input_tokens: 4, output_tokens: 4 });
    });

    it("refuses a model outside the grant's allow clause, with the scope as a sentence", async () => {
        const t = await connect({ ws: WS });
        // The grant is live, so the session opens; the clause is applied per call.
        const s = await session(t, await grant(t, 'call.args.request.model == "nope"', []));
        const call = await sessionComplete(t, s, {
            model: "echo",
            messages: [{ role: "user", content: "x", toolCalls: [], toolCallId: undefined }],
            tools: [],
            maxTokens: 0,
            temperature: undefined,
            system: undefined,
        });
        const err = await new Promise<string>((resolve) => {
            call.onError((e) => resolve(e));
            call.onData((chunk) => {
                if (chunk === null) resolve("stream ended without an error");
            });
        });
        call.close();
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
    it("relays a tool call as a kind-3 frame and continues after the tool turn", async () => {
        const t = await connect({ ws: WS });
        const s = await session(t, await grant(t, "true", ["echo"]));
        const tools = [{ name: "search", description: "find things", parameters: '{"type":"object"}' }];
        const first = await sessionComplete(t, s, {
            model: "echo",
            messages: [{ role: "user", content: "find x", toolCalls: [], toolCallId: undefined }],
            tools,
            maxTokens: 0,
            temperature: undefined,
            system: undefined,
        });
        const frames = decodeFrames(await collect(first));
        const [head, next] = frames;
        expect(head?.kind).toBe(3);
        const call = JSON.parse(head?.payload ?? "{}") as { id: string; name: string; arguments: string };
        expect(call.name).toBe("search");
        expect(JSON.parse(call.arguments)).toEqual({ input: "find x" });
        expect(next?.kind).toBe(1);

        // The page ran the tool with its own capabilities; hand the answer back.
        const second = await sessionComplete(t, s, {
            model: "echo",
            messages: [
                { role: "user", content: "find x", toolCalls: [], toolCallId: undefined },
                { role: "assistant", content: "", toolCalls: [call], toolCallId: undefined },
                { role: "tool", content: "found it", toolCalls: [], toolCallId: call.id },
            ],
            tools,
            maxTokens: 0,
            temperature: undefined,
            system: undefined,
        });
        const reply = decodeFrames(await collect(second));
        expect(reply.filter((f) => f.kind === 0).map((f) => f.payload).join("")).toBe("found it");
    });
});
