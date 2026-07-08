//! The daemon's serving layer — one wRPC `Server` per transport, serving **every**
//! capability (broker + terminal + process + workspace + watch + real wasi:filesystem)
//! on it. wRPC routes by the instance
//! name in each invocation header (`icanhaz:nocap/broker` vs `…/terminal` vs
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
use crate::terminal::{bindings as term, TerminalProvider};
use crate::process::{bindings as proc, ProcessProvider};
use crate::workspace::{bindings as ws, WorkspaceProvider};
use crate::watch::{bindings as watch, WatchProvider};
use crate::{AsOrigin, ReqCtx};

use core::pin::Pin;
use core::task::{Context, Poll};
use std::collections::HashMap;
use std::io;

use bytes::Bytes;
use futures::SinkExt as _;
use tokio::io::AsyncWrite;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_util::io::StreamReader;
use wrpc_websockets::tokio_websockets::{Message, WebSocketStream};

/// The real-`wasi:filesystem` capability the daemon serves over wRPC: the gated
/// passthrough component (`component_path`), preopen-jailed to `root`, gated by
/// the shared `grants`. Served via `ServeExt` on the same server as broker/terminal.
#[derive(Clone)]
pub struct FsServe {
    pub component_path: PathBuf,
    pub root: PathBuf,
    pub grants: Arc<std::sync::Mutex<GrantStore>>,
}

/// Register every capability on a shared server and drive them until idle.
async fn drive<C, S>(
    srv: &S,
    broker_p: BrokerProvider,
    term_p: TerminalProvider,
    proc_p: ProcessProvider,
    ws_p: WorkspaceProvider,
    watch_p: WatchProvider,
    fs_serve: FsServe,
) -> anyhow::Result<()>
where
    C: AsOrigin + Send + Sync + 'static,
    S: wrpc_transport::Serve<Context = C>,
{
    let broker_invs = broker::serve(srv, broker_p).await.context("failed to serve broker")?;
    let term_invs = term::serve(srv, term_p).await.context("failed to serve terminal")?;
    let proc_invs = proc::serve(srv, proc_p).await.context("failed to serve process")?;
    let ws_invs = ws::serve(srv, ws_p).await.context("failed to serve workspace")?;
    let watch_invs = watch::serve(srv, watch_p).await.context("failed to serve watch")?;
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
    let mut term_i = select_all(term_invs.into_iter().map(|(i, n, s)| s.map(move |r| (i, n, r))));
    let mut proc_i = select_all(proc_invs.into_iter().map(|(i, n, s)| s.map(move |r| (i, n, r))));
    let mut ws_i = select_all(ws_invs.into_iter().map(|(i, n, s)| s.map(move |r| (i, n, r))));
    let mut watch_i = select_all(watch_invs.into_iter().map(|(i, n, s)| s.map(move |r| (i, n, r))));
    let mut tasks = JoinSet::new();
    loop {
        select! {
            Some((i, n, r)) = broker_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "broker invocation"),
            },
            Some((i, n, r)) = term_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "terminal invocation"),
            },
            Some((i, n, r)) = proc_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "process invocation"),
            },
            Some((i, n, r)) = ws_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "workspace invocation"),
            },
            Some((i, n, r)) = watch_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "watch invocation"),
            },
            Some(_) = tasks.join_next() => {}
            else => break,
        }
    }
    Ok(())
}

// ---- WebSocket stream-mux --------------------------------------------------
//
// One WebSocket carries EVERY invocation, each as an id-tagged virtual byte-stream — mirroring
// how the WebTransport server accepts many bidi streams over one QUIC session (below). This
// replaces the old one-socket-per-invocation model whose per-call handshake dominated fs latency
// (worse on Firefox). Wire framing per WS BINARY message: `[stream_id u32 LE][kind u8][payload]`,
// kind 0 = data, 1 = end (that direction's EOF). The demux loop hands each new id a fresh virtual
// `(tx, rx)` and spawns `srv.accept` on it, exactly as the per-connection path used to.
const MUX_DATA: u8 = 0;
const MUX_END: u8 = 1;

/// Virtual per-invocation read half: DATA frames for its id feed the channel; the client's END
/// drops the sender, which the reader sees as EOF (the wRPC end-of-input signal).
type MuxRx = StreamReader<UnboundedReceiverStream<io::Result<Bytes>>, Bytes>;

/// Virtual per-invocation write half: every `poll_write` becomes an `[id][DATA]` frame on the
/// shared socket; `poll_shutdown` (or drop) emits `[id][END]`, the server's end-of-output signal.
struct MuxTx {
    id: u32,
    sink: mpsc::UnboundedSender<Message>,
    ended: bool,
}

