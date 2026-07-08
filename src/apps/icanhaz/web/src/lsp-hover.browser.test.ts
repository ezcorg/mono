import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";

// A SEMANTIC LSP request (hover) end-to-end over wRPC: rust-analyzer answers a hover
// on the jail's src/main.rs. Unlike diagnostics (which include parse-level results),
// hover needs the file resolved inside the loaded workspace. Requires the daemon
// (rust-analyzer + cargo on PATH; jail = Cargo project) and NO foreign daemon on
// 7777 — a surface-mode daemon would park the grant awaiting manual consent.
import { WS } from "./test-ws";

describe("rust-analyzer hover over wRPC", () => {
    it("answers a hover on the jail's src/main.rs", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "rust hover");
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

        await request(1, "initialize", {
            processId: null,
            rootUri: conn!.rootUri,
            workspaceFolders: [{ uri: conn!.rootUri, name: "jail" }],
            capabilities: {},
        });
        notify("initialized", {});
        notify("textDocument/didOpen", {
            textDocument: { uri, languageId: "rust", version: 1, text: 'fn main() {\n    println!("hi");\n}\n' },
        });

        // Poll hover on `println` — it only answers once rust-analyzer has loaded the
        // workspace (fast when warm; a cold first index can take longer, which is what
        // makes an editor's first hover appear to "time out" before it's ready).
        let hover: any = null;
        for (let i = 0; i < 10 && !hover?.result; i++) {
            hover = await Promise.race([
                request(100 + i, "textDocument/hover", { textDocument: { uri }, position: { line: 1, character: 6 } }),
                new Promise((r) => setTimeout(() => r(null), 2000)),
            ]);
            if (!hover?.result) await new Promise((r) => setTimeout(r, 500));
        }
        notify("exit");
        t.close();

        expect(hover?.result).toBeTruthy();
    }, 45000);
});
