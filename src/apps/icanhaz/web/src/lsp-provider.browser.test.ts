import { describe, it, expect } from "vitest";
import { connect } from "./wrpc";
import { createWrpcLspProvider } from "./lsp-provider";

// Needs a running daemon (`ICANHAZ_CONSENT=auto icanhazd`) with `rust-analyzer` on
// its PATH. Proves the codeblock RemoteLspProvider wiring, not the editor UI.
const WS = "ws://127.0.0.1:7777";

const config = (transport: any) => ({
    transport,
    workspaceRoot: "/tmp/demo",
    servers: { rust: { image: "rust-analyzer" } },
});

describe("createWrpcLspProvider — codeblock RemoteLspProvider over wRPC", () => {
    it("serves only its registered languages", async () => {
        const t = await connect({ ws: WS });
        const provider = createWrpcLspProvider(config(t));
        expect(provider.serves("rust")).toBe(true);
        expect(provider.serves("python")).toBe(false);
        expect(provider.serves("typescript")).toBe(false);
        t.close();
    });

    it("connect('rust') yields the right URIs + a transport that drives rust-analyzer", async () => {
        const t = await connect({ ws: WS });
        const provider = createWrpcLspProvider(config(t));

        const conn = await provider.connect({ language: "rust", path: "src/main.rs", fs: undefined as any });
        expect(conn).not.toBeNull();
        // The workspace/URI model: real host paths under workspaceRoot.
        expect(conn!.rootUri).toBe("file:///tmp/demo");
        expect(conn!.uriForPath("src/main.rs")).toBe("file:///tmp/demo/src/main.rs");
        expect(conn!.pathForUri("file:///tmp/demo/src/main.rs")).toBe("src/main.rs");

        // The connection's transport really drives the host rust-analyzer.
        const pending = new Map<number, (m: any) => void>();
        conn!.transport.subscribe((s) => {
            const m = JSON.parse(s);
            if (typeof m.id === "number" && pending.has(m.id)) {
                pending.get(m.id)!(m);
                pending.delete(m.id);
            }
        });
        const init = await new Promise<any>((resolve) => {
            pending.set(1, resolve);
            conn!.transport.send(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: { processId: null, rootUri: conn!.rootUri, capabilities: {} },
                }),
            );
        });
        expect(init.result?.serverInfo?.name).toBe("rust-analyzer");

        conn!.transport.send(JSON.stringify({ jsonrpc: "2.0", method: "exit" }));
        t.close();
    }, 30000);
});
