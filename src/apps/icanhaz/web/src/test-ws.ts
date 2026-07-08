import { inject } from "vitest";

declare module "vitest" {
    interface ProvidedContext {
        icanhazWs: string;
    }
}

/** The test daemon's WebSocket URL — spawned on a free port by the globalSetup
 *  (`test-setup/daemon.ts`), so the suite never collides with a running icanhaz app
 *  holding the default 7777. */
export const WS: string = inject("icanhazWs");
