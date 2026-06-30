//! The daemon's serving layer — one wRPC `Server` per transport, serving **every**
//! capability (broker + fs-lite + terminal + process) on it. wRPC routes by the instance
//! name in each invocation header (`icanhaz:nocap/broker` vs `…/fs-lite` vs
//! `…/terminal`), so one WebSocket port (and one WebTransport port) covers all of
//! them: we register each interface's handler on the shared server and drive
//! their invocation streams together. The broker and the terminal share a grant
//! store, so a grant minted by `broker.request` is the one `terminal.open` checks.

use core::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context as _;
use futures::stream::select_all;
use futures::StreamExt as _;
use tokio::net::TcpListener;
use tokio::select;
use tokio::task::JoinSet;

use std::path::PathBuf;

use wasmtime_wasi::{DirPerms, FilePerms, WasiCtxBuilder};

use crate::broker::{bindings as broker, BrokerProvider, GrantStore};
use crate::component_serve::serve_filesystem;
use crate::provider::{bindings as fs, FsLiteProvider};
use crate::terminal::{bindings as term, TerminalProvider};
use crate::process::{bindings as proc, ProcessProvider};
use crate::{AsOrigin, ReqCtx};

/// The real-`wasi:filesystem` capability the daemon serves over wRPC: the gated
/// passthrough component (`component_path`), preopen-jailed to `root`, gated by
/// the shared `grants`. Served via `ServeExt` on the same server as broker/terminal.
#[derive(Clone)]
pub struct FsServe {
    pub component_path: PathBuf,
    pub root: PathBuf,
    pub grants: Arc<std::sync::Mutex<GrantStore>>,
}

/// Register broker + fs-lite + terminal on a shared server and drive them until idle.
async fn drive<C, S>(
    srv: &S,
    broker_p: BrokerProvider,
    fs_p: FsLiteProvider,
    term_p: TerminalProvider,
    proc_p: ProcessProvider,
    fs_serve: FsServe,
) -> anyhow::Result<()>
where
    C: AsOrigin + Send + Sync + 'static,
    S: wrpc_transport::Serve<Context = C>,
{
    let broker_invs = broker::serve(srv, broker_p).await.context("failed to serve broker")?;
    let fs_invs = fs::serve(srv, fs_p).await.context("failed to serve fs-lite")?;
    let term_invs = term::serve(srv, term_p).await.context("failed to serve terminal")?;
    let proc_invs = proc::serve(srv, proc_p).await.context("failed to serve process")?;
    // Real wasi:filesystem (the gated passthrough) on the SAME server, via ServeExt.
    // Its descriptor invocations drain on the returned JoinSet (held for the
    // server's lifetime); the placeholder client is never invoked (no polyfill).
    let fs_wasm = std::fs::read(&fs_serve.component_path)
        .with_context(|| format!("read fs-passthrough component {}", fs_serve.component_path.display()))?;
    let mut wasi_builder = WasiCtxBuilder::new();
    wasi_builder
        .preopened_dir(&fs_serve.root, "/", DirPerms::all(), FilePerms::all())
        .map_err(anyhow::Error::from)
        .context("preopen wasi:filesystem root")?;
    let _wasi_fs = serve_filesystem(
        srv,
        &fs_wasm,
        wrpc_transport::tcp::Client::from("127.0.0.1:1".to_string()),
        (),
        wasi_builder.build(),
        fs_serve.grants,
    )
    .await
    .context("failed to serve wasi:filesystem")?;
    let mut broker_i = select_all(broker_invs.into_iter().map(|(i, n, s)| s.map(move |r| (i, n, r))));
    let mut fs_i = select_all(fs_invs.into_iter().map(|(i, n, s)| s.map(move |r| (i, n, r))));
    let mut term_i = select_all(term_invs.into_iter().map(|(i, n, s)| s.map(move |r| (i, n, r))));
    let mut proc_i = select_all(proc_invs.into_iter().map(|(i, n, s)| s.map(move |r| (i, n, r))));
    let mut tasks = JoinSet::new();
    loop {
        select! {
            Some((i, n, r)) = broker_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "broker invocation"),
            },
            Some((i, n, r)) = fs_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "fs-lite invocation"),
            },
            Some((i, n, r)) = term_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "terminal invocation"),
            },
            Some((i, n, r)) = proc_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "process invocation"),
            },
            Some(_) = tasks.join_next() => {}
            else => break,
        }
    }
    Ok(())
}

