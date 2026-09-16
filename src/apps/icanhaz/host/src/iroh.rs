//! The peer path: wRPC over iroh. The daemon's endpoint id *is* the broker's
//! identity, and the QUIC handshake proves the caller's, which every
//! invocation carries as its context.

use std::sync::Arc;

use crate::broker::{drive_broker, BrokerProvider};

/// The ALPN icanhaz serves wRPC under on iroh.
pub const IROH_ALPN: &[u8] = b"icanhaz/0";

/// The context an iroh connection proves: the remote endpoint id the QUIC
/// handshake authenticated, as the caller's peer key. No origin: a peer is
/// not a browser page.
pub fn iroh_ctx(conn: &iroh::endpoint::Connection) -> crate::ReqCtx {
    crate::ReqCtx {
        origin: None,
        peer: Some(ezcap::PublicKey::from_bytes(*conn.remote_id().as_bytes())),
    }
}

/// Accept iroh connections on `endpoint` and serve every wRPC stream on them
/// against `srv`, each invocation carrying [`iroh_ctx`]. Runs until the
/// endpoint closes.
pub async fn accept_iroh<C>(
    endpoint: iroh::Endpoint,
    srv: Arc<wrpc_transport_iroh::Server<crate::ReqCtx>>,
) where
    C: Send,
{
    while let Some(incoming) = endpoint.accept().await {
        let conn = match incoming.await {
            Ok(conn) => conn,
            Err(err) => {
                tracing::debug!(?err, "iroh connection failed to establish");
                continue;
            }
        };
        let srv = Arc::clone(&srv);
        tokio::spawn(async move {
            let cx = iroh_ctx(&conn);
            tracing::info!(peer = %cx.peer.map(|p| p.to_string()).unwrap_or_default(), "iroh peer connected");
            if let Err(err) = wrpc_transport_iroh::serve_connection_with(&srv, &conn, cx).await {
                tracing::debug!(?err, "iroh connection ended");
            }
        });
    }
}

/// Serve the broker alone over iroh (tests; the daemon uses [`crate::serve`]).
pub async fn serve_iroh(endpoint: iroh::Endpoint, provider: BrokerProvider) -> anyhow::Result<()> {
    let srv = Arc::new(wrpc_transport_iroh::Server::<crate::ReqCtx>::new());
    let accept = tokio::spawn(accept_iroh::<()>(endpoint, Arc::clone(&srv)));
    let res = drive_broker(srv.as_ref(), provider).await;
    accept.abort();
    res
}
