use crate::cert::CertificateAuthority;
use crate::config::AppConfig;
use crate::events::Event;
use crate::events::connect::Connect;
use crate::events::content::InboundContent;
use crate::events::response::ContextualResponse;
use crate::http::utils::ContentTyped;
use crate::plugins::cel::CelRequest;
use crate::plugins::registry::PluginRegistry;
use crate::proxy::utils::convert_hyper_boxed_body_to_reqwest_request;
use crate::proxy::tenant::TenantContext;
use crate::wasm::bindgen::Event as WasmEvent;
use crate::wasm::bindgen::witmproxy::plugin::capabilities::ContextualResponse as WasiContextualResponse;

use bytes::Bytes;
use http_body_util::BodyExt;

use crate::proxy::utils::wasi_error_to_code;
use http_body_util::Full;
use http_body_util::combinators::UnsyncBoxBody;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, StatusCode};
use hyper::{Response, upgrade};
use tokio::sync::Notify;
use wasmtime_wasi_http::WasiHttpView;
use wasmtime_wasi_http::p3::bindings::http::types::ErrorCode;
use wasmtime_wasi_http::p3::{Request as WasiRequest, Response as WasiResponse};

use std::sync::OnceLock;
use std::{net::SocketAddr, sync::Arc};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, warn};

use hyper_util::server::conn::auto::Builder as AutoServer;
use hyper_util::{rt::TokioExecutor, rt::TokioIo};

pub mod netfilter;
pub mod tenant;
pub mod tenant_resolver;
pub mod transparent;

pub(crate) mod utils;
pub use utils::{
    ProxyError, ProxyResult, UpstreamClient, build_server_tls_for_host, client,
    convert_hyper_incoming_to_reqwest_request, convert_reqwest_to_hyper_response, is_closed,
    parse_authority_host_port, strip_proxy_headers,
};

#[cfg(test)]
mod tests;

/// Build a plaintext `Response` with the given status and body.
///
/// Centralizes the `Response::builder().status(..).body(Full::new(..)..boxed_unsync())`
/// construction used throughout this module and removes the inconsistent
/// `unwrap()`/`expect()` calls: the builder can only fail here if given an invalid
/// status or header, and we set neither, so the `expect` is unreachable.
fn plain_response(
    status: StatusCode,
    msg: impl Into<Bytes>,
) -> Response<UnsyncBoxBody<Bytes, ErrorCode>> {
    Response::builder()
        .status(status)
        .body(
            Full::new(msg.into())
                .map_err(|_| ErrorCode::InternalError(Some("conversion error".to_string())))
                .boxed_unsync(),
        )
        .expect("plain_response builder cannot fail with a valid status and static body")
}

#[derive(Clone)]
pub struct ProxyServer {
    listen_addr: Option<SocketAddr>,
    ca: Arc<CertificateAuthority>,
    plugin_registry: Option<Arc<PluginRegistry>>,
    config: Arc<AppConfig>,
    upstream: UpstreamClient,
    shutdown_notify: Arc<Notify>,
    /// Local bind address of our own management web server, if known.
    /// Connections targeting this port are short-circuited to a direct
    /// loopback connection so the management UI keeps working when the
    /// system proxy is enabled and the user opens it via a public hostname.
    management_addr: Arc<OnceLock<SocketAddr>>,
}

