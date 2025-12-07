use crate::cert::CertificateAuthority;
use crate::config::AppConfig;
use crate::events::Event;
use crate::events::connect::Connect;
use crate::events::response::ContextualResponse;
use crate::plugins::cel::{CelConnect, CelRequest};
use crate::plugins::registry::{HostHandleRequestResult, HostHandleResponseResult, PluginRegistry};
use crate::proxy::utils::convert_hyper_boxed_body_to_reqwest_request;
use crate::wasm::bindgen::EventData;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::ContextualResponse as WasiContextualResponse;

use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, StatusCode};
use hyper::{Response, upgrade};
use tokio::sync::{Notify, RwLock};
use wasmtime_wasi_http::p3::WasiHttpView;
use wasmtime_wasi_http::p3::bindings::http::types::ErrorCode;
use wasmtime_wasi_http::p3::{Request as WasiRequest, Response as WasiResponse};

use std::{net::SocketAddr, sync::Arc};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, warn};

use hyper_util::server::conn::auto::Builder as AutoServer;
use hyper_util::{rt::TokioExecutor, rt::TokioIo};

mod utils;
pub use utils::{
    ProxyError, ProxyResult, UpstreamClient, build_server_tls_for_host, client,
    convert_boxbody_to_full_response, convert_hyper_incoming_to_reqwest_request,
    convert_reqwest_to_hyper_response, is_closed, parse_authority_host_port, strip_proxy_headers,
};

#[cfg(test)]
mod tests;

#[derive(Clone)]
pub struct ProxyServer {
    listen_addr: Option<SocketAddr>,
    ca: Arc<CertificateAuthority>,
    plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
    config: Arc<AppConfig>,
    upstream: UpstreamClient,
    shutdown_notify: Arc<Notify>,
}

impl ProxyServer {
    pub fn new(
        ca: CertificateAuthority,
        plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
        config: AppConfig,
    ) -> ProxyResult<Self> {
        let upstream = client(ca.clone())?;
        Ok(Self {
            listen_addr: None,
            ca: Arc::new(ca),
            plugin_registry,
            config: Arc::new(config),
            upstream,
            shutdown_notify: Arc::new(Notify::new()),
        })
    }

    /// Returns the actual bound listen address, if the server has been started
    pub fn listen_addr(&self) -> Option<SocketAddr> {
        self.listen_addr
    }

