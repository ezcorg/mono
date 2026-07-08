import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";
import { setRemoteLspProvider, createCodeblock } from "@joinezco/codeblock";

// The user's report: open a file WITH an error (highlights), then fix/remove it — the
// diagnostic doesn't clear until reload. Uses a native TYPE error (reliable, push-based).
import { WS } from "./test-ws";
const LINT = '[class*="cm-lintRange"], [class*="cm-lintPoint"], [class*="cm-lint-marker"]';
const BROKEN = 'fn main() {}\nfn f() -> i32 { "s" }\n'; // fn f returns &str where i32 expected

describe("removing an error clears the diagnostic without reload", () => {
    it("open with a type error → marker; delete the error → marker clears", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "clear diag");
        const fs = await wrpcFilesystem(t, grant);
        const rp = await rootPath(t, grant);
        if (rp.tag !== "ok") throw new Error(`no workspace path: ${rp.val}`);
        setRemoteLspProvider(createWrpcLspProvider({ transport: t, workspaceRoot: rp.val, servers: { rust: { image: "rust-analyzer" } } }));
        await fs.writeFile("src/main.rs", BROKEN);

        const parent = document.createElement("div");
        document.body.append(parent);
        const cb: any = createCodeblock({ parent, fs, filepath: "src/main.rs", language: "rust" });

        const shown = await new Promise<boolean>((resolve) => {
            const deadline = Date.now() + 25000;
            const check = () => (parent.querySelector(LINT) ? resolve(true) : Date.now() > deadline ? resolve(false) : setTimeout(check, 200));
            check();
        });

        // Delete the `fn f() -> i32 { "s" }` line → the file becomes valid.
        const doc = cb.state.doc.toString();
        const start = doc.indexOf("fn f");
        const end = doc.indexOf("}", start) + 1;
        if (start >= 0) cb.dispatch({ changes: { from: start, to: end, insert: "" } });

        const cleared = await new Promise<boolean>((resolve) => {
            const deadline = Date.now() + 20000;
            const check = () => (!parent.querySelector(LINT) ? resolve(true) : Date.now() > deadline ? resolve(false) : setTimeout(check, 200));
            check();
        });

        await fs.writeFile("src/main.rs", "fn main() {}\n");
        cb.destroy?.();
        setRemoteLspProvider(null);
        t.close();

        expect({ shown, cleared }).toEqual({ shown: true, cleared: true });
    }, 60000);
});
