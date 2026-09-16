//! icanhaz host — the daemon's capability providers + serving layer.
//!
//! Authority is never ambient: every capability is consent-gated through the
//! [`broker`] (NoCap — a grant is a narrowable, revocable token bound to a
//! principal). The daemon serves them all over wRPC on one endpoint per transport
//! ([`serve`]):
//!   - real `wasi:filesystem@0.2`, grant-gated + jail-scoped ([`component_serve`]);
//!   - a native PTY ([`terminal`]) and grant-pinned child processes ([`process`]);
//!   - host metadata ([`workspace`]) and native fs change events ([`watch`]).
//!
//! WASI **Preview 2** (`wrpc-wasmtime` / `wasmtime-wasi` are p2-only).

/// Generic serving of a wasmtime **component's** exports over wRPC (resources +
/// streams), via `wrpc-wasmtime`'s `ServeExt`. The path for real `wasi:filesystem`.
pub mod component_serve;

/// A native interactive PTY exposed over wRPC streams (the terminal capability).
pub mod terminal;

/// The `process` capability — spawn a caller-named host program with piped stdio
/// (the language-server / build-tool sibling of `terminal`). Served natively.
pub mod process;

/// The `workspace` capability — host metadata for a consented grant (the jail's
/// host absolute path), so a client can form real `file://` URIs for a native LSP.
pub mod workspace;

/// The `watch` capability — stream native filesystem change events for a path under
/// a consented filesystem grant (`wasi:filesystem@0.2` has no change notifications).
pub mod watch;

/// LLM inference through the host's configured providers (`inference.wit`).
pub mod inference;
/// The inference backends and their streaming clients.
pub mod providers;
/// The daemon's serving layer — every capability on one wRPC server per transport.
pub mod serve;

/// One-call daemon bring-up (seed jail + build providers + serve), shared by the
/// headless `icanhazd` binary and the native app.
pub mod daemon;

/// Grant-scoped streaming — ends a capability's stream + releases its resource when
/// the grant is revoked or expires. Shared by terminal / process / watch.
pub mod session;

#[cfg(test)]
mod iroh_tests;

// The broker itself is a library (`icanhaz-broker`), re-exported here so the
// daemon, the tray app and tests address it as they always did.
pub use icanhaz_broker::{
    approve, broker, capabilities, configuration, configuration_serve, store, AsOrigin, ReqCtx,
};

/// The peer path: serving over iroh.
pub mod iroh;
