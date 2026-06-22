//! `icanhazd` — the icanhaz daemon.
//!
//! Runs on your machine and serves the `provider` world (see `../../wit`) over
//! wRPC: a NoCap consent broker plus the capability providers (`process`,
//! `terminal`). Reached by markdown-editor's browser client over your tailnet,
//! fronted by `tailscale serve` for a real TLS endpoint.
//!
//! Scaffold only. The intended flow:
//!   1. bind a wRPC transport (WSS / WebTransport, behind `tailscale serve`)
//!   2. host the `provider` world with wasmtime
//!   3. on `session.request`, raise a *local* consent prompt; on approval mint a
//!      `capability` attenuated per the user's choices, persisted as a durable grant
//!   4. gate every wRPC dispatch on a valid, unrevoked capability
//!   5. `claim-terminal` opens a host PTY (portable-pty) and streams it back
//!
//! See `../../README.md`.

fn main() {
    eprintln!("icanhazd: scaffold only — not yet implemented. See README.md");
}