    /// Starts the server: binds the listener and spawns the accept loop.
    /// Returns immediately once the listener is bound.
    pub async fn start(&mut self) -> ProxyResult<()> {
        // Determine the bind address: use configured address or default to OS-assigned port
        let bind_addr: SocketAddr = if let Some(ref addr_str) = self.config.proxy.proxy_bind_addr {
            addr_str.parse().map_err(|e| {
                ProxyError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, e))
            })?
        } else {
            "127.0.0.1:0".parse().unwrap()
        };

        let listener = TcpListener::bind(bind_addr).await?;

        // Store the actual bound address
        self.listen_addr = Some(listener.local_addr()?);
        let shutdown = self.shutdown_notify.clone();
        let server = self.clone();

        // Spawn the accept loop
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown.notified() => break,
                    accept_result = listener.accept() => {
                        match accept_result {
                            Ok((io, peer)) => {
                                debug!("Accepted connection from {}", peer);
                                let shared = server.clone();
                                tokio::spawn(async move {
                                    let svc = service_fn(move |req: Request<Incoming>| {
                                        let shared = shared.clone();
                                        async move {
                                            shared.handle_plain_http(req).await.map_err(|e| std::io::Error::other(e.to_string()))
                                        }
                                    });

                                    if let Err(e) = http1::Builder::new()
                                        .preserve_header_case(true)
                                        .title_case_headers(true)
                                        .serve_connection(TokioIo::new(io), svc)
                                        .with_upgrades()
                                        .await
                                    {
                                        if is_closed(&e) {
                                            debug!("client closed: {}", e);
                                        } else {
                                            error!("conn error: {}", e);
                                        }
                                    }
                                });
                            }
                            Err(e) => error!("Accept error: {}", e),
                        }
                    }
                }
            }
        });

        Ok(())
    }

    /// Returns a future that resolves when the server stops.
    /// Currently this is never unless shutdown is implemented.
    pub async fn join(&self) {
        self.shutdown_notify.notified().await;
    }

    pub async fn shutdown(&self) {
        self.shutdown_notify.notify_waiters();
    }

    /// Determine whether any plugins want to handle this connection
    /// Returns true if MITM should be performed, false if connection should be forwarded transparently
    async fn handle_connect(&self, authority: &str) -> bool {
        let Some(plugin_registry) = &self.plugin_registry else {
            debug!("No plugin registry, skipping MITM for {}", authority);
            return false;
        };

        let (host, port) = match parse_authority_host_port(authority, 443) {
            Ok((h, p)) => (h, p),
            Err(e) => {
                warn!("Failed to parse authority '{}': {}", authority, e);
                return false;
            }
        };

        let connect_event: Box<dyn Event> = Box::new(Connect::new(host, port));
        let has_matching_plugin = {
            let registry = plugin_registry.read().await;
            registry.can_handle(&connect_event)
        };

        if has_matching_plugin {
            debug!(
                "Found plugin(s) that can handle connection to {}, performing MITM",
                authority
            );
            true
        } else {
            debug!(
                "No plugins match connection to {}, forwarding transparently",
                authority
            );
            false
        }
    }

    /// Forward a connection transparently without MITM
    async fn forward_connection_transparently(
        &self,
        upgraded: upgrade::Upgraded,
        authority: String,
    ) -> ProxyResult<()> {
        debug!("Forwarding connection transparently to {}", authority);

        // Parse host and port
        let (host, port) = parse_authority_host_port(&authority, 443)?;

        // Connect to the upstream server
        let upstream = TcpStream::connect(format!("{}:{}", host, port)).await?;
        debug!("Connected to upstream {}:{}", host, port);

        // Wrap the upgraded connection with TokioIo for compatibility
        let mut client_io = TokioIo::new(upgraded);
        let mut upstream_io = upstream;

        // Use bidirectional copy to tunnel the connection
        match tokio::io::copy_bidirectional(&mut client_io, &mut upstream_io).await {
            Ok((client_to_upstream_bytes, upstream_to_client_bytes)) => {
                debug!(
                    "Transparent forwarding completed for {}: {} bytes client->upstream, {} bytes upstream->client",
                    authority, client_to_upstream_bytes, upstream_to_client_bytes
                );
            }
            Err(e) => {
                debug!("Transparent forwarding error for {}: {}", authority, e);
                return Err(ProxyError::Io(e));
            }
        }

        Ok(())
    }

    /// Handles requests received on the cleartext proxy port.
    /// - Normal HTTP requests are proxied with the upstream client.
    /// - CONNECT is acknowledged, then we either:
    ///   - Run TLS MITM with an auto (h1/h2) server if plugins want to handle the connection
    ///   - Forward the connection transparently if no plugins match
    async fn handle_plain_http(
        &self,
        mut req: Request<Incoming>,
    ) -> Result<Response<Full<Bytes>>, ProxyError> {
        if req.method() == Method::CONNECT {
            debug!("Handling CONNECT request");

            // Host:port lives in the request-target for CONNECT (authority-form)
            let authority = req
                .uri()
                .authority()
                .map(|a| a.as_str().to_string())
                .unwrap_or_default();
            debug!("CONNECT request authority: {}", authority);
            if authority.is_empty() {
                let resp = Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Full::new(Bytes::from("CONNECT missing authority")))?;
                return Ok::<_, ProxyError>(resp);
            }

            // Check if any plugins want to handle this connection
            let should_mitm = self.handle_connect(&authority).await;

            let on_upgrade = upgrade::on(&mut req);

            if should_mitm {
                // Perform MITM - existing behavior
                let ca = self.ca.clone();
                let upstream = self.upstream.clone();
                let plugin_registry = self.plugin_registry.clone();

                tokio::spawn(async move {
                    match on_upgrade.await {
                        Ok(upgraded) => {
                            if let Err(e) = run_tls_mitm(
                                upstream,
                                upgraded,
                                authority.clone(),
                                ca,
                                plugin_registry,
                            )
                            .await
                            {
                                match &e {
                                    ProxyError::Io(ioe) if is_closed(ioe) => {
                                        debug!("tls tunnel closed")
                                    }
                                    _ => warn!("tls mitm error for upstream {}: {}", authority, e),
                                }
                            }
                        }
                        Err(e) => warn!("upgrade error (CONNECT): {}", e),
                    }
                });
            } else {
                // Forward transparently - new behavior
                let server = self.clone();
                tokio::spawn(async move {
                    match on_upgrade.await {
                        Ok(upgraded) => {
                            if let Err(e) = server
                                .forward_connection_transparently(upgraded, authority.clone())
                                .await
                            {
                                match &e {
                                    ProxyError::Io(ioe) if is_closed(ioe) => {
                                        debug!("transparent tunnel closed")
                                    }
                                    _ => warn!(
                                        "transparent forwarding error for upstream {}: {}",
                                        authority, e
                                    ),
                                }
                            }
                        }
                        Err(e) => warn!("upgrade error (CONNECT): {}", e),
                    }
                });
            }

            // Return 200 Connection Established for CONNECT
            return Ok(Response::builder()
                .status(StatusCode::OK)
                .body(Full::new(Bytes::new()))?);
        }

        // ----- Plain HTTP proxying (request line is absolute-form from clients) -----
        debug!(
            "Handling plain HTTP request: {} {}",
            req.method(),
            req.uri()
        );
        strip_proxy_headers(req.headers_mut());
        // TODO: plugin: on_request(&mut req, &conn).await;

        // Convert hyper request to reqwest request
        let reqwest_req = convert_hyper_incoming_to_reqwest_request(req, &self.upstream)?;
        let resp = self.upstream.execute(reqwest_req).await?;

        // Convert reqwest response back to hyper response
        let mut response = convert_reqwest_to_hyper_response(resp).await?;

        // Strip hop-by-hop headers from the response
        strip_proxy_headers(response.headers_mut());

        Ok(response)
    }
}

