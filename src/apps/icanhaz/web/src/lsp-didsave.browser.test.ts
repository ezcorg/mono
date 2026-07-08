import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";

// Cargo-check errors (unresolved fn `a()`) show on load (flycheck) but never clear on edit,
// because flycheck re-runs on textDocument/didSave — which the client doesn't send (it sends
// only didChangeWatchedFiles). Verify: open with `a()` → error; remove it + write disk + didSave
// → the error clears. If so, the fix is to send didSave from codeblock's autosave.
import { WS } from "./test-ws";
const BROKEN = "fn main() {\n    a();\n}\n"; // a() undefined → cargo-check error
const FIXED = "fn main() {\n}\n";

describe("didSave triggers flycheck to clear a cargo-check error", () => {
    it("remove a() + write disk + didSave → the diagnostic clears", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "didSave");
        const fs = await wrpcFilesystem(t, grant);
        await fs.writeFile("src/main.rs", BROKEN);
        const rp = await rootPath(t, grant);
        if (rp.tag !== "ok") throw new Error(`no workspace path: ${rp.val}`);
        const provider = createWrpcLspProvider({ transport: t, workspaceRoot: rp.val, servers: { rust: { image: "rust-analyzer" } } });
        const conn = await provider.connect({ language: "rust", path: "src/main.rs", fs: undefined as any });
        const lsp = conn!.transport;
        const uri = conn!.uriForPath("src/main.rs");

        const diags: number[] = [];
        const pending = new Map<number, (m: any) => void>();
        lsp.subscribe((s) => {
            const m = JSON.parse(s);
            if (typeof m.id === "number" && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
            if (m.method !== undefined && m.id !== undefined) { lsp.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } })); return; }
            if (m.method === "textDocument/publishDiagnostics" && m.params.uri === uri) diags.push(m.params.diagnostics.length);
        });
        const request = (id: number, method: string, params: unknown) =>
            new Promise<any>((res) => { pending.set(id, res); lsp.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
        const notify = (method: string, params?: unknown) => lsp.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
        const waitUntil = async (pred: () => boolean, ms: number) => {
            const dl = Date.now() + ms;
            while (Date.now() < dl) { if (pred()) return true; await new Promise((r) => setTimeout(r, 300)); }
            return false;
        };

        await request(1, "initialize", { processId: null, rootUri: conn!.rootUri, capabilities: { textDocument: { synchronization: { didSave: true }, publishDiagnostics: { versionSupport: true } } } });
        notify("initialized", {});
        notify("textDocument/didOpen", { textDocument: { uri, languageId: "rust", version: 1, text: BROKEN } });
        const shown = await waitUntil(() => diags.some((d) => d > 0), 25000);

        // Remove `a();`: update the buffer (incremental) + the disk.
        notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }, text: "" }] });
        await fs.writeFile("src/main.rs", FIXED);
        // Trigger flycheck via didSave — retrying. rust-analyzer coalesces a didSave that
        // arrives while its initial (didOpen) flycheck is still running, so under load a
        // single didSave can be dropped and the re-check never fires. Re-send every ~3s
        // until the cargo-check error clears (cargo check itself is <0.1s; this is purely
        // to defeat that coalescing race, not to wait on compute).
        const clearedByDidSave = async (ms: number) => {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
                notify("textDocument/didSave", { textDocument: { uri }, text: FIXED });
                for (let i = 0; i < 6 && Date.now() < deadline; i++) {
                    if (diags.length > 0 && diags[diags.length - 1] === 0) return true;
                    await new Promise((r) => setTimeout(r, 500));
                }
            }
            return false;
        };
        const cleared = await clearedByDidSave(30000);

        notify("exit");
        await fs.writeFile("src/main.rs", "fn main() {\n    println!(\"hi\");\n}\n");
        t.close();
        expect({ shown, cleared }).toEqual({ shown: true, cleared: true });
    }, 70000);
});
