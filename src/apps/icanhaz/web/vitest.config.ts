import { defineConfig, mergeConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import viteConfig from "./vite.config";

// Browser mode: the test runs in real Chromium, so its WebSocket to the daemon
// carries a genuine `Origin` (the vitest server's) — the thing Node can't do.
// Needs a daemon on ws://127.0.0.1:7777 (start with ICANHAZ_CONSENT=auto).
//
// A standalone vitest.config.ts overrides (does not merge) vite.config.ts, so we
// merge it in explicitly — the editor test needs vite.config's optimizeDeps /
// server.fs.allow to load the workspace-linked markdown-editor + codeblock.
export default mergeConfig(
    viteConfig,
    defineConfig({
        test: {
            include: ["src/**/*.browser.test.ts"],
            browser: {
                enabled: true,
                provider: playwright(),
                headless: true,
                instances: [{ browser: "chromium" }],
            },
        },
    }),
);
