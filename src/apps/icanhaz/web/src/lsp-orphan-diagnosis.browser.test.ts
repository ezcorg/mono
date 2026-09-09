import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";

// Why does src/lib.rs (created AFTER rust-analyzer loaded) show no diagnostics?
// Hypothesis: the jail is a bin crate (src/main.rs); rust-analyzer's `cargo metadata`
// only knows that target, so a later src/lib.rs is an orphan not in the crate graph.
// Control: src/main.rs (in the graph) with the same invalid content SHOULD diagnose.
import { WS } from "./test-ws";
const INVALID = "pub fn test() {\n    oopsinvalidsyntax\n    return;\n}\n";

describe("orphan file diagnostics — src/main.rs (in graph) vs src/lib.rs (added after load)", () => {
    it("rust-analyzer diagnoses BOTH main.rs and a src/lib.rs added after load → missing editor diagnostics are editor-side", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "orphan diagnosis");
        const fs = await wrpcFilesystem(t, grant);
        const rp = await rootPath(t, grant);
        if (rp.tag !== "ok") throw new Error(`no workspace path: ${rp.val}`);
        const provider = createWrpcLspProvider({
            transport: t,
            workspaceRoot: rp.val,
            servers: { rust: { image: "rust-analyzer" } },
        });
        const conn = await provider.connect({ language: "rust", path: "src/main.rs", fs: undefined as any });
        const lsp = conn!.transport;

        const diagnostics = new Map<string, any[]>();
        const pending = new Map<number, (m: any) => void>();
        lsp.subscribe((s) => {
            const m = JSON.parse(s);
            if (typeof m.id === "number" && pending.has(m.id)) {
                pending.get(m.id)!(m);
                pending.delete(m.id);
                return;
            }
            if (m.method === "textDocument/publishDiagnostics") {
                diagnostics.set(m.params.uri, m.params.diagnostics);
            }
        });
        const request = (id: number, method: string, params: unknown) =>
            new Promise<any>((res) => {
                pending.set(id, res);
                lsp.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
            });
        const notify = (method: string, params?: unknown) =>
            lsp.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
        const waitForDiag = async (uri: string, ms: number) => {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
                if ((diagnostics.get(uri)?.length ?? 0) > 0) return true;
                await new Promise((r) => setTimeout(r, 500));
            }
            return false;
        };

        await request(1, "initialize", { processId: null, rootUri: conn!.rootUri, capabilities: {} });
        notify("initialized", {});

        // CONTROL: main.rs is the bin crate root → in the graph → should diagnose.
        const mainUri = conn!.uriForPath("src/main.rs");
        notify("textDocument/didOpen", {
            textDocument: { uri: mainUri, languageId: "rust", version: 1, text: INVALID },
        });
        const mainHasDiag = await waitForDiag(mainUri, 20000);

        // Now create src/lib.rs AFTER rust-analyzer has loaded, then open it — the user's flow.
        await fs.writeFile("src/lib.rs", INVALID);
        const libUri = conn!.uriForPath("src/lib.rs");
        notify("textDocument/didOpen", {
            textDocument: { uri: libUri, languageId: "rust", version: 1, text: INVALID },
        });
        const libHasDiag = await waitForDiag(libUri, 12000);

        notify("exit");
        await fs.unlink("src/lib.rs").catch(() => {});
        t.close();

        // FINDING: rust-analyzer diagnoses BOTH — the in-graph main.rs AND a src/lib.rs
        // created after load (picked up fast). So "no diagnostics on src/lib.rs" in the
        // editor is EDITOR-side (didOpen URI / diagnostic rendering), not rust-analyzer.
        expect({ main: mainHasDiag, lib: libHasDiag }).toEqual({ main: true, lib: true });
    }, 60000);
});
