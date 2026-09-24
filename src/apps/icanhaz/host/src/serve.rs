//! The daemon's serving layer: one wRPC `Server` per transport (WebSocket,
//! WebTransport, iroh), serving everything on it. wRPC routes by the instance
//! name in each invocation header, so one port covers the control plane (the
//! broker, configuration and the component store, served by the daemon's own
//! handlers) and every capability (the shipped components and the store's
//! novel components, served through `component_serve`), with one
//! resource-drop op beside them. They share one grant store and one handle
//! registry, so a grant minted by `broker.request` is the one a capability's
//! `open` checks, whichever transport either arrived on.

use core::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context as _;
use futures::stream::select_all;
use futures::StreamExt as _;
use tokio::net::TcpListener;
use tokio::select;
use tokio::task::JoinSet;

use std::path::PathBuf;

use crate::broker::{bindings as broker, BrokerProvider, GrantStore};
use crate::component_serve::{
    component_router, serve_capability, serve_interface, serve_resource_drop, ChainSource, Handles,
    Router,
};
use crate::components::{bindings as components, ComponentsProvider};
use crate::{AsOrigin, ReqCtx};
use icanhaz_broker::configuration_serve::{bindings as configuration, ConfigurationProvider};

use core::pin::Pin;
use core::task::{Context, Poll};
use std::collections::{HashMap, HashSet};
use std::io;

use bytes::Bytes;
use futures::SinkExt as _;
use tokio::io::AsyncWrite;
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_util::io::StreamReader;
use wrpc_websockets::tokio_websockets::{Message, WebSocketStream};

/// The shipped capability components the daemon serves over wRPC, each
/// through a router over the raw host layer: the filesystem, process,
/// terminal, watch, workspace and inference, gated by the shared `grants`.
#[derive(Clone)]
pub struct CapabilitiesServe {
    /// The shipped capability components, by name, and where their bytes are.
    pub components: Vec<(String, PathBuf)>,
    pub grants: Arc<std::sync::Mutex<GrantStore>>,
    /// Composes the chain a grant names in front of the shipped component
    /// providing its interface (see `components::capability_chain`).
    pub chains: Option<ChainSource>,
    /// The raw host layer the components import.
    pub raw: Arc<crate::raw::Raw>,
    /// The daemon's handle registry, shared with the store components' routers.
    pub handles: Arc<Handles>,
}

/// The novel interfaces store components provide, served through routers
/// shared by every transport: one [`Router`] per interface, created when the
/// first transport serves it, chains keyed by the grants' `via`.
#[derive(Clone)]
pub struct ComponentsServe {
    pub components: Arc<crate::components::ComponentStore>,
    pub grants: Arc<std::sync::Mutex<GrantStore>>,
    pub routers:
        Arc<std::sync::Mutex<HashMap<String, Arc<Router<wrpc_transport::tcp::Client<String>>>>>>,
    /// One per transport serving: called with every component added after
    /// the transport came up, so its new interfaces are served there too.
    sinks: Arc<std::sync::Mutex<Vec<crate::components::AfterAdd>>>,
    /// The raw host layer the shipped components a novel component composes with import.
    raw: Arc<crate::raw::Raw>,
    /// The daemon's handle registry.
    handles: Arc<Handles>,
}

impl ComponentsServe {
    pub fn new(
        components: Arc<crate::components::ComponentStore>,
        grants: Arc<std::sync::Mutex<GrantStore>>,
        raw: Arc<crate::raw::Raw>,
        handles: Arc<Handles>,
    ) -> Self {
        Self {
            components,
            grants,
            routers: Arc::new(std::sync::Mutex::new(HashMap::new())),
            sinks: Arc::new(std::sync::Mutex::new(Vec::new())),
            raw,
            handles,
        }
    }

