import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { rootPath } from "./generated/workspace";

// Needs a running daemon (`ICANHAZ_CONSENT=auto icanhazd`). The fs grant scopes to
// the jail; root-path reports that jail's host absolute path.
import { WS } from "./test-ws";

describe("workspace capability — host path for a filesystem grant", () => {
    it("reports the host absolute path the grant is jailed to", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "workspace path");
        const r = await rootPath(t, grant);
        expect(r.tag).toBe("ok");
        if (r.tag === "ok") {
            expect(r.val.startsWith("/")).toBe(true); // an absolute host path
            expect(r.val.endsWith("jail")).toBe(true); // the grant scopes to /jail/
        }
        t.close();
    });

    it("refuses a non-filesystem / unknown token", async () => {
        const t = await connect({ ws: WS });
        const r = await rootPath(t, "bogus-token");
        expect(r.tag).toBe("err");
        if (r.tag === "err") expect(r.val).toContain("denied");
        t.close();
    });
});
