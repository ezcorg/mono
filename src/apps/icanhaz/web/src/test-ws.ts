import { inject } from "vitest";

declare module "vitest" {
    interface ProvidedContext {
        icanhazWs: string;
        icanhazLinks: { provider: string; source: string };
        icanhazWebDir: string;
    }
}

/** The test daemon's WebSocket URL — spawned on a free port by the globalSetup
 *  (`test-setup/daemon.ts`), so the suite never collides with a running icanhaz app
 *  holding the default 7777. */
export const WS: string = inject("icanhazWs");

/** The links example as a second, distinct daemon publishes it: its hash, and
 *  the `oci://` source at that daemon's registry, which the test daemon has a
 *  credential for. A page names the component by these; the test daemon
 *  fetches it. */
export const LINKS: { provider: string; source: string } = inject("icanhazLinks");

/** This package's directory on the host running the daemon. */
export const WEB_DIR: string = inject("icanhazWebDir");