impl MuxTx {
    fn frame(&self, kind: u8, payload: &[u8]) -> Message {
        let mut buf = Vec::with_capacity(5 + payload.len());
        buf.extend_from_slice(&self.id.to_le_bytes());
        buf.push(kind);
        buf.extend_from_slice(payload);
        Message::binary(Bytes::from(buf))
    }
    fn end(&mut self) {
        if !self.ended {
            self.ended = true;
            let _ = self.sink.send(self.frame(MUX_END, &[]));
        }
    }
}

impl AsyncWrite for MuxTx {
    fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let msg = this.frame(MUX_DATA, buf);
        if this.sink.send(msg).is_err() {
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::BrokenPipe, "websocket closed")));
        }
        Poll::Ready(Ok(buf.len()))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut().end();
        Poll::Ready(Ok(()))
    }
}

impl Drop for MuxTx {
    // A handler that errors out (never shuts down cleanly) still owes the client an EOF.
    fn drop(&mut self) {
        self.end();
    }
}

/// Demux one accepted WebSocket into many concurrent wRPC invocations. A single writer task
/// serializes every virtual stream's output back onto the socket; the read loop routes inbound
/// frames to per-id channels, spawning `srv.accept` the first time it sees an id.
async fn serve_ws_mux(
    ws: WebSocketStream<tokio::net::TcpStream>,
    srv: Arc<wrpc_transport::Server<ReqCtx, MuxRx, MuxTx>>,
    origin: Option<String>,
) {
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // id -> the sender feeding that invocation's read half.
    let mut feeders: HashMap<u32, mpsc::UnboundedSender<io::Result<Bytes>>> = HashMap::new();
    while let Some(msg) = stream.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        if msg.is_close() {
            break;
        }
        if !msg.is_binary() {
            continue;
        }
        let payload = Bytes::from(msg.into_payload());
        if payload.len() < 5 {
            continue;
        }
        let id = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
        let kind = payload[4];
        let body = payload.slice(5..);
        match kind {
            MUX_DATA => {
                if let Some(feed) = feeders.get(&id) {
                    let _ = feed.send(Ok(body));
                } else {
                    // First frame for this id → a new invocation. Feed it, then spawn accept.
                    let (feed, feed_rx) = mpsc::unbounded_channel::<io::Result<Bytes>>();
                    let _ = feed.send(Ok(body));
                    feeders.insert(id, feed);
                    let rx: MuxRx = StreamReader::new(UnboundedReceiverStream::new(feed_rx));
                    let tx = MuxTx { id, sink: out_tx.clone(), ended: false };
                    let srv = Arc::clone(&srv);
                    let cx = ReqCtx { origin: origin.clone() };
                    tokio::spawn(async move {
                        if let Err(err) = srv.accept(cx, tx, rx).await {
                            tracing::error!(?err, id, "WS mux invocation failed");
                        }
                    });
                }
            }
            MUX_END => {
                // Client half-closed its input: drop the feeder → the read half hits EOF.
                feeders.remove(&id);
            }
            _ => {}
        }
    }
    writer.abort();
}

/// Serve every capability over wRPC/WebSocket on `listener`.
pub async fn serve_websocket_all(
    listener: TcpListener,
    broker_p: BrokerProvider,
    term_p: TerminalProvider,
    proc_p: ProcessProvider,
    ws_p: WorkspaceProvider,
    watch_p: WatchProvider,
    fs_serve: FsServe,
) -> anyhow::Result<()> {
    let srv = Arc::new(wrpc_transport::Server::<ReqCtx, MuxRx, MuxTx>::default());
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
                                    // One socket → many multiplexed invocations.
                                    serve_ws_mux(ws, srv, origin).await;
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
    let res = drive(srv.as_ref(), broker_p, term_p, proc_p, ws_p, watch_p, fs_serve).await;
    accept.abort();
    res
}

/// Serve every capability over wRPC/WebTransport bound at `bind` with `identity`.
pub async fn serve_webtransport_all(
    bind: SocketAddr,
    identity: wtransport::Identity,
    broker_p: BrokerProvider,
    term_p: TerminalProvider,
    proc_p: ProcessProvider,
    ws_p: WorkspaceProvider,
    watch_p: WatchProvider,
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
    let res = drive(srv.as_ref(), broker_p, term_p, proc_p, ws_p, watch_p, fs_serve).await;
    accept.abort();
    res
}
