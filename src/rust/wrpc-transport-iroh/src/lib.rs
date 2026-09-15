//! wRPC transport adapter over [iroh] QUIC bi-streams.
//!
//! This is a port of wRPC's quinn-based QUIC transport (`wrpc-quic`) to
//! iroh: iroh connections are a quinn fork, so the adapter is a type
//! substitution over the same `wrpc_transport::frame` machinery. Each wRPC
//! invocation maps onto one bidirectional iroh stream; wRPC layers its
//! framing protocol on top to multiplex nested async parameter/result
//! sub-streams.
//!
//! This crate is deliberately dependency-light and independent of dij: it
//! only ties `wrpc-transport` (pinned) to `iroh`, and is designed to be
//! publishable on its own.
//!
//! # Example
//!
//! ```no_run
//! # async fn example() -> anyhow::Result<()> {
//! use wrpc_transport_iroh::{Client, Server, serve_connection};
//!
//! // Server side: accept iroh connections under your ALPN, then serve
//! // every wRPC invocation stream on each connection.
//! let endpoint = iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
//!     .alpns(vec![b"my-app/0".to_vec()])
//!     .bind()
//!     .await?;
//! let server = Server::new();
//! if let Some(incoming) = endpoint.accept().await {
//!     let conn = incoming.await?;
//!     serve_connection(&server, &conn).await?;
//! }
//!
//! // Client side: connect and wrap the connection.
//! # let addr: iroh::EndpointAddr = todo!();
//! let conn = endpoint.connect(addr, b"my-app/0").await?;
//! let client = Client::from(conn);
//! # Ok(())
//! # }
//! ```

use anyhow::Context as _;
use bytes::Bytes;
use iroh::endpoint::{Connection, RecvStream, SendStream, VarInt};
use tracing::{debug, error, trace, warn};
use wrpc_transport::Invoke;
use wrpc_transport::frame::{Incoming, InvokeBuilder, Outgoing};

/// iroh wRPC server with graceful stream shutdown handling.
///
/// Feed it accepted bi-streams via [`wrpc_transport::Server::accept`] (or
/// use [`serve_connection`] / [`serve_connection_with`] to drive a whole
/// iroh connection), and consume invocations through the
/// [`wrpc_transport::Serve`] impl.
///
/// `C` is a per-connection context handed to every invocation handler —
/// e.g. the caller's verified identity. Defaults to `()`.
pub type Server<C = ()> = wrpc_transport::Server<C, RecvStream, SendStream, ConnHandler>;

/// iroh wRPC client: wraps one iroh [`Connection`]; every invocation opens
/// a fresh bidirectional stream.
#[derive(Clone, Debug)]
pub struct Client(Connection);

impl Client {
    /// The underlying iroh connection.
    pub fn connection(&self) -> &Connection {
        &self.0
    }
}

/// Graceful stream shutdown handler (mirrors wrpc-quic's semantics).
pub struct ConnHandler;

/// Application close code signalling an intentionally completed stream.
const DONE: VarInt = VarInt::from_u32(1);

impl wrpc_transport::frame::ConnHandler<RecvStream, SendStream> for ConnHandler {
    async fn on_ingress(mut rx: RecvStream, res: std::io::Result<()>) {
        if let Err(err) = res {
            error!(?err, "ingress failed");
        } else {
            debug!("ingress successfully complete");
        }
        if let Err(err) = rx.stop(DONE) {
            debug!(?err, "failed to close incoming stream");
        }
    }

    async fn on_egress(tx: SendStream, res: std::io::Result<()>) {
        if let Err(err) = res {
            error!(?err, "egress failed");
        } else {
            debug!("egress successfully complete");
        }
        match tx.stopped().await {
            Ok(None) => {
                trace!("stream successfully closed");
            }
            Ok(Some(code)) => {
                if code == DONE {
                    trace!("stream successfully closed");
                } else {
                    warn!(?code, "stream closed with code");
                }
            }
            Err(err) => {
                error!(?err, "failed to await stream close");
            }
        }
    }
}

impl From<Connection> for Client {
    fn from(conn: Connection) -> Self {
        Self(conn)
    }
}

impl Invoke for &Client {
    type Context = ();

    async fn invoke<P>(
        &self,
        (): Self::Context,
        instance: &str,
        func: &str,
        params: Bytes,
        paths: impl AsRef<[P]> + Send,
    ) -> anyhow::Result<(Outgoing, Incoming)>
    where
        P: AsRef<[Option<usize>]> + Send + Sync,
    {
        let (tx, rx) = self
            .0
            .open_bi()
            .await
            .context("failed to open parameter stream")?;
        InvokeBuilder::<ConnHandler>::default()
            .invoke(tx, rx, instance, func, params, paths)
            .await
    }
}

impl Invoke for Client {
    type Context = ();

    async fn invoke<P>(
        &self,
        (): Self::Context,
        instance: &str,
        func: &str,
        params: Bytes,
        paths: impl AsRef<[P]> + Send,
    ) -> anyhow::Result<(Outgoing, Incoming)>
    where
        P: AsRef<[Option<usize>]> + Send + Sync,
    {
        (&self).invoke((), instance, func, params, paths).await
    }
}

/// Serve every wRPC invocation stream arriving on `conn` until the
/// connection closes.
///
/// Returns `Ok(())` on graceful connection close (either side) and an error
/// for anything else. Accepted streams are handed to `server` inline;
/// [`wrpc_transport::Server::accept`] spawns per-stream work internally, so
/// a slow invocation does not block the accept loop.
pub async fn serve_connection(server: &Server, conn: &Connection) -> anyhow::Result<()> {
    serve_connection_with(server, conn, ()).await
}

/// [`serve_connection`] with a per-connection context cloned into every
/// invocation (e.g. the remote's verified identity).
pub async fn serve_connection_with<C>(
    server: &Server<C>,
    conn: &Connection,
    ctx: C,
) -> anyhow::Result<()>
where
    C: Clone + Send + Sync + 'static,
{
    loop {
        match conn.accept_bi().await {
            Ok((tx, rx)) => {
                if let Err(err) = server.accept(ctx.clone(), tx, rx).await {
                    warn!(?err, "failed to accept invocation stream");
                }
            }
            Err(iroh::endpoint::ConnectionError::ApplicationClosed(_))
            | Err(iroh::endpoint::ConnectionError::LocallyClosed) => {
                debug!("connection closed");
                return Ok(());
            }
            Err(err) => {
                return Err(anyhow::Error::from(err)).context("failed to accept stream");
            }
        }
    }
}
