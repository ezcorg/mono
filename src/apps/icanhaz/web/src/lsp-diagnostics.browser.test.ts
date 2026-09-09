import { describe, it, expect } from "vitest";
import { connect } from "./wrpc";
import { createWrpcLspProvider } from "./lsp-provider";

// Needs a running daemon (`ICANHAZ_CONSENT=auto icanhazd`) with `rust-analyzer` +
// `cargo` on its PATH (~/.cargo/bin). Analyzes the .ra-fixture/ host Cargo project.
import { WS } from "./test-ws";
const WORKSPACE = "/Users/theo/dev/mono/src/apps/icanhaz/web/.ra-fixture";

describe("rust-analyzer real analysis over wRPC", () => {
    it("publishes a diagnostic for a bad Rust buffer in a host Cargo project", async () => {
        const t = await connect({ ws: WS });
        const provider = createWrpcLspProvider({
            transport: t,
            workspaceRoot: WORKSPACE,
            servers: { rust: { image: "rust-analyzer" } },
        });
        const conn = await provider.connect({ language: "rust", path: "src/main.rs", fs: undefined as any });
        const lsp = conn!.transport;
        const fileUri = conn!.uriForPath("src/main.rs");

        const pending = new Map<number, (m: any) => void>();
        // Resolve when rust-analyzer reports a non-empty diagnostic set for our file.
        const gotDiagnostics = new Promise<any[]>((resolve) => {
            lsp.subscribe((s) => {
                const m = JSON.parse(s);
                if (typeof m.id === "number" && pending.has(m.id)) {
                    pending.get(m.id)!(m);
                    pending.delete(m.id);
                    return;
                }
                if (
                    m.method === "textDocument/publishDiagnostics" &&
                    m.params?.uri === fileUri &&
                    m.params.diagnostics?.length > 0
                ) {
                    resolve(m.params.diagnostics);
                }
            });
        });
        const request = (id: number, method: string, params: unknown) =>
            new Promise<any>((resolve) => {
                pending.set(id, resolve);
                lsp.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            });
        const notify = (method: string, params?: unknown) =>
            lsp.send(JSON.stringify({ jsonrpc: "2.0", method, params }));

        await request(1, "initialize", {
            processId: null,
            rootUri: conn!.rootUri,
            workspaceFolders: [{ uri: conn!.rootUri, name: "ra-fixture" }],
            capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } },
        });
        notify("initialized", {});
        // Open a buffer with a syntax error (`let _x = ;`) — a parse diagnostic rust-
        // analyzer emits regardless of checkOnSave / type-inference config.
        notify("textDocument/didOpen", {
            textDocument: { uri: fileUri, languageId: "rust", version: 1, text: "fn main() {\n    let _x = ;\n}\n" },
        });

        const diagnostics = await gotDiagnostics;
        console.log("[rust-analyzer]", JSON.stringify(diagnostics.map((d: any) => d.message)));
        expect(diagnostics.length).toBeGreaterThan(0);

        notify("exit");
        t.close();
        // Warm runs land in ~2s (measured); the margin covers a cold rust-analyzer
        // sysroot index on first run. A real hang fails here, not after a minute+.
    }, 30000);
});
