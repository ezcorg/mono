import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import { wrpcFilesystem } from "./vfs";

// Needs a running daemon (`ICANHAZ_CONSENT=auto icanhazd`). Proves the native
// `watch` capability end-to-end: edit a host file, get a change event over wRPC.
import { WS } from "./test-ws";

describe("wrpcFilesystem.watch — native fs change events over wRPC", () => {
    it("streams a change event when a file is written under the grant", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "watch test");
        const fs = await wrpcFilesystem(t, grant);

        const ctrl = new AbortController();
        const watcher = fs.watch(".", { signal: ctrl.signal });

        // Arm the watcher, then make a change under the jail.
        const target = `watch-${Date.now()}.txt`;
        setTimeout(() => void fs.writeFile(target, "hello watcher"), 500);

        const event = await Promise.race([
            (async () => {
                for await (const ev of watcher) {
                    if (ev.filename.includes(target)) return ev;
                }
                return null;
            })(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000)),
        ]);

        ctrl.abort();
        await fs.unlink(target).catch(() => {});
        t.close();

        expect(event).not.toBeNull();
        expect(["rename", "change"]).toContain(event!.eventType);
    }, 20000);
});
