import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";
import { setRemoteLspProvider } from "@joinezco/codeblock";
import { createEditor, type FileSystemOptions } from "@joinezco/markdown-editor";

// The 'rust branch' through the **markdown-editor**: opening a `.rs` file renders it
// as a standalone codeblock, and that codeblock must drive the host's rust-analyzer
// over wRPC (request the `process` capability, start the server, show diagnostics) —
// exactly like a bare `createCodeblock` does (see codeblock-rust.browser.test.ts).
// This guards the fix where the markdown-editor now hands the codeblock the file's
// `filepath` so its per-file LSP wiring engages. Needs the daemon (rust-analyzer +
// cargo on PATH) whose jail is seeded as a Cargo project.
import { WS } from "./test-ws";
const VALID_MAIN = 'fn main() {\n    println!("ok");\n}\n';
const BROKEN_MAIN = 'fn main() {\n    let _x: i32 = "not_an_int";\n}\n'; // a ranged type-mismatch rust-analyzer flags

describe("rust-analyzer for a .rs file in the markdown-editor (end-to-end)", () => {
    it("requests the process capability + renders a diagnostic for a Rust file over wRPC", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "rust in the markdown-editor");
        const fs = await wrpcFilesystem(t, grant);

        // Daemon-reported host path → the rust-analyzer workspace + file:// URIs.
        const rp = await rootPath(t, grant);
        if (rp.tag !== "ok") throw new Error(`no workspace path: ${rp.val}`);
        // Must be set BEFORE the editor opens the file, so the codeblock's handleOpen
        // finds the provider and requests the `process` grant for rust-analyzer.
        setRemoteLspProvider(
            createWrpcLspProvider({
                transport: t,
                workspaceRoot: rp.val,
                servers: { rust: { image: "rust-analyzer" } },
            }),
        );

        // A type error in the crate root so rust-analyzer (on the host) flags it.
        await fs.writeFile("src/main.rs", BROKEN_MAIN);

        const el = document.createElement("div");
        document.body.append(el);
        // The markdown-editor renders a non-prose file as a standalone codeblock; with
        // the fix it passes the filepath through, so the codeblock lights up LSP.
        const editor = createEditor({
            element: el,
            fs: { fs, filepath: "src/main.rs", autoSave: true } as FileSystemOptions,
        });

        // Wait for a CodeMirror lint marker — rust-analyzer → the codeblock's LSP client →
        // @codemirror/lint. (Same marker classes as codeblock-rust.browser.test.ts.)
        const found = await new Promise<boolean>((resolve) => {
            const deadline = Date.now() + 25000;
            const check = () => {
                if (el.querySelector('[class*="cm-lintRange"], [class*="cm-lintPoint"], [class*="cm-lint-marker"]')) {
                    resolve(true);
                } else if (Date.now() > deadline) {
                    resolve(false);
                } else {
                    setTimeout(check, 200);
                }
            };
            check();
        });

        // Restore the seeded file + clean up regardless of outcome.
        await fs.writeFile("src/main.rs", VALID_MAIN);
        editor.destroy();
        setRemoteLspProvider(null);
        t.close();

        expect(found, "a rust-analyzer diagnostic should appear for the .rs file in the editor").toBe(true);
    }, 30000);
});
