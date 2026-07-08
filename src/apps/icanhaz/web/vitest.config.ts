import { defineConfig, mergeConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import viteConfig from "./vite.config";

// Browser mode: the test runs in real Chromium, so its WebSocket to the daemon
// carries a genuine `Origin` (the vitest server's) — the thing Node can't do.
//
// The daemon is launched by `test-setup/daemon.ts` (globalSetup) on a FREE port and
// its URL handed to the tests via `inject("icanhazWs")` (see `src/test-ws.ts`), so the
// suite is self-contained and never collides with a running icanhaz app on 7777.
//
// A standalone vitest.config.ts overrides (does not merge) vite.config.ts, so we
// merge it in explicitly — the editor test needs vite.config's optimizeDeps /
// server.fs.allow to load the workspace-linked markdown-editor + codeblock.
export default mergeConfig(
    viteConfig,
    defineConfig({
        test: {
            include: ["src/**/*.browser.test.ts"],
            globalSetup: ["./test-setup/daemon.ts"],
            // Run test files SERIALLY: each LSP test spawns rust-analyzer against the shared
            // jail workspace and mutates the global remote-LSP provider, so parallel files
            // contend for CPU + stomp shared state (flaky timeouts / "failed to run").
            fileParallelism: false,
            browser: {
                enabled: true,
                provider: playwright(),
                headless: true,
                instances: [{ browser: "chromium" }],
            },
        },
    }),
);