// --- Extracted helpers from run_tls_mitm ---

pub(crate) async fn perform_upstream(
    upstream: &reqwest::Client,
    req: reqwest::Request,
) -> Response<Full<Bytes>> {
    match upstream.execute(req).await {
        Ok(resp) => {
            debug!("Upstream response status: {}", resp.status());
            match convert_reqwest_to_hyper_response(resp).await {
                Ok(mut response) => {
                    strip_proxy_headers(response.headers_mut());
                    response
                }
                Err(err) => {
                    error!("Failed to convert response: {}", err);
                    Response::builder()
                        .status(StatusCode::BAD_GATEWAY)
                        .body(Full::new(Bytes::from(
                            "Failed to convert upstream response",
                        )))
                        .unwrap()
                }
            }
        }
        Err(err) => {
            error!("Upstream request failed with detailed error: {:?}", err);
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Full::new(Bytes::from(err.to_string())))
                .unwrap()
        }
    }
}

/// Fix origin-form requests by adding authority from Host header to URI
fn fix_origin_form_request(mut req: Request<Incoming>) -> Request<Incoming> {
    // Check if URI has no authority but has a Host header (origin-form request)
    if req.uri().authority().is_none()
        && let Some(host_header) = req.headers().get(hyper::header::HOST)
        && let Ok(host_str) = host_header.to_str()
    {
        // Clone the host string to avoid borrowing conflicts
        let host_string = host_str.to_string();

        // Reconstruct URI with authority from Host header
        let original_uri = req.uri();
        let mut uri_builder = hyper::Uri::builder();

        // Preserve scheme (default to https for TLS connections)
        if let Some(scheme) = original_uri.scheme() {
            uri_builder = uri_builder.scheme(scheme.clone());
        } else {
            uri_builder = uri_builder.scheme("https");
        }

        // Add authority from Host header
        uri_builder = uri_builder.authority(host_string.as_str());

        // Preserve path and query
        if let Some(path_and_query) = original_uri.path_and_query() {
            uri_builder = uri_builder.path_and_query(path_and_query.clone());
        } else {
            uri_builder = uri_builder.path_and_query("/");
        }

        // Build new URI and update request
        if let Ok(new_uri) = uri_builder.build() {
            *req.uri_mut() = new_uri;
            debug!(
                "Fixed origin-form request: added authority '{}' to URI",
                host_string
            );
        }
    }
    req
}