impl ProxyServer {
    pub fn new(
        ca: CertificateAuthority,
        plugin_registry: Option<Arc<PluginRegistry>>,
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
            management_addr: Arc::new(OnceLock::new()),
        })
    }

    /// Returns the actual bound listen address, if the server has been started
    pub fn listen_addr(&self) -> Option<SocketAddr> {
        self.listen_addr
    }

    /// Tell the proxy where its own management web server is listening.
    /// Connections to that port are then routed directly to loopback
    /// instead of being treated as ordinary upstream traffic — without
    /// this, opening the management UI through the system proxy loops
    /// (or fails) because the proxy has no idea the destination is itself.
    pub fn set_management_addr(&self, addr: SocketAddr) {
        let _ = self.management_addr.set(addr);
    }

    /// If `authority` targets our own management server's port, return the
    /// loopback host:port that should be used as the actual upstream.
    fn rewrite_management_authority(&self, authority: &str) -> Option<String> {
        let mgmt = self.management_addr.get()?;
        let (_, port) = parse_authority_host_port(authority, 0).ok()?;
        if port == mgmt.port() {
            Some(format!("127.0.0.1:{}", mgmt.port()))
        } else {
            None
        }
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

        // Spawn the timer scheduler (checks every 30 seconds for timer-capable plugins)
        if let Some(ref registry) = self.plugin_registry {
            let timer_registry = Arc::clone(registry);
            let timer_shutdown = self.shutdown_notify.clone();
            tokio::spawn(async move {
                use crate::events::timer::TimerEvent;
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
                loop {
                    tokio::select! {
                        _ = timer_shutdown.notified() => break,
                        _ = interval.tick() => {
                            let timer_event = TimerEvent::now();
                            let registry = &timer_registry;
                            if registry.can_handle(&timer_event) {
                                debug!("Timer tick: dispatching timer event to plugins");
                                if let Err(e) = registry.handle_event(Box::new(timer_event)).await {
                                    warn!("Timer event handling error: {}", e);
                                }
                            }
                        }
                    }
                }
            });
        }

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
                                // Resolve tenant from peer address (anonymous for now,
                                // will be replaced by TenantResolver in Phase 4)
                                let tenant_ctx = TenantContext::anonymous();
                                tokio::spawn(async move {
                                    let svc = service_fn(move |req: Request<Incoming>| {
                                        let shared = shared.clone();
                                        let tenant_ctx = tenant_ctx.clone();
                                        async move {
                                            shared.handle_plain_http(req, &tenant_ctx).await.map_err(|e| std::io::Error::other(e.to_string()))
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
    pub async fn join(&self) {
        self.shutdown_notify.notified().await;
    }

    /// Signal the server to shutdown.
    pub async fn shutdown(&self) {
        self.shutdown_notify.notify_waiters();
    }

    /// Determine whether any plugins want to handle this connection
    /// Returns true if MITM should be performed, false if connection should be forwarded transparently
    #[tracing::instrument(skip(self), fields(authority = %authority))]
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
        let has_matching_plugin = plugin_registry.can_handle(&*connect_event);

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
        _tenant_ctx: &TenantContext,
    ) -> Result<Response<UnsyncBoxBody<Bytes, ErrorCode>>, ProxyError> {
        if req.method() == Method::CONNECT {
            debug!("Handling CONNECT request");

            // Host:port lives in the request-target for CONNECT (authority-form)
            let mut authority = req
                .uri()
                .authority()
                .map(|a| a.as_str().to_string())
                .unwrap_or_default();
            debug!("CONNECT request authority: {}", authority);
            if authority.is_empty() {
                return Ok::<_, ProxyError>(plain_response(
                    StatusCode::BAD_REQUEST,
                    "CONNECT missing authority",
                ));
            }

            // If this CONNECT is targeting our own management server (matched
            // by port), rewrite the upstream authority to loopback so the
            // tunnel terminates locally instead of looping back through the
            // system proxy or hitting an unreachable public hostname.
            let mut is_management_loopback = false;
            if let Some(loopback) = self.rewrite_management_authority(&authority) {
                debug!(
                    "CONNECT authority {} matches management port; rewriting to {}",
                    authority, loopback
                );
                authority = loopback;
                is_management_loopback = true;
            }

            // Check if any plugins want to handle this connection. Skip the
            // plugin path entirely for management-loopback so the UI bytes
            // aren't fed through MITM.
            let should_mitm = if is_management_loopback {
                false
            } else {
                self.handle_connect(&authority).await
            };

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
                                TokioIo::new(upgraded),
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
                                        debug!("Transparent tunnel closed")
                                    }
                                    _ => warn!(
                                        "Transparent forwarding error for upstream {}: {}",
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
            return Ok(plain_response(StatusCode::OK, Bytes::new()));
        }

        // ----- Plain HTTP proxying (request line is absolute-form from clients) -----
        debug!(
            "Handling plain HTTP request: {} {}",
            req.method(),
            req.uri()
        );
        strip_proxy_headers(req.headers_mut());
        // TODO: plugin: on_request(&mut req, &conn).await;

        // Short-circuit plain HTTP requests that target our own management
        // server's port: rewrite the URI's authority to 127.0.0.1 so the
        // upstream client talks to ourselves instead of trying to resolve
        // the public hostname.
        if let Some(authority) = req.uri().authority().map(|a| a.as_str().to_string())
            && let Some(loopback) = self.rewrite_management_authority(&authority)
        {
            let path_and_query = req
                .uri()
                .path_and_query()
                .map(|p| p.as_str().to_string())
                .unwrap_or_else(|| "/".to_string());
            let scheme = req.uri().scheme_str().unwrap_or("http").to_string();
            if let Ok(new_uri) = hyper::Uri::builder()
                .scheme(scheme.as_str())
                .authority(loopback.as_str())
                .path_and_query(path_and_query.as_str())
                .build()
            {
                debug!(
                    "Rewriting plain HTTP authority {} -> {} (management loopback)",
                    authority, loopback
                );
                *req.uri_mut() = new_uri;
            }
        }

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
) -> Response<UnsyncBoxBody<Bytes, ErrorCode>> {
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
                    plain_response(
                        StatusCode::BAD_GATEWAY,
                        "Failed to convert upstream response",
                    )
                }
            }
        }
        Err(err) => {
            error!("Upstream request failed with detailed error: {:?}", err);
            plain_response(StatusCode::BAD_GATEWAY, err.to_string())
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

/// Performs TLS MITM on a connection, then serves the *client-facing* side
/// with a Hyper auto server (h1 or h2) and forwards each request to the real upstream via `upstream`.
///
/// Generic over the IO type so it can be used from both the standard proxy
/// (with `TokioIo<Upgraded>`) and the transparent proxy (with `TcpStream`).
#[tracing::instrument(skip(upstream, stream, ca, plugin_registry), fields(authority = %authority))]
pub(crate) async fn run_tls_mitm<IO>(
    upstream: reqwest::Client,
    stream: IO,
    authority: String,
    ca: Arc<CertificateAuthority>,
    plugin_registry: Option<Arc<PluginRegistry>>,
) -> ProxyResult<()>
where
    IO: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    debug!("Running TLS interception for {}", authority);

    // Extract host + port, default :443
    let (host, _port) = parse_authority_host_port(&authority, 443)?;

    // --- Build a server TLS config for the client side (fake cert for `host`) ---
    let server_tls = build_server_tls_for_host(&ca, &host).await?;
    let acceptor = TlsAcceptor::from(Arc::new(server_tls));

    let tls = acceptor.accept(stream).await?;
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
                let service_fn_start = std::time::Instant::now();
                let method = req.method().clone();
                let uri = req.uri().clone();
                let req = fix_origin_form_request(req);
                debug!("Handling TLS request: {} {}", method, uri);
                debug!("🕐 SERVICE_FN START: {} {}", method, uri);
                let mut request_ctx = CelRequest::from(&req);

                let request_event_result = if let Some(registry) = &plugin_registry {
                    let (request, _io) = WasiRequest::from_http(
                        wasmtime_wasi_http::default_hooks(),
                        req,
                    );
                    let event: Box<dyn Event> = Box::new(request);

                    registry.handle_event(event).await
                } else {
                    let request_result = convert_hyper_incoming_to_reqwest_request(req, &upstream);
                    match request_result {
                        // Annotating the error type here pins the whole service
                        // closure's return type to `hyper::http::Error` now that the
                        // other arms build responses via `plain_response`.
                        Ok(rq) => {
                            return Ok::<_, hyper::http::Error>(
                                perform_upstream(&upstream, rq).await,
                            );
                        }
                        Err(err) => {
                            return Ok(plain_response(
                                StatusCode::BAD_REQUEST,
                                format!("Failed to convert request: {}", err),
                            ));
                        }
                    }
                };

                let request_event_elapsed = service_fn_start.elapsed();
                debug!(
                    "🕐 REQUEST_EVENT handled in {:?}, checking result and performing upstream call if needed",
                    request_event_elapsed
                );

                let upstream_start = std::time::Instant::now();
                let initial_response = match request_event_result {
                    Err(e) => plain_response(
                        StatusCode::BAD_GATEWAY,
                        format!("Plugin event handling error: {}", e),
                    ),
                    Ok((event_data, mut store)) => match event_data {
                        WasmEvent::Request(rq) => {
                            let rq = match store.data_mut().http().table.delete(rq) {
                                Ok(rq) => rq,
                                Err(e) => {
                                    error!("Failed to take request from plugin table: {}", e);
                                    return Ok(plain_response(
                                        StatusCode::INTERNAL_SERVER_ERROR,
                                        "Failed to process plugin request",
                                    ));
                                }
                            };
                            request_ctx = CelRequest::from(&rq);
                            let (rq, _io) = match rq.into_http(store, async { Ok(()) }) {
                                Ok(v) => v,
                                Err(e) => {
                                    error!("Failed to convert plugin request to http: {}", e);
                                    return Ok(plain_response(
                                        StatusCode::INTERNAL_SERVER_ERROR,
                                        "Failed to process plugin request",
                                    ));
                                }
                            };

                            let rq = rq.map(|b| b.map_err(wasi_error_to_code).boxed_unsync());
                            let rq: Result<reqwest::Request, ProxyError> =
                                convert_hyper_boxed_body_to_reqwest_request(rq, &upstream);
                            match rq {
                                Ok(rq) => perform_upstream(&upstream, rq).await,
                                Err(err) => plain_response(
                                    StatusCode::BAD_REQUEST,
                                    format!("Failed to convert request: {}", err),
                                ),
                            }
                        }
                        WasmEvent::Response(WasiContextualResponse { response, .. }) => {
                            let response = match store.data_mut().http().table.delete(response) {
                                Ok(r) => r,
                                Err(e) => {
                                    error!("Failed to take response from plugin table: {}", e);
                                    return Ok(plain_response(
                                        StatusCode::INTERNAL_SERVER_ERROR,
                                        "Failed to process plugin response",
                                    ));
                                }
                            };
                            match response.into_http(store, async { Ok(()) }) {
                                Ok(response) => {
                                    response.map(|b| b.map_err(wasi_error_to_code).boxed_unsync())
                                }
                                Err(e) => {
                                    error!("Failed to convert plugin response to http: {}", e);
                                    return Ok(plain_response(
                                        StatusCode::INTERNAL_SERVER_ERROR,
                                        "Failed to process plugin response",
                                    ));
                                }
                            }
                        }
                        _ => plain_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "Unexpected event data type from plugin",
                        ),
                    },
                };

                let upstream_elapsed = upstream_start.elapsed();
                debug!(
                    "🕐 INITIAL_RESPONSE obtained in {:?}, proceeding to response event handling",
                    upstream_elapsed
                );

                let response_event_start = std::time::Instant::now();
                let handled_response = if let Some(registry) = &plugin_registry {
                    let (response, _io) = WasiResponse::from_http(
                        wasmtime_wasi_http::default_hooks(),
                        initial_response,
                    );
                    let contextual_response = ContextualResponse {
                        request: request_ctx.into(),
                        response,
                    };
                    registry.handle_event(Box::new(contextual_response)).await
                } else {
                    // No plugin registry, just return the initial response
                    return Ok(initial_response);
                };

                let response_event_elapsed = response_event_start.elapsed();
                debug!(
                    "🕐 RESPONSE_EVENT handled in {:?}, checking for specific content-type handling",
                    response_event_elapsed
                );

                // Check response content-type for content-specific handling
                let (content, plugin_store) = if let Some(registry) = &plugin_registry {
                    let (response, mut store) = match handled_response {
                        Ok((event_data, store)) => match event_data {
                            WasmEvent::Response(WasiContextualResponse { response, .. }) => {
                                (response, store)
                            }
                            _ => {
                                return Ok(plain_response(
                                    StatusCode::INTERNAL_SERVER_ERROR,
                                    "Unexpected event data type from plugin",
                                ));
                            }
                        },
                        Err(e) => {
                            error!("Response event handling error: {}", e);
                            return Ok(plain_response(
                                StatusCode::BAD_GATEWAY,
                                format!("Plugin response event handling error: {}", e),
                            ));
                        }
                    };
                    let response = match store.data_mut().http().table.delete(response) {
                        Ok(r) => r,
                        Err(e) => {
                            error!("Failed to take response from plugin table: {}", e);
                            return Ok(plain_response(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                "Failed to process plugin response",
                            ));
                        }
                    };
                    let content_type = response.content_type();

                    // Check if this response should have content that plugins should process
                    // Only process 2xx success responses (except 204 No Content)
                    // Skip: 1xx informational, 204 No Content, 3xx redirects, 4xx client errors, 5xx server errors
                    let should_process_content = matches!(
                        response.status.as_u16(),
                        // Only 2xx success responses (except 204 No Content)
                        200..=203 | 205..=299
                    );

                    debug!("Content type for InboundContent: {}", content_type);
                    let response = match response.into_http(&mut store, async { Ok(()) }) {
                        Ok(r) => r,
                        Err(e) => {
                            error!("Failed to convert plugin response to http: {}", e);
                            return Ok(plain_response(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                "Failed to process plugin response",
                            ));
                        }
                    };
                    let (parts, body) = response.into_parts();
                    let body = body.map_err(wasi_error_to_code).boxed_unsync();
                    let content = match InboundContent::new(parts, content_type.clone(), body) {
                        Ok(c) => c,
                        Err(e) => {
                            error!("Failed to build inbound content: {}", e);
                            return Ok(plain_response(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                "Failed to process response content",
                            ));
                        }
                    };
                    // Skip content event processing if:
                    // 1. The body was passed through untouched because its
                    //    Content-Encoding is unsupported (forward it unmodified
                    //    rather than tearing down the connection).
                    // 2. Content-type is unknown (no Content-Type header).
                    // 3. Response status indicates content should not be processed by
                    //    plugins (only 2xx success responses, excluding 204 No Content).
                    if content.is_passthrough()
                        || content_type.eq("unknown")
                        || !should_process_content
                    {
                        debug!(
                            "Skipping InboundContent event processing (passthrough={}, content_type={}, should_process_content={})",
                            content.is_passthrough(),
                            content_type,
                            should_process_content
                        );
                        (content, None)
                    } else {
                        let content = Box::new(content) as Box<dyn Event>;
                        debug!(
                            "Created InboundContent event with content-type: {}",
                            content_type
                        );
                        let start_handle = std::time::Instant::now();
                        let (event, mut store) = match registry.handle_event(content).await {
                            Ok(v) => v,
                            Err(e) => {
                                error!("InboundContent event handling error: {}", e);
                                return Ok(plain_response(
                                    StatusCode::BAD_GATEWAY,
                                    format!("Plugin content event handling error: {}", e),
                                ));
                            }
                        };
                        debug!(
                            "InboundContent event handled in {:?}",
                            start_handle.elapsed()
                        );

                        match event {
                            WasmEvent::InboundContent(content_resource) => {
                                let content = match store.data_mut().table.delete(content_resource)
                                {
                                    Ok(c) => c,
                                    Err(e) => {
                                        error!("Failed to take content from plugin table: {}", e);
                                        return Ok(plain_response(
                                            StatusCode::INTERNAL_SERVER_ERROR,
                                            "Failed to process response content",
                                        ));
                                    }
                                };
                                (content, Some(store))
                            }
                            _ => {
                                return Ok(plain_response(
                                    StatusCode::INTERNAL_SERVER_ERROR,
                                    "Unexpected event data type from plugin",
                                ));
                            }
                        }
                    }
                } else {
                    unreachable!()
                };

                let content_handling_elapsed = service_fn_start.elapsed()
                    - request_event_elapsed
                    - upstream_elapsed
                    - response_event_elapsed;
                debug!(
                    "🕐 CONTENT_HANDLING completed in {:?}",
                    content_handling_elapsed
                );
                debug!("Converting final InboundContent to HTTP response");

                match content.into_response() {
                    Ok(response) => {
                        // If plugins processed content, their WASM subtasks may still
                        // be streaming body data. Keep the store alive in a background
                        // run_concurrent context so subtasks can make progress until
                        // the response body is fully consumed.
                        if let Some(mut store) = plugin_store {
                            let (body_done_tx, body_done_rx) =
                                tokio::sync::oneshot::channel::<()>();
                            let (parts, body) = response.into_parts();
                            let wrapped_body =
                                crate::proxy::utils::BodyWithSignal::new(body, body_done_tx);
                            let response = Response::from_parts(parts, wrapped_body.boxed_unsync());
                            tokio::spawn(async move {
                                let _ = store
                                    .run_concurrent(async move |_| {
                                        let _ = body_done_rx.await;
                                    })
                                    .await;
                            });
                            Ok(response)
                        } else {
                            Ok(response)
                        }
                    }
                    Err(err) => {
                        error!("Error getting streaming response: {}", err);
                        Ok(plain_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("Failed to get streaming response: {}", err),
                        ))
                    }
                }
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
