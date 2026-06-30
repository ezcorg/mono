import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";

// Needs a running daemon (`ICANHAZ_CONSENT=auto icanhazd`). The grant scopes to the
// jail; the daemon seeds jail/hello.txt.
const WS = "ws://127.0.0.1:7777";

describe("wrpcFilesystem — VfsInterface over wRPC", () => {
    it("round-trips files + dirs against the daemon's real wasi:filesystem", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "vfs round-trip");
        const fs = await wrpcFilesystem(t, grant);

        // Read a seeded file (the editor's open path); a missing file reports absent.
        expect(await fs.exists("hello.txt")).toBe(true);
        expect(await fs.readFile("hello.txt")).toContain("hello");
        expect(await fs.exists("definitely-not-here.txt")).toBe(false);

        // write → read-back (the editor's save path).
        await fs.writeFile("vfs-note.md", "# remote edit\nover wRPC\n");
        expect(await fs.readFile("vfs-note.md")).toContain("remote edit");

        // mkdir + nested write + readDir + stat (the file-tree path).
        await fs.mkdir("vfs-dir", { recursive: true });
        await fs.writeFile("vfs-dir/a.txt", "alpha");
        const byName = new Map(await fs.readDir("."));
        expect(byName.has("vfs-note.md")).toBe(true);
        expect(byName.get("vfs-dir")).toBe(2); // Directory
        expect(byName.get("hello.txt")).toBe(1); // File

        const st = (await fs.stat("vfs-note.md")) as { type: number; size: number };
        expect(st.type).toBe(1); // File
        expect(st.size).toBeGreaterThan(0);

        // unlink.
        await fs.unlink("vfs-note.md");
        expect(await fs.exists("vfs-note.md")).toBe(false);

        t.close();
    });
});
