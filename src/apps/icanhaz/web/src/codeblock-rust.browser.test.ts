import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";
import { setRemoteLspProvider, createCodeblock } from "@joinezco/codeblock";

// The end-to-end "rust branch": a Rust file edited in a live codeblock gets
// diagnostics from the host's rust-analyzer over wRPC. Needs the daemon (with
// rust-analyzer + cargo on PATH) whose jail is seeded as a Cargo project.
import { WS } from "./test-ws";
const VALID_MAIN = 'fn main() {\n    println!("ok");\n}\n';
const BROKEN_MAIN = 'fn main() {\n    let _x: i32 = "not_an_int";\n}\n'; // a ranged type-mismatch rust-analyzer flags

describe("rust-analyzer in a live codeblock (the 'rust' branch, end-to-end)", () => {
    it("renders a rust-analyzer diagnostic for a Rust file edited over wRPC", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "rust in a codeblock");
        const fs = await wrpcFilesystem(t, grant);

        // Daemon-reported host path → the rust-analyzer workspace + file:// URIs.
        const rp = await rootPath(t, grant);
        if (rp.tag !== "ok") throw new Error(`no workspace path: ${rp.val}`);
        setRemoteLspProvider(
            createWrpcLspProvider({
                transport: t,
                workspaceRoot: rp.val,
                servers: { rust: { image: "rust-analyzer" } },
            }),
        );

        // Put a syntax error in the crate root so rust-analyzer (on the host) flags it.
        await fs.writeFile("src/main.rs", BROKEN_MAIN);

        const parent = document.createElement("div");
        document.body.append(parent);
        const cb = createCodeblock({ parent, fs, filepath: "src/main.rs", language: "rust" });

        // Wait for a CodeMirror lint marker — rust-analyzer → codeblock's LSP client →
        // @codemirror/lint. Cover every marker class: cm-lintRange (ranged underline),
        // cm-lintPoint (zero-length point error), cm-lint-marker (gutter). rust-analyzer
        // pushes diagnostics only because the client no longer advertises the pull
        // capability `textDocument.diagnostic` — see lsp-diagnostic-capability.browser.test.
        const found = await new Promise<boolean>((resolve) => {
            const deadline = Date.now() + 25000;
            const check = () => {
                if (parent.querySelector('[class*="cm-lintRange"], [class*="cm-lintPoint"], [class*="cm-lint-marker"]')) {
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
        (cb as { destroy?: () => void })?.destroy?.();
        setRemoteLspProvider(null);
        t.close();

        expect(found).toBe(true);
    }, 30000);
});
