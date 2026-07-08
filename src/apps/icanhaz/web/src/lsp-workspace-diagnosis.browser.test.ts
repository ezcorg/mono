import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";
import { setLspTrace, type LspTraceEvent } from "./lsp-transport";

// DIAGNOSIS: the editor's @codemirror/lsp-client sends `initialize` with rootUri but
// NO workspaceFolders (client.ts:321). This test isolates that single difference:
// hover WITH workspaceFolders vs WITHOUT, everything else identical. If WITHOUT fails
// and WITH passes, the missing workspaceFolders is why the editor's hover times out.
// Needs a clean daemon on 7777 (rust-analyzer + cargo on PATH; jail = Cargo project).
import { WS } from "./test-ws";

async function hoverResult(withWorkspaceFolders: boolean, pollMs: number): Promise<unknown> {
    const t = await connect({ ws: WS });
    const grant = await requestFilesystemGrant(t, "hover diagnosis");
    const rp = await rootPath(t, grant);
    if (rp.tag !== "ok") throw new Error(`no workspace path: ${rp.val}`);
    const provider = createWrpcLspProvider({
        transport: t,
        workspaceRoot: rp.val,
        servers: { rust: { image: "rust-analyzer" } },
    });
    const conn = await provider.connect({ language: "rust", path: "src/main.rs", fs: undefined as any });
    const lsp = conn!.transport;
    const uri = conn!.uriForPath("src/main.rs");

    const pending = new Map<number, (m: any) => void>();
    lsp.subscribe((s) => {
        const m = JSON.parse(s);
        if (typeof m.id === "number" && pending.has(m.id)) {
            pending.get(m.id)!(m);
            pending.delete(m.id);
        }
    });
    const request = (id: number, method: string, params: unknown) =>
        new Promise<any>((res) => {
            pending.set(id, res);
            lsp.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    const notify = (method: string, params?: unknown) =>
        lsp.send(JSON.stringify({ jsonrpc: "2.0", method, params }));

    // Mirror @codemirror/lsp-client's initialize exactly, toggling only workspaceFolders.
    const initParams: any = {
        processId: null,
        clientInfo: { name: "diagnosis" },
        rootUri: conn!.rootUri,
        capabilities: {},
    };
    if (withWorkspaceFolders) initParams.workspaceFolders = [{ uri: conn!.rootUri, name: "jail" }];
    await request(1, "initialize", initParams);
    notify("initialized", {});
    notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "rust", version: 1, text: 'fn main() {\n    println!("hi");\n}\n' },
    });

    const deadline = Date.now() + pollMs;
    let hover: any = null;
    let i = 0;
    while (Date.now() < deadline && !hover?.result) {
        hover = await Promise.race([
            request(100 + i++, "textDocument/hover", { textDocument: { uri }, position: { line: 1, character: 6 } }),
            new Promise((r) => setTimeout(() => r(null), 2000)),
        ]);
        if (!hover?.result) await new Promise((r) => setTimeout(r, 500));
    }
    notify("exit");
    t.close();
    return hover?.result ?? null;
}

describe("hover diagnosis — workspaceFolders vs rootUri only", () => {
    it("WITH workspaceFolders: rust-analyzer answers hover", async () => {
        expect(await hoverResult(true, 20000)).toBeTruthy();
    }, 30000);

    it("WITHOUT workspaceFolders (as @codemirror/lsp-client sends): hover STILL resolves — so workspaceFolders is NOT the cause", async () => {
        expect(await hoverResult(false, 20000)).toBeTruthy();
    }, 30000);

    it("the LSP tracer (setLspTrace) captures the wire traffic — the diagnostic hook", async () => {
        const events: LspTraceEvent[] = [];
        setLspTrace((ev) => events.push(ev));
        try {
            await hoverResult(true, 10000);
        } finally {
            setLspTrace(null);
        }
        // The hook a real session uses to see what the server does, both directions.
        expect(events.some((e) => e.dir === "send" && e.method === "initialize")).toBe(true);
        expect(events.some((e) => e.dir === "recv" && e.kind === "response")).toBe(true);
        expect(events.some((e) => e.method === "textDocument/didOpen")).toBe(true);
        expect(events.some((e) => e.method === "textDocument/hover")).toBe(true);
    }, 20000);
});
