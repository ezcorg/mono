//! TCP accept loop. Each connection becomes an RPC session (see `rpc.rs`).

use anyhow::Result;
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing::{info, warn};

pub struct Config {
    pub bind: String,
    pub pin: String,
    pub shell: String,
    pub allow_host_shell: bool,
}

pub async fn run(cfg: Config) -> Result<()> {
    let cfg = Arc::new(cfg);
    let listener = TcpListener::bind(&cfg.bind).await?;
    info!("listening on ws://{}", cfg.bind);
    loop {
        let (stream, peer) = listener.accept().await?;
        let cfg = cfg.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::rpc::serve(stream, peer.to_string(), cfg).await {
                warn!("connection {peer} ended: {e:#}");
            }
        });
    }
}
