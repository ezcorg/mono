// Vitest globalSetup: build + launch the icanhaz daemon on a FREE port, and hand its
// WebSocket URL to the tests via `provide` / `inject`. This makes the browser suite
// self-contained and — crucially — immune to a running `icanhaz` app already holding
// the default 7777 (which previously made every test hit the app's *strict* daemon and
// fail). Each run gets its own ephemeral daemon + throwaway jail, torn down after.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSetupContext } from "vitest/node";

const HERE = dirname(fileURLToPath(import.meta.url)); // …/icanhaz/web/test-setup
const REPO_ROOT = join(HERE, "..", "..", "..", "..", ".."); // → mono repo root
const CARGO_BIN = join(homedir(), ".cargo", "bin");
const PATH_WITH_CARGO = `${CARGO_BIN}:${process.env.PATH ?? ""}`;

/** An OS-assigned free TCP port on loopback. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as { port: number }).port;
            srv.close(() => resolve(port));
        });
    });
}

/** Resolve once something is accepting connections on `port`, or throw after `ms`. */
async function waitForPort(port: number, ms = 30000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const up = await new Promise<boolean>((res) => {
            const s = createConnection({ port, host: "127.0.0.1" });
            s.once("connect", () => { s.destroy(); res(true); });
            s.once("error", () => res(false));
        });
        if (up) return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`icanhaz daemon never bound 127.0.0.1:${port}`);
}

export default async function setup({ provide }: GlobalSetupContext) {
    // Build first (fast when cached) so tests always run against current daemon code.
    const build = spawnSync("cargo", ["build", "--bin", "icanhazd"], {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: PATH_WITH_CARGO },
        stdio: "inherit",
    });
    if (build.status !== 0) throw new Error("failed to build icanhazd for tests");

    const wsPort = await freePort();
    const wtPort = await freePort();
    const wsUrl = `ws://127.0.0.1:${wsPort}`;

    const jail = mkdtempSync(join(tmpdir(), "ic-test-"));
    let daemon: ChildProcess | undefined = spawn(join(REPO_ROOT, "target", "debug", "icanhazd"), [], {
        env: {
            ...process.env,
            PATH: PATH_WITH_CARGO, // the process capability spawns rust-analyzer from PATH
            ICANHAZ_WS_BIND: `127.0.0.1:${wsPort}`,
            ICANHAZ_WT_BIND: `127.0.0.1:${wtPort}`,
            ICANHAZ_ROOT: join(jail, "root"),
            ICANHAZ_PAIRINGS: join(jail, "pairings.json"),
            ICANHAZ_HOSTS: join(jail, "hosts.json"),
            ICANHAZ_CONSENT: "auto",
        },
        stdio: "inherit",
    });
    daemon.on("exit", (code) => {
        if (code) console.error(`[icanhaz test daemon] exited early with code ${code}`);
        daemon = undefined;
    });

    try {
        await waitForPort(wsPort);
    } catch (e) {
        daemon?.kill("SIGKILL");
        throw e;
    }

    provide("icanhazWs", wsUrl);
    console.log(`[icanhaz test daemon] serving ${wsUrl} (jail ${jail})`);

    return async () => {
        daemon?.kill("SIGKILL");
        try { rmSync(jail, { recursive: true, force: true }); } catch { /* best effort */ }
    };
}
