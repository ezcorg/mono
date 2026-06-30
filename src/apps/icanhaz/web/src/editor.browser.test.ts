import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";
import { createEditor, type FileSystemOptions } from "@joinezco/markdown-editor";

// Milestone A proof: the REAL @joinezco/markdown-editor, in a real browser,
// rendering a real HOST file read through the wRPC filesystem adapter, gated by
// a consented grant. Needs a running daemon (`ICANHAZ_CONSENT=auto icanhazd`);
// the grant scopes everything to the host jail.
const WS = "ws://127.0.0.1:7777";
const FILE = "editor-demo.md";
const BODY = "# Hello from the host\n\nEdited over wRPC.\n";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("markdown-editor renders a host file over wRPC", () => {
    it("opens a consented grant, reads the file, and shows it in the editor", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "editor demo");
        const fs = await wrpcFilesystem(t, grant);

        // Put a known file on the host through the same adapter the editor reads
        // from — so what the editor renders provably came from the host fs.
        await fs.writeFile(FILE, BODY);

        const el = document.createElement("div");
        document.body.append(el);

        // The FileSystem extension reads `filepath` via `fs` on create and sets
        // the document to that file's rendered markdown. `wrpcFilesystem`'s
        // `VfsLike` structurally mirrors codeblock's `VfsInterface` (only `stat`'s
        // return is deliberately wider), so assert it to the editor's option type.
        const editor = createEditor({
            element: el,
            fs: { fs, filepath: FILE, autoSave: false } as FileSystemOptions,
        });

        // The read is async (a wRPC round-trip to the host), so poll the editor's
        // content — both the Tiptap API and the ProseMirror DOM — until it shows
        // the host file.
        const rendered = () =>
            `${editor.getText?.() ?? ""}\n${el.querySelector(".ProseMirror")?.textContent ?? ""}`;
        let text = "";
        for (let i = 0; i < 100 && !text.includes("Hello from the host"); i++) {
            await sleep(50);
            text = rendered();
        }

        expect(text).toContain("Hello from the host");

        editor.destroy?.();
        el.remove();
        t.close();
    }, 20000);
});
