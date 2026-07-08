//! Manual demo: the real @joinezco/markdown-editor editing real HOST files in
//! the browser over wRPC, gated by consent. On load (and on "open") it does
//! connect → requestFilesystemGrant → wrpcFilesystem → createEditor on a
//! full-page div with autoSave, so typing here writes through to the host.
//!
//! Run with the daemon in auto-consent:
//!   cd /Users/theo/dev/mono && ICANHAZ_CONSENT=auto ./target/debug/icanhazd
//!   cd src/apps/icanhaz/web && npm run dev   # then open /editor-demo.html

import { connect, requestFilesystemGrant, type Transport } from "./wrpc";
import { wrpcFilesystem } from "./vfs";
import { rootPath } from "./generated/workspace";
import { createWrpcLspProvider } from "./lsp-provider";
import { setRemoteLspProvider } from "@joinezco/codeblock";
import { createEditor, type FileSystemOptions } from "@joinezco/markdown-editor";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const statusEl = $("status");
const editorHost = $("editor");
const wsInput = $("ws") as HTMLInputElement;
const fileInput = $("file") as HTMLInputElement;

const status = (s: string) => (statusEl.textContent = s);

let editor: ReturnType<typeof createEditor> | undefined;
let transport: Transport | undefined;

async function open() {
    const ws = wsInput.value.trim();
    const filepath = fileInput.value.trim() || "editor-demo.md";
    status("connecting…");
    try {
        editor?.destroy();
        editor = undefined;
        editorHost.replaceChildren();
        transport?.close();

        transport = await connect({ ws });
        const grant = await requestFilesystemGrant(transport, "edit a host file in the browser");
        const fs = await wrpcFilesystem(transport, grant);

        // Light up rust-analyzer (on the host) for Rust files when the grant's jail
        // is a Cargo project — open e.g. src/main.rs to get diagnostics/completions.
        // No connection / non-Rust files → codeblock's built-in behaviour is untouched.
        const rp = await rootPath(transport, grant);
        if (rp.tag === "ok") {
            setRemoteLspProvider(
                createWrpcLspProvider({
                    transport,
                    workspaceRoot: rp.val,
                    servers: { rust: { image: "rust-analyzer" } },
                }),
            );
        }

        // Seed the file the first time so there's always something to edit.
        if (!(await fs.exists(filepath))) {
            await fs.writeFile(filepath, `# ${filepath}\n\nEdited live over wRPC — type and it autosaves to the host.\n`);
        }

        editor = createEditor({
            element: editorHost,
            // `VfsLike` structurally mirrors codeblock's `VfsInterface` (only
            // `stat`'s return is deliberately wider) — assert it to the option type.
            fs: { fs, filepath, autoSave: true } as FileSystemOptions,
        });
        status(`editing ${filepath} via ${transport.kind} — autosaving to the host`);
    } catch (e) {
        console.error(e);
        status(`failed: ${e}`);
    }
}

$("open").addEventListener("click", () => void open());
void open();
