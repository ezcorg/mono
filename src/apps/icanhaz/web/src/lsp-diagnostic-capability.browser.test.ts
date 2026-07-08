import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";

// ROOT CAUSE of "no diagnostics in the editor": @codemirror/lsp-client advertises
// `textDocument.diagnostic` (client.ts:66) = PULL diagnostics, but only implements the
// PUSH handler (textDocument/publishDiagnostics) — it never pulls, and answers
// workspace/diagnostic/refresh with -32601. rust-analyzer, seeing pull support, STOPS
// pushing publishDiagnostics → diagnostics never arrive. This test toggles ONLY that
// capability: WITHOUT it rust-analyzer pushes; WITH it (as the editor sends) it doesn't.
import { WS } from "./test-ws";
const INVALID_MAIN = 'fn main() {\n    let x: i32 = "nope";\n}\n'; // a type error → a diagnostic

async function pushesDiagnostics(withPullCapability: boolean, ms: number): Promise<boolean> {
    const t = await connect({ ws: WS });
    const grant = await requestFilesystemGrant(t, "diagnostic capability");
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
        // Any server→client request → answer -32601, exactly as @codemirror/lsp-client does
        // for workspace/diagnostic/refresh (so rust-analyzer isn't left blocking on us).
        if (m.method !== undefined && m.id !== undefined) {
            lsp.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not implemented" } }));
            return;
        }
        if (m.method === "textDocument/publishDiagnostics") diagnostics.set(m.params.uri, m.params.diagnostics);
    });
    const request = (id: number, method: string, params: unknown) =>
        new Promise<any>((res) => {
            pending.set(id, res);
            lsp.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    const notify = (method: string, params?: unknown) =>
        lsp.send(JSON.stringify({ jsonrpc: "2.0", method, params }));

    // Mirror the editor client's capabilities, toggling ONLY textDocument.diagnostic.
    const capabilities: any = { textDocument: { publishDiagnostics: { versionSupport: true } } };
    if (withPullCapability) capabilities.textDocument.diagnostic = {}; // the client.ts:66 line
    await request(1, "initialize", { processId: null, rootUri: conn!.rootUri, capabilities });
    notify("initialized", {});
    const uri = conn!.uriForPath("src/main.rs");
    notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "rust", version: 1, text: INVALID_MAIN },
    });

    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if ((diagnostics.get(uri)?.length ?? 0) > 0) {
            notify("exit");
            t.close();
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    notify("exit");
    t.close();
    return false;
}

describe("root cause: textDocument.diagnostic (pull) suppresses rust-analyzer's push diagnostics", () => {
    it("WITHOUT textDocument.diagnostic → rust-analyzer PUSHES publishDiagnostics (diagnostics work)", async () => {
        expect(await pushesDiagnostics(false, 20000)).toBe(true);
    }, 30000);

    it("WITH textDocument.diagnostic (as @codemirror/lsp-client sends) → NO push → no diagnostics (the editor bug)", async () => {
        expect(await pushesDiagnostics(true, 15000)).toBe(false);
    }, 25000);
});
