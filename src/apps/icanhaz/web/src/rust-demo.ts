//! The **Rust language server in the browser**, now as a @joinezco/markdown-editor
//! instance (styled as the "custom" mac-window) rather than a bare codeblock: the
//! host's rust-analyzer, reached over the wRPC `process` capability, driving the
//! editor for a real host file — gated by consent. Because the editor renders a
//! non-prose file as a single standalone codeblock, opening a `.rs` file gives a
//! full-window Rust editor with diagnostics/completions.
//!
//! Run (rust-analyzer + cargo must be on the daemon's PATH):
//!   cd /Users/theo/dev/mono && PATH="$HOME/.cargo/bin:$PATH" ICANHAZ_CONSENT=auto ./target/debug/icanhazd
//!   cd src/apps/icanhaz/web && npm run dev      # then open /rust-demo.html
//!
//! Type a type error (e.g. `let x: i32 = "no";`) → a red rust-analyzer
//! diagnostic; type `std::` → completions. Try `?file=src/lib.rs` for another
//! file. Edits autosave to the host file.

import { mountMacDemo } from "./mac-demo";

void mountMacDemo({
    root: document.getElementById("root")!,
    title: "icanhaz · Rust",
    defaultFile: "src/main.rs",
    reason: "edit Rust with rust-analyzer",
    seed: (f) =>
        `fn main() {\n` +
        `    // ${f} — edited over wRPC; rust-analyzer runs on the host.\n` +
        `    // Try a type error (let x: i32 = "no";) for a live diagnostic,\n` +
        `    // or type \`std::\` for completions.\n` +
        `    println!("hello from rust-analyzer, over wRPC");\n` +
        `}\n`,
});