/// Serve every capability over wRPC/WebSocket on `listener`.
pub async fn serve_websocket_all(
    listener: TcpListener,
    broker_p: BrokerProvider,
    fs_p: FsLiteProvider,
    term_p: TerminalProvider,
    proc_p: ProcessProvider,
    fs_serve: FsServe,
) -> anyhow::Result<()> {
    let srv = Arc::new(wrpc_transport::Server::<ReqCtx, _, _>::default());
    let accept = tokio::spawn({
        let srv = Arc::clone(&srv);
        async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        let srv = Arc::clone(&srv);
                        tokio::spawn(async move {
                            match wrpc_websockets::ServerBuilder::new().accept(stream).await {
                                Ok((req, ws)) => {
                                    // Browser-attested Origin (page JS can't forge it) → the
                                    // requesting principal. Absent for non-browser clients.
                                    let origin = req
                                        .headers()
                                        .get("origin")
                                        .and_then(|v| v.to_str().ok())
                                        .map(str::to_string);
                                    let (tx, rx) = wrpc_websockets::split(ws);
                                    if let Err(err) = srv.accept(ReqCtx { origin }, tx, rx).await {
                                        tracing::error!(?err, "failed to accept WS invocation");
                                    }
                                }
                                Err(err) => tracing::error!(?err, "WebSocket handshake failed"),
                            }
                        });
                    }
                    Err(err) => tracing::error!(?err, "failed to accept TCP connection"),
                }
            }
        }
    });
    let res = drive(srv.as_ref(), broker_p, fs_p, term_p, proc_p, fs_serve).await;
    accept.abort();
    res
}

/// Serve every capability over wRPC/WebTransport bound at `bind` with `identity`.
pub async fn serve_webtransport_all(
    bind: SocketAddr,
    identity: wtransport::Identity,
    broker_p: BrokerProvider,
    fs_p: FsLiteProvider,
    term_p: TerminalProvider,
    proc_p: ProcessProvider,
    fs_serve: FsServe,
) -> anyhow::Result<()> {
    use core::time::Duration;
    use wtransport::{Endpoint, ServerConfig};

    let ep = Endpoint::server(
        ServerConfig::builder()
            .with_bind_address(bind)
            .with_identity(identity)
            .keep_alive_interval(Some(Duration::from_secs(3)))
            .build(),
    )
    .context("failed to create WebTransport endpoint")?;

    // Generic over the origin-bearing context — the `wrpc_webtransport::Server`
    // alias pins `C=()`, so instantiate the generic directly (same codec/handler).
    let srv = Arc::new(wrpc_transport::Server::<
        ReqCtx,
        wtransport::RecvStream,
        wtransport::SendStream,
        wrpc_webtransport::ConnHandler,
    >::new());
    let accept = tokio::spawn({
        let srv = Arc::clone(&srv);
        async move {
            loop {
                let incoming = ep.accept().await;
                let srv = Arc::clone(&srv);
                tokio::spawn(async move {
                    let res = async {
                        let req = incoming.await.context("accept WT session")?;
                        // Browser-attested Origin (the WebTransport CONNECT carries it;
                        // page JS can't forge it) → the requesting principal, shared by
                        // every bidi stream on this session.
                        let origin = req.origin().map(str::to_string);
                        let conn = req.accept().await.context("establish WT session")?;
                        loop {
                            let (tx, rx) = conn.accept_bi().await.context("accept bidi stream")?;
                            srv.accept(ReqCtx { origin: origin.clone() }, tx, rx)
                                .await
                                .context("serve wRPC stream")?;
                        }
                        #[allow(unreachable_code)]
                        anyhow::Ok(())
                    }
                    .await;
                    if let Err(err) = res {
                        tracing::debug!(?err, "WebTransport connection ended");
                    }
                });
            }
        }
    });
    let res = drive(srv.as_ref(), broker_p, fs_p, term_p, proc_p, fs_serve).await;
    accept.abort();
    res
}
