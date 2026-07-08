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

/// The daemon's serving layer — every capability on one wRPC server per transport.
pub mod serve;

/// One-call daemon bring-up (seed jail + build providers + serve), shared by the
/// headless `icanhazd` binary and the native app.
pub mod daemon;

/// Grant-scoped streaming — ends a capability's stream + releases its resource when
/// the grant is revoked or expires. Shared by terminal / process / watch.
pub mod session;

/// The consent broker — the NoCap gate (request → consent → scoped grant token).
pub mod broker;

/// The registry of installed host capabilities (id · emoji · localizable description).
pub mod capabilities;

/// The consent **surface** — notification + the daemon's loopback approval page
/// (how a backgrounded daemon collects a decision).
pub mod approve;

/// Per-connection request context the transports attach at accept time and every
/// handler receives per invocation. Today it carries the browser-attested
/// `Origin` (which web app is asking). **Trust caveat:** the `Origin` header is
/// faithful *only because a browser sets it* (page JS can't forge it) — it labels
/// the requester, it does not authenticate that the peer is a browser. It feeds
/// the consent decision; it is not itself the gate. Grows a verified peer
/// identity for the tailnet path later.
#[derive(Clone, Debug, Default)]
pub struct ReqCtx {
    pub origin: Option<String>,
}

/// Lets a handler read the requesting origin out of whatever context a given
/// transport supplies — `ReqCtx` on the origin-bearing WebSocket path, `()`
/// elsewhere (the loopback test serves, and WebTransport until it carries one).
pub trait AsOrigin {
    fn origin(&self) -> Option<&str>;
}
impl AsOrigin for () {
    fn origin(&self) -> Option<&str> {
        None
    }
}
impl AsOrigin for ReqCtx {
    fn origin(&self) -> Option<&str> {
        self.origin.as_deref()
    }
}
