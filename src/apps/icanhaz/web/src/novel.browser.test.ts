import { describe, it, expect } from "vitest";
import { connect, invoke, encodeString, readString, readU8, resultValue } from "./wrpc";
import { add } from "./generated/components";
import { requestScoped } from "./generated/broker";
import { WS } from "./test-ws";

// A novel capability: nothing native provides `example:greeter/greeter`. A page
// adds the component, asks for a `component` grant naming it as the provider,
// and calls the interface with the token first, the way every capability is
// called. The daemon serves it from the store the moment it lands.

const IFACE = "example:greeter/greeter@0.1.0";

describe("a novel capability from the store (browser → host)", () => {
    it("adds the greeter, is granted it, and greets through it", async () => {
        const t = await connect({ ws: WS });
        const wasm = new Uint8Array(await (await fetch("/fixtures/greeter.wasm")).arrayBuffer());
        const added = await add(t, wasm, undefined);
        expect(added.tag, added.tag === "err" ? added.val : "").toBe("ok");
        if (added.tag !== "ok") return;
        expect(added.val.exports).toContain(IFACE);

        const grant = await requestScoped(
            t,
            { tag: "component", val: { provides: IFACE, provider: added.val.hash } },
            { when: "true", allow: 'call.method == "greet"' },
            "say hello",
            undefined,
        );
        expect(grant.tag, grant.tag === "err" ? String(grant.val.tag) : "").toBe("ok");
        if (grant.tag !== "ok") return;
        const token = grant.val.token;

        // greet(grant: string, name: string) -> result<string, string>
        const greet = async (name: string): Promise<{ ok: string } | { err: string }> => {
            // The generic component server frames every reply as
            // `result<payload, error>` (a trap comes back as the error), the
            // way the filesystem mount's stub already unwraps it.
            const out = resultValue(await invoke(t, IFACE, "greet", [...encodeString(token), ...encodeString(name)]));
            const [disc, o] = readU8(out, 0);
            const [text] = readString(out, o);
            return disc === 0 ? { ok: text } : { err: text };
        };
        expect(await greet("browser")).toEqual({ ok: `hello, browser (grant ${token.slice(0, 4)}…)` });
        // The component's own refusal comes through as its error.
        expect(await greet("")).toEqual({ err: "greeter: who?" });
    });
});