    /// A component landed: give its novel interfaces their admission
    /// environments, then serve them on every transport, and only then return,
    /// so the `add` that brought it replies once the component is usable.
    pub async fn added(&self, info: crate::components::ComponentInfo) {
        register_component_envs_for(&self.components, &self.grants, &info);
        let sinks: Vec<crate::components::AfterAdd> =
            self.sinks.lock().unwrap_or_else(|e| e.into_inner()).clone();
        for sink in sinks {
            sink(info.clone()).await;
        }
    }

    fn add_sink(&self, sink: crate::components::AfterAdd) {
        self.sinks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(sink);
    }

    /// The router for `interface`, created on first use. Its chains have no
    /// preopens; a component sees files only through the descriptor the
    /// shipped filesystem capability composed in front of it yields for the
    /// grant delegated to it.
    fn router_for(
        &self,
        interface: &str,
    ) -> anyhow::Result<Arc<Router<wrpc_transport::tcp::Client<String>>>> {
        let mut routers = self.routers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(r) = routers.get(interface) {
            return Ok(Arc::clone(r));
        }
        let router = component_router(
            interface,
            Arc::clone(&self.components),
            wrpc_transport::tcp::Client::from("127.0.0.1:1".to_string()),
            (),
            Arc::clone(&self.grants),
            Arc::clone(&self.raw),
            Arc::clone(&self.handles),
        )?;
        routers.insert(interface.to_string(), Arc::clone(&router));
        Ok(router)
    }

    /// Serve every novel interface `info` exports on `srv` that `served` does
    /// not yet list, and remember them there.
    async fn serve_new<S>(
        &self,
        srv: &S,
        info: &crate::components::ComponentInfo,
        served: &mut HashSet<String>,
        handlers: &mut tokio::task::JoinSet<()>,
    ) -> anyhow::Result<()>
    where
        S: wrpc_transport::Serve,
        S::Context: AsOrigin,
    {
        for iface in &info.exports {
            if crate::components::is_native_interface(iface) || served.contains(iface) {
                continue;
            }
            let router = self.router_for(iface)?;
            let bytes = self.components.get(&info.hash)?;
            let engine = router.engine().clone();
            let component = tokio::task::spawn_blocking(move || {
                wasmtime::component::Component::new(&engine, &bytes)
            })
            .await
            .context("compile component")?
            .map_err(anyhow::Error::from)?;
            let mut set = serve_interface(srv, &router, &component.component_type(), iface).await?;
            while let Some(task) = set.try_join_next() {
                let _ = task;
            }
            // Move the serving tasks onto the caller's set.
            handlers.spawn(async move {
                let mut set = set;
                while set.join_next().await.is_some() {}
            });
            served.insert(iface.clone());
            tracing::info!(interface = %iface, hash = %info.hash, "novel capability served from the store");
        }
        Ok(())
    }
}

/// Give every novel interface `info` exports an admission environment built
/// from the component's own WIT, so scopes over it type-check and admit like
/// a native kind's.
pub fn register_component_envs_for(
    components: &crate::components::ComponentStore,
    grants: &Arc<std::sync::Mutex<GrantStore>>,
    info: &crate::components::ComponentInfo,
) {
    for iface in &info.exports {
        if crate::components::is_native_interface(iface) {
            continue;
        }
        let env = match components
            .get(&info.hash)
            .and_then(|bytes| crate::components::env_for(&bytes, iface))
        {
            Ok(env) => env,
            Err(e) => {
                tracing::warn!(error = %e, interface = %iface, "no admission environment for a store interface");
                continue;
            }
        };
        if let Err(e) = grants.lock().unwrap().add_environment(iface, env) {
            tracing::warn!(error = %e, interface = %iface, "admission environment rejected");
        }
    }
}

