//! Manual demo of the **Rust language server in the browser**: the host's
//! rust-analyzer, reached over the wRPC `process` capability, driving a real
//! CodeMirror editor for a real host file (jail/src/main.rs) — gated by consent.
//!
//! Run (rust-analyzer + cargo must be on the daemon's PATH):
//!   cd /Users/theo/dev/mono && PATH="$HOME/.cargo/bin:$PATH" ICANHAZ_CONSENT=auto ./target/debug/icanhazd
//!   cd src/apps/icanhaz/web && npm run dev      # then open http://localhost:5173/rust-demo.html
//!
//! Then: type a type error (e.g. `let x: i32 = "no";`) → a red rust-analyzer
//! diagnostic; type `std::` → completions. Edits autosave to the host file.

import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";
import { setRemoteLspProvider, createCodeblock } from "@joinezco/codeblock";
import { setLspTrace } from "./lsp-transport";

const WS = "ws://127.0.0.1:7777";
const status = (s: string) => (document.getElementById("status")!.textContent = s);

async function main() {
    status("connecting…");
    // TELEMETRY: log every LSP message so the browser console shows exactly what
    // rust-analyzer does — is it emitting `$/progress` (indexing) and does it finish?
    // a `window/showMessage` "Failed to load workspaces"? does a hover get a response
    // (`recv response #…`) or only time out? Look for the [lsp …] lines on hover.
    setLspTrace((ev) =>
        console.log(
            `[lsp +${ev.t}ms ${ev.dir}] ${ev.kind}${ev.method ? " " + ev.method : ""}` +
                `${ev.id !== undefined ? " #" + ev.id : ""}${ev.detail ? " — " + ev.detail : ""}`,
        ),
    );
    const t = await connect({ ws: WS });

    // Consent: a filesystem grant (the jail — seeded as a Cargo project) + the host
    // path so rust-analyzer gets a real workspace + file:// URIs.
    const grant = await requestFilesystemGrant(t, "edit Rust with rust-analyzer");
    const fs = await wrpcFilesystem(t, grant);
    const rp = await rootPath(t, grant);
    if (rp.tag !== "ok") {
        status(`no workspace path: ${rp.val}`);
        return;
    }

    // Wire rust-analyzer for Rust files (a `process` grant is requested on first use).
    setRemoteLspProvider(
        createWrpcLspProvider({
            transport: t,
            workspaceRoot: rp.val,
            servers: { rust: { image: "rust-analyzer" } },
        }),
    );

    // Open ?file=… (default src/main.rs) so you can test any file, e.g.
    // rust-demo.html?file=src/lib.rs — then watch the [lsp …] trace for its didOpen +
    // publishDiagnostics URIs.
    const filepath = new URLSearchParams(location.search).get("file") ?? "src/main.rs";
    createCodeblock({
        parent: document.getElementById("editor")!,
        fs,
        filepath,
        language: "rust",
    });
    status(`editing ${filepath} in ${rp.val} — rust-analyzer over wRPC (try ?file=src/lib.rs)`);
}

main().catch((e) => {
    console.error(e);
    status(`failed: ${e}`);
});
