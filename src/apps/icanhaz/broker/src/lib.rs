//! icanhaz broker — the consent gate as a library.
//!
//! Authority is never ambient: a caller `request`s a capability, which raises
//! a consent decision, and is issued a grant: a minted instance over an
//! `ezco:ezcap` membrane, narrowable, revocable, certifiable. Everything a
//! host needs to *be* a broker lives here; serving capabilities over
//! transports is the daemon's job (`icanhaz-host`), and witmproxy embeds this
//! crate so its plugin capabilities are grants too.
//!
//!   - [`broker`]: the grant store, consent, pairings, hosts, certificates,
//!     the wRPC broker handler and client stubs.
//!   - [`approve`]: the consent surface (notification + loopback approval page).
//!   - [`store`]: the durable store (encrypted SQLite): declared configuration
//!     and per-owner state, so no capability owns a table.
//!   - [`configuration`]: `forms`-typed schemas capabilities declare, and the
//!     generic list/set/remove operations over the store.
//!   - [`capabilities`]: the registry of installed capabilities (id, emoji,
//!     localizable description).

pub mod approve;
pub mod broker;
pub mod capabilities;
pub mod configuration;
/// `icanhaz:nocap/configuration` over wRPC: other local hosts declare and read back.
pub mod configuration_serve;
#[cfg(test)]
mod scoped_tests;
pub mod store;

/// Per-connection request context the transports attach at accept time and every
/// handler receives per invocation. It carries the browser-attested `Origin`
/// (which web app is asking) and, on the iroh path, the peer key the QUIC
/// handshake proved. **Trust caveat:** the `Origin` header is faithful *only
/// because a browser sets it* (page JS can't forge it): it labels the
/// requester, it does not authenticate that the peer is a browser. It feeds
/// the consent decision; it is not itself the gate.
#[derive(Clone, Debug, Default)]
pub struct ReqCtx {
    pub origin: Option<String>,
    /// The peer's Ed25519 key when the transport authenticated one (the iroh
    /// path: the QUIC handshake proves the remote endpoint id). `None` on
    /// WebSocket and WebTransport.
    pub peer: Option<ezcap::PublicKey>,
}

/// Lets a handler read what the transport proved about the caller out of
/// whatever context it supplies: `ReqCtx` on the origin-bearing WebSocket
/// path and the peer-authenticated iroh path, `()` elsewhere (the loopback
/// test serves, and WebTransport until it carries one).
pub trait AsOrigin {
    fn origin(&self) -> Option<&str>;
    /// The transport-authenticated peer key, if any.
    fn peer(&self) -> Option<&ezcap::PublicKey> {
        None
    }
    /// Both, as a certificate's audience is checked against them.
    fn presented(&self) -> ezcap::Presented {
        ezcap::Presented {
            origin: self.origin().map(str::to_string),
            peer: self.peer().copied(),
        }
    }
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
    fn peer(&self) -> Option<&ezcap::PublicKey> {
        self.peer.as_ref()
    }
}
