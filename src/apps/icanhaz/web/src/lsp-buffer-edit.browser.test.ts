import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";
import { setRemoteLspProvider, createCodeblock } from "@joinezco/codeblock";

// Reproduce the user report "diagnostics don't update on edit until refresh" through the
// REAL editor: open a valid file (no diagnostic), then edit the BUFFER to introduce an
// error and wait for a lint marker. createCodeblock returns the EditorView, so cb.dispatch
// drives a real edit (→ lsp-client autoSync didChange + codeblock save didChangeWatchedFiles).
import { WS } from "./test-ws";
const LINT = '[class*="cm-lintRange"], [class*="cm-lintPoint"], [class*="cm-lint-marker"]';

describe("diagnostics update when the buffer is edited (the user's report)", () => {
    it("open valid → no marker; append broken code → an error marker appears", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "buffer edit update");
        const fs = await wrpcFilesystem(t, grant);
        const rp = await rootPath(t, grant);
        if (rp.tag !== "ok") throw new Error(`no workspace path: ${rp.val}`);
        setRemoteLspProvider(
            createWrpcLspProvider({ transport: t, workspaceRoot: rp.val, servers: { rust: { image: "rust-analyzer" } } }),
        );
        await fs.writeFile("src/main.rs", "fn main() {}\n");

        const parent = document.createElement("div");
        document.body.append(parent);
        const cb: any = createCodeblock({ parent, fs, filepath: "src/main.rs", language: "rust" });

        // Wait for the file content to load into the editor.
        await new Promise<void>((resolve) => {
            const deadline = Date.now() + 10000;
            const check = () =>
                cb.state.doc.toString().includes("fn main") || Date.now() > deadline ? resolve() : setTimeout(check, 200);
            check();
        });
        // Let the LSP initialize + push initial (0) diagnostics.
        await new Promise((r) => setTimeout(r, 5000));
        const before = !!parent.querySelector(LINT);

        // Edit the BUFFER: append a function whose body type-mismatches → a diagnostic
        // should appear WITHOUT a refresh (lsp-client autoSync → didChange → rust-analyzer).
        cb.dispatch({ changes: { from: cb.state.doc.length, insert: '\nfn f() -> i32 { "s" }\n' } });
        const after = await new Promise<boolean>((resolve) => {
            const deadline = Date.now() + 25000;
            const check = () =>
                parent.querySelector(LINT) ? resolve(true) : Date.now() > deadline ? resolve(false) : setTimeout(check, 200);
            check();
        });

        await fs.writeFile("src/main.rs", "fn main() {}\n"); // restore the seeded file
        cb.destroy?.();
        setRemoteLspProvider(null);
        t.close();

        // before: valid → no marker. after: live buffer edit → an error marker, no refresh.
        expect({ before, after }).toEqual({ before: false, after: true });
    }, 45000);
});