/// Register every capability on a shared server and drive them until idle.
async fn drive<C, S>(
    srv: Arc<S>,
    broker_p: BrokerProvider,
    cfg_p: ConfigurationProvider,
    cmp_p: ComponentsProvider,
    capabilities: CapabilitiesServe,
    components: ComponentsServe,
) -> anyhow::Result<()>
where
    C: AsOrigin + Send + Sync + 'static,
    S: wrpc_transport::Serve<Context = C> + Send + Sync + 'static,
{
    let srv_ref: &S = srv.as_ref();
    // The control plane: the daemon's own handlers.
    let broker_invs = broker::serve(srv_ref, broker_p)
        .await
        .context("failed to serve broker")?;
    let cfg_invs = configuration::serve(srv_ref, cfg_p)
        .await
        .context("failed to serve configuration")?;
    let cmp_invs = components::serve(srv_ref, cmp_p)
        .await
        .context("failed to serve components")?;
    // Every capability is a shipped component served through a router: the
    // filesystem and the process, terminal, watch, workspace and inference
    // components alike, each over the raw host layer, each with its chains
    // composed in front of it. No store has preopens: the filesystem's root
    // comes from the raw `jail.open(grant)`. The placeholder client is never
    // invoked (no polyfill).
    // Every served handle, from any capability or store component, is
    // released through one drop service per server.
    let mut _capability_handlers = Vec::new();
    let mut drop_handlers = JoinSet::new();
    serve_resource_drop(
        srv_ref,
        Arc::clone(&capabilities.handles),
        &mut drop_handlers,
    )
    .await
    .context("failed to serve the resource-drop op")?;
    _capability_handlers.push(drop_handlers);
    for (name, path) in &capabilities.components {
        let bytes = std::fs::read(path).with_context(|| {
            format!(
                "read the {name} capability component {} (build the wasm guests first: \
                     src/apps/icanhaz/scripts/build-wasm.sh)",
                path.display()
            )
        })?;
        let handlers = serve_capability(
            srv_ref,
            &bytes,
            wrpc_transport::tcp::Client::from("127.0.0.1:1".to_string()),
            (),
            Arc::clone(&capabilities.grants),
            capabilities.chains.clone(),
            Arc::clone(&capabilities.raw),
            Arc::clone(&capabilities.handles),
        )
        .await
        .with_context(|| format!("failed to serve the {name} capability"))?;
        _capability_handlers.push(handlers);
    }
    // Novel interfaces the store provides: every one present now, and every
    // one a component adds later, served on this transport through the
    // shared routers.
    let mut served: HashSet<String> = HashSet::new();
    let mut _component_handlers = tokio::task::JoinSet::new();
    for info in components.components.list().await {
        if let Err(e) = components
            .serve_new(srv_ref, &info, &mut served, &mut _component_handlers)
            .await
        {
            tracing::warn!(error = %e, hash = %info.hash, "store component not served");
        }
    }
    // Components added from now on are served here before their `add` replies.
    let sink_state = Arc::new(tokio::sync::Mutex::new((served, _component_handlers)));
    components.add_sink({
        let srv = Arc::clone(&srv);
        let components = components.clone();
        Arc::new(move |info: crate::components::ComponentInfo| {
            let srv = Arc::clone(&srv);
            let components = components.clone();
            let state = Arc::clone(&sink_state);
            Box::pin(async move {
                let mut state = state.lock().await;
                let (served, handlers) = &mut *state;
                if let Err(e) = components
                    .serve_new(srv.as_ref(), &info, served, handlers)
                    .await
                {
                    tracing::warn!(error = %e, hash = %info.hash, "store component not served");
                }
            })
        })
    });
    let mut broker_i = select_all(
        broker_invs
            .into_iter()
            .map(|(i, n, s)| s.map(move |r| (i, n, r))),
    );
    let mut cfg_i = select_all(
        cfg_invs
            .into_iter()
            .map(|(i, n, s)| s.map(move |r| (i, n, r))),
    );
    let mut cmp_i = select_all(
        cmp_invs
            .into_iter()
            .map(|(i, n, s)| s.map(move |r| (i, n, r))),
    );
    let mut tasks = JoinSet::new();
    loop {
        select! {
            Some((i, n, r)) = broker_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "broker invocation"),
            },
            Some((i, n, r)) = cfg_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "configuration invocation"),
            },
            Some((i, n, r)) = cmp_i.next() => match r {
                Ok(fut) => { tasks.spawn(async move { let _ = fut.await; }); }
                Err(err) => tracing::warn!(?err, instance = i, name = n, "components invocation"),
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
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let msg = this.frame(MUX_DATA, buf);
        if this.sink.send(msg).is_err() {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "websocket closed",
            )));
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

    // One connection id per socket: every invocation multiplexed over it shares
    // it, and the resource handles served to it are bound to it.
    let conn = Some(crate::next_connection());
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
                    let tx = MuxTx {
                        id,
                        sink: out_tx.clone(),
                        ended: false,
                    };
                    let srv = Arc::clone(&srv);
                    let cx = ReqCtx {
                        origin: origin.clone(),
                        peer: None,
                        conn,
                    };
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
    cfg_p: ConfigurationProvider,
    cmp_p: ComponentsProvider,
    capabilities: CapabilitiesServe,
    components: ComponentsServe,
) -> anyhow::Result<()> {
    let srv = Arc::new(wrpc_transport::Server::<ReqCtx, MuxRx, MuxTx>::default());
    let accept = tokio::spawn({
        let srv = Arc::clone(&srv);
        async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _addr)) => {
                        // Every invocation is a few small frames each way; with
                        // Nagle on, Linux holds each behind the peer's delayed
                        // ACK (~40 ms an op on loopback; macOS hid it).
                        if let Err(err) = stream.set_nodelay(true) {
                            tracing::warn!(?err, "TCP_NODELAY");
                        }
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
    let res = drive(
        Arc::clone(&srv),
        broker_p,
        cfg_p,
        cmp_p,
        capabilities,
        components,
    )
    .await;
    accept.abort();
    res
}

/// Serve every capability over wRPC/iroh on `endpoint`: the peer path, where
/// the QUIC handshake authenticates the caller's endpoint id and every
/// invocation carries it as its context (a certificate's `peer` audience is
/// checked against exactly that).
pub async fn serve_iroh_all(
    endpoint: iroh::Endpoint,
    broker_p: BrokerProvider,
    cfg_p: ConfigurationProvider,
    cmp_p: ComponentsProvider,
    capabilities: CapabilitiesServe,
    components: ComponentsServe,
) -> anyhow::Result<()> {
    let srv = Arc::new(wrpc_transport_iroh::Server::<ReqCtx>::new());
    let accept = tokio::spawn(crate::iroh::accept_iroh::<()>(endpoint, Arc::clone(&srv)));
    let res = drive(
        Arc::clone(&srv),
        broker_p,
        cfg_p,
        cmp_p,
        capabilities,
        components,
    )
    .await;
    accept.abort();
    res
}

/// Serve every capability over wRPC/WebTransport bound at `bind` with `identity`.
pub async fn serve_webtransport_all(
    bind: SocketAddr,
    identity: wtransport::Identity,
    broker_p: BrokerProvider,
    cfg_p: ConfigurationProvider,
    cmp_p: ComponentsProvider,
    capabilities: CapabilitiesServe,
    components: ComponentsServe,
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
                        // One connection id per session; its streams share it.
                        let conn_id = Some(crate::next_connection());
                        loop {
                            let (tx, rx) = conn.accept_bi().await.context("accept bidi stream")?;
                            srv.accept(
                                ReqCtx {
                                    origin: origin.clone(),
                                    peer: None,
                                    conn: conn_id,
                                },
                                tx,
                                rx,
                            )
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
    let res = drive(
        Arc::clone(&srv),
        broker_p,
        cfg_p,
        cmp_p,
        capabilities,
        components,
    )
    .await;
    accept.abort();
    res
}
