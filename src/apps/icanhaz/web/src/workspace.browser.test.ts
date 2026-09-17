import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { open, workspaceRootPath } from "./generated/workspace";
import { drop } from "./generated/resources";

// Needs a running daemon (`ICANHAZ_CONSENT=auto icanhazd`). The fs grant scopes to
// the jail; root-path reports that jail's host absolute path.
import { WS } from "./test-ws";

describe("workspace capability — host path for a filesystem grant", () => {
    it("reports the host absolute path the grant is jailed to", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "workspace path");
        const ws = await open(t, grant);
        expect(ws.tag, ws.tag === "err" ? ws.val : "").toBe("ok");
        if (ws.tag !== "ok") return;
        const r = await workspaceRootPath(t, ws.val);
        expect(r.tag).toBe("ok");
        if (r.tag === "ok") {
            expect(r.val.startsWith("/")).toBe(true); // an absolute host path
            expect(r.val.endsWith("jail")).toBe(true); // the grant scopes to /jail/
        }
        expect(await drop(t, ws.val)).toBe(true);
        // Released: the object answers no more.
        const gone = await workspaceRootPath(t, ws.val).then(() => "answered", () => "refused");
        expect(gone).toBe("refused");
        t.close();
    });

    it("refuses a non-filesystem / unknown token", async () => {
        const t = await connect({ ws: WS });
        const r = await open(t, "bogus-token");
        expect(r.tag).toBe("err");
        if (r.tag === "err") expect(r.val).toContain("denied");
        t.close();
    });
});