/// Performs TLS MITM on a CONNECT tunnel, then serves the *client-facing* side
/// with a Hyper auto server (h1 or h2) and forwards each request to the real upstream via `upstream`.
async fn run_tls_mitm(
    upstream: reqwest::Client,
    upgraded: upgrade::Upgraded,
    authority: String,
    ca: Arc<CertificateAuthority>,
    plugin_registry: Option<Arc<RwLock<PluginRegistry>>>,
) -> ProxyResult<()> {
    debug!("Running TLS MITM for {}", authority);

    // Extract host + port, default :443
    let (host, _port) = parse_authority_host_port(&authority, 443)?;

    // --- Build a server TLS config for the client side (fake cert for `host`) ---
    let server_tls = build_server_tls_for_host(&ca, &host).await?;
    let acceptor = TlsAcceptor::from(Arc::new(server_tls));

    let tls = acceptor.accept(TokioIo::new(upgraded)).await?;
    debug!("TLS established with client for {}", host);

    // Auto (h1/h2) Hyper server over the client TLS stream
    let executor = TokioExecutor::new();
    let auto: AutoServer<TokioExecutor> = AutoServer::new(executor);

    // Service that proxies each decrypted request to the real upstream host
    let svc = {
        service_fn(move |req: Request<Incoming>| {
            let upstream = upstream.clone();
            let plugin_registry = plugin_registry.clone();

            async move {
                let method = req.method().clone();
                let uri = req.uri().clone();
                let req = fix_origin_form_request(req);
                debug!("Handling TLS request: {} {}", method, uri);
                let mut request_ctx = CelRequest::from(&req);

                let request_event_result = if let Some(registry) = &plugin_registry {
                    let registry = registry.read().await;
                    let (parts, body) = req.into_parts();
                    let mapped_body = body.map_err(|e| ErrorCode::from_hyper_request_error(e));
                    let req = Request::from_parts(parts, mapped_body);
                    let (request, _io) = WasiRequest::from_http(req);
                    let event: Box<dyn Event> = Box::new(request);

                    registry.handle_event(event).await
                } else {
                    let request_result = convert_hyper_incoming_to_reqwest_request(req, &upstream);
                    match request_result {
                        Ok(rq) => return Ok(perform_upstream(&upstream, rq).await),
                        Err(err) => {
                            return Response::builder().status(StatusCode::BAD_REQUEST).body(
                                Full::new(Bytes::from(format!(
                                    "Failed to convert request: {}",
                                    err
                                ))),
                            );
                        }
                    }
                };

                debug!(
                    "Handled request event, checking result and performing upstream call if needed"
                );

                let initial_response = match request_event_result {
                    Err(e) => Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(Full::new(Bytes::from(format!(
                            "Plugin event handling error: {}",
                            e
                        ))))
                        .expect("Could not construct error Response"),
                    Ok((event_data, mut store)) => match event_data {
                        EventData::Request(rq) => {
                            // TODO: no unwraps
                            let rq = store.data_mut().http().table.delete(rq).unwrap();
                            request_ctx = CelRequest::from(&rq);
                            let (rq, _io) = rq.into_http(store, async { Ok(()) }).unwrap();

                            let rq: Result<reqwest::Request, ProxyError> =
                                convert_hyper_boxed_body_to_reqwest_request(rq, &upstream);
                            match rq {
                                Ok(rq) => perform_upstream(&upstream, rq).await,
                                Err(err) => Response::builder()
                                    .status(StatusCode::BAD_REQUEST)
                                    .body(Full::new(Bytes::from(format!(
                                        "Failed to convert request: {}",
                                        err
                                    ))))
                                    .unwrap(),
                            }
                        }
                        EventData::Response(WasiContextualResponse { response, .. }) => {
                            let response = store.data_mut().http().table.delete(response).unwrap();
                            let response = response.into_http(store, async { Ok(()) }).unwrap();
                            match convert_boxbody_to_full_response(response).await {
                                Ok(converted_resp) => converted_resp,
                                Err(err) => {
                                    error!("Failed to convert plugin response: {}", err);
                                    Response::builder()
                                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                                        .body(Full::new(Bytes::from(
                                            "Failed to convert plugin response",
                                        )))
                                        .unwrap()
                                }
                            }
                        }
                        _ => Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .body(Full::new(Bytes::from(
                                "Unexpected event data type from plugin",
                            )))
                            .expect("Could not construct error Response"),
                    },
                };

                debug!("Initial response obtained, proceeding to response event handling");

                let handled_response = if let Some(registry) = &plugin_registry {
                    let registry = registry.read().await;
                    let (response, _io) = WasiResponse::from_http(initial_response);
                    let contextual_response = ContextualResponse {
                        request: request_ctx.into(),
                        response,
                    };
                    registry.handle_event(Box::new(contextual_response)).await
                } else {
                    return Ok(initial_response);
                };

                debug!("Final response ready, sending back to client");

                let final_response = match handled_response {
                    Ok((event_data, mut store)) => match event_data {
                        EventData::Response(WasiContextualResponse { response, .. }) => {
                            let response = store.data_mut().http().table.delete(response).unwrap();
                            let response = response.into_http(store, async { Ok(()) }).unwrap();
                            match convert_boxbody_to_full_response(response).await {
                                Ok(converted_resp) => converted_resp,
                                Err(err) => {
                                    error!("Failed to convert plugin response: {}", err);
                                    Response::builder()
                                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                                        .body(Full::new(Bytes::from(
                                            "Failed to convert plugin response",
                                        )))
                                        .unwrap()
                                }
                            }
                        }
                        _ => Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .body(Full::new(Bytes::from(
                                "Unexpected event data type from plugin",
                            )))
                            .unwrap(),
                    },
                    Err(e) => {
                        error!("Response event handling error: {}", e);
                        Response::builder()
                            .status(StatusCode::INTERNAL_SERVER_ERROR)
                            .body(Full::new(Bytes::from(format!(
                                "Plugin response event handling error: {}",
                                e
                            ))))
                            .unwrap()
                    }
                };

                // if let Some(registry) = &plugin_registry {
                //     let registry = registry.read().await;
                //     let response = registry.handle_response_content(final_response.unwrap()).await;
                //     return Ok(response);
                // }
                Ok(final_response)
            }
        })
    };

    // Serve the single TLS connection
    if let Err(e) = auto.serve_connection(TokioIo::new(tls), svc).await {
        if is_closed(&e) {
            debug!("TLS connection closed: {}", e);
        } else {
            warn!("TLS connection error: {}", e);
        }
    }

    Ok(())
}
