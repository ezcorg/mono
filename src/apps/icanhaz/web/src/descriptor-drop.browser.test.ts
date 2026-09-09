import { describe, it, expect } from "vitest";
import { connect, requestFilesystemGrant } from "./wrpc";
import * as fsmount from "./generated/fs-mount";
import * as wasifs from "./generated/wasi-filesystem";
import { dropResource } from "./vfs";

// The descriptor-drop, end-to-end over the real WebSocket transport: a browser opens
// a wasi:filesystem descriptor (a guest-exported resource the host holds in its shared
// table), then releases it via the `icanhaz:fspass/resources@0.1.0#drop` meta-op — the
// host evicts the handle + runs its guest destructor (closing the fd) and reports back
// whether it released a live handle. This is what keeps a long-lived editor from leaking
// a handle per fs op. (The host test `dropping_a_descriptor_releases_the_handle` proves
// the eviction itself; this proves the browser produces a drop the daemon honors.)
//
// In its own file so it never runs immediately after wrpc.browser.test.ts's streaming
// read-via-stream, whose mid-stream close can stall the very next fs call.
import { WS } from "./test-ws";

describe("descriptor drop over wRPC", () => {
    it("releases a descriptor the daemon holds, and is idempotent", async () => {
        const t = await connect({ ws: WS });
        const grant = await requestFilesystemGrant(t, "browser descriptor drop");
        const mounted = await fsmount.openRoot(t, grant);
        expect(mounted.tag, `mount denied: ${JSON.stringify(mounted)}`).toBe("ok");
        if (mounted.tag !== "ok") return;

        const opened = await wasifs.descriptorOpenAt(t, mounted.val, {}, "hello.txt", {}, { read: true });
        expect(opened.tag, `open denied: ${JSON.stringify(opened)}`).toBe("ok");
        if (opened.tag !== "ok") return;
        const fd = opened.val; // the descriptor handle (opaque bytes)

        // It works while it's live.
        const before = await wasifs.descriptorRead(t, fd, 1024n, 0n);
        expect(before.tag, `read before drop: ${JSON.stringify(before)}`).toBe("ok");

        // Drop it: the daemon evicts the handle + runs its destructor over WS and reports
        // back that it released a live handle (`true`). A wrong wire would hang here.
        const removed = await Promise.race([
            dropResource(t, fd).then((r) => (r ? "removed" : "not-found"), (e) => `threw: ${e}`),
            new Promise<string>((r) => setTimeout(() => r("timeout"), 5000)),
        ]);
        expect(removed, "the daemon must confirm it released the handle over WS").toBe("removed");

        // Idempotent: the handle is already gone, so a second drop releases nothing.
        expect(await dropResource(t, fd), "a second drop releases nothing").toBe(false);
        t.close();
    }, 20000);
});
