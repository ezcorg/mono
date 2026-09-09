//! Flagship demo — the real @joinezco/markdown-editor editing real HOST files in
//! the browser over wRPC, gated by consent, styled as the "custom" mac-window.
//! All the wiring lives in `mac-demo.ts`; this page just picks the default file.
//!
//! Run with the daemon in auto-consent:
//!   cd /Users/theo/dev/mono && ICANHAZ_CONSENT=auto ./target/debug/icanhazd
//!   cd src/apps/icanhaz/web && npm run dev   # then open /editor-demo.html

import { mountMacDemo } from "./mac-demo";

void mountMacDemo({
    root: document.getElementById("root")!,
    title: "icanhaz",
    defaultFile: "editor-demo.md",
    reason: "edit a host Markdown file in the browser",
    seed: (f) =>
        `# ${f}\n\n` +
        `Edited live over wRPC — type and it autosaves to the host.\n\n` +
        `- The **search** field in the titlebar opens any file in the granted jail.\n` +
        `- The outline on the left is generated from your headings.\n` +
        `- A fenced code block runs the host's language server over the \`process\` capability:\n\n` +
        "```rust\n" +
        `fn main() {\n` +
        `    let greeting: &str = "hello from rust-analyzer, over wRPC";\n` +
        `    println!("{greeting}");\n` +
        `}\n` +
        "```\n",
});
