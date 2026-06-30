import { describe, it, expect } from "vitest";
import { connect, requestProcessGrant } from "./wrpc";
import { spawn } from "./generated/process";
import { processLspTransport } from "./lsp-transport";

// Needs a running daemon (`ICANHAZ_CONSENT=auto icanhazd`) and `rust-analyzer` on
// the daemon's PATH (~/.cargo/bin). The grant pins the `rust-analyzer` image.
const WS = "ws://127.0.0.1:7777";

describe("remote LSP over the wRPC process capability (rust-analyzer)", () => {
    it("completes the LSP initialize handshake with the host's rust-analyzer", async () => {
        const t = await connect({ ws: WS });
        // Consent pins the `rust-analyzer` image; it needs no argv for stdio mode.
        const grant = await requestProcessGrant(t, "rust-analyzer", false, "rust language server");
        const session = await spawn(t, grant, []);
        const lsp = processLspTransport(session);

        // Minimal JSON-RPC client over the transport: correlate responses by id,
        // ignore the server's notifications (logMessage / progress).
        const pending = new Map<number, (msg: any) => void>();
        lsp.subscribe((s) => {
            const msg = JSON.parse(s);
            if (typeof msg.id === "number" && pending.has(msg.id)) {
                pending.get(msg.id)!(msg);
                pending.delete(msg.id);
            }
        });
        const request = (id: number, method: string, params: unknown) =>
            new Promise<any>((resolve) => {
                pending.set(id, resolve);
                lsp.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            });
        const notify = (method: string, params?: unknown) =>
            lsp.send(JSON.stringify({ jsonrpc: "2.0", method, params }));

        // The proof: a full LSP request/response round-trips over wRPC →
        // process.spawn → rust-analyzer → Content-Length-framed reply → back.
        const init = await request(1, "initialize", {
            processId: null,
            rootUri: null,
            capabilities: {},
        });
        expect(init.result?.capabilities).toBeDefined();
        expect(init.result?.serverInfo?.name).toBe("rust-analyzer");

        // Be a well-behaved client, then let the server exit.
        notify("initialized", {});
        notify("exit");
        session.close();
        t.close();
    }, 30000);
});
