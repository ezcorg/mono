use crate::cert::CertificateAuthority;
use crate::config::AppConfig;
use crate::plugins::registry::PluginRegistry;

use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::upgrade;
use hyper::{Method, Request, Response, StatusCode};
use std::{net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;
use tokio::sync::{Notify, RwLock};
use tokio_rustls::TlsAcceptor;
use tracing::{debug, error, info, warn};

use hyper_util::server::conn::auto::Builder as AutoServer;
use hyper_util::{rt::TokioExecutor, rt::TokioIo};

mod utils;
pub use utils::{
    build_server_tls_for_host, client, convert_hyper_to_reqwest_request,
    convert_reqwest_to_hyper_response, is_closed, parse_authority_host_port, strip_proxy_headers,
    ProxyError, ProxyResult, UpstreamClient,
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
                    _ = shutdown.notified() => {
                        info!("Shutdown signal received, stopping accept loop");
                        break;
                    }
                    accept_result = listener.accept() => {
                        match accept_result {
                            Ok((io, peer)) => {
                                debug!("Accepted connection from {}", peer);
                                let shared = server.clone();
                                tokio::spawn(async move {
                                    let svc = service_fn(move |req: Request<hyper::body::Incoming>| {
                                        let shared = shared.clone();
                                        async move {
                                            shared.handle_plain_http(req).await.map_err(|e| {
                                                error!("Service error: {}", e);
                                                std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
                                            })
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

    /// Handles requests received on the cleartext proxy port.
    /// - Normal HTTP requests are proxied with the upstream client.
    /// - CONNECT is acknowledged, then we hijack/upgrade and run TLS MITM with an auto (h1/h2) server.
    async fn handle_plain_http(
        &self,
        mut req: Request<Incoming>,
    ) -> Result<Response<Full<Bytes>>, ProxyError> {
        if req.method() == Method::CONNECT {
            info!("Handling CONNECT request");

            // Host:port lives in the request-target for CONNECT (authority-form)
            let authority = req
                .uri()
                .authority()
                .map(|a| a.as_str().to_string())
                .unwrap_or_default();
            info!("CONNECT request authority: {}", authority);
            if authority.is_empty() {
                let resp = Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(Full::new(Bytes::from("CONNECT missing authority")))?;
                return Ok::<_, ProxyError>(resp);
            }

            let ca = self.ca.clone();
            let config = self.config.clone();
            let on_upgrade = upgrade::on(&mut req);
            let upstream = self.upstream.clone();

            tokio::spawn(async move {
                match on_upgrade.await {
                    Ok(upgraded) => {
                        if let Err(e) =
                            run_tls_mitm(upstream, upgraded, authority, ca, config).await
                        {
                            match &e {
                                ProxyError::Io(ioe) if is_closed(ioe) => {
                                    debug!("tls tunnel closed")
                                }
                                _ => warn!("tls mitm error: {}", e),
                            }
                        }
                    }
                    Err(e) => warn!("upgrade error (CONNECT): {}", e),
                }
            });

            // Return 200 Connection Established for CONNECT
            return Ok(Response::builder()
                .status(StatusCode::OK)
                .body(Full::new(Bytes::new()))?);
        }

        // ----- Plain HTTP proxying (request line is absolute-form from clients) -----
        info!(
            "Handling plain HTTP request: {} {}",
            req.method(),
            req.uri()
        );
        strip_proxy_headers(req.headers_mut());
        // TODO: plugin: on_request(&mut req, &conn).await;

        // Convert hyper request to reqwest request
        let reqwest_req = convert_hyper_to_reqwest_request(req, &self.upstream).await?;
        let resp = self.upstream.execute(reqwest_req).await?;

        // Convert reqwest response back to hyper response
        let mut response = convert_reqwest_to_hyper_response(resp).await?;

        // Strip hop-by-hop headers from the response
        strip_proxy_headers(response.headers_mut());

        Ok(response)
    }
}

/// Performs TLS MITM on a CONNECT tunnel, then serves the *client-facing* side
/// with a Hyper auto server (h1 or h2) and forwards each request to the real upstream via `upstream`.
async fn run_tls_mitm(
    upstream: reqwest::Client,
    upgraded: upgrade::Upgraded,
    authority: String,
    ca: Arc<CertificateAuthority>,
    _config: Arc<AppConfig>,
) -> ProxyResult<()> {
    info!("Running TLS MITM for {}", authority);

    // Extract host + port, default :443
    let (host, _port) = parse_authority_host_port(&authority, 443)?;

    // --- Build a server TLS config for the client side (fake cert for `host`) ---
    let server_tls = build_server_tls_for_host(&*ca, &host).await?;
    let acceptor = TlsAcceptor::from(Arc::new(server_tls));

    let tls = acceptor.accept(TokioIo::new(upgraded)).await?;
    info!("TLS established with client for {}", host);

    // Auto (h1/h2) Hyper server over the client TLS stream
    let executor = TokioExecutor::new();
    let auto: AutoServer<TokioExecutor> = AutoServer::new(executor);

    // Service that proxies each decrypted request to the real upstream host
    let svc = {
        let upstream = upstream.clone();

        service_fn(move |req: Request<Incoming>| {
            let upstream = upstream.clone();

            async move {
                info!("Handling TLS request: {} {}", req.method(), req.uri());

                // Forward upstream
                match convert_hyper_to_reqwest_request(req, &upstream).await {
                    Ok(reqwest_req) => match upstream.execute(reqwest_req).await {
                        Ok(resp) => {
                            info!("Upstream response status: {}", resp.status());
                            match convert_reqwest_to_hyper_response(resp).await {
                                Ok(mut response) => {
                                    strip_proxy_headers(response.headers_mut());
                                    Ok::<Response<Full<Bytes>>, hyper::http::Error>(response)
                                }
                                Err(err) => {
                                    error!("Failed to convert response: {}", err);
                                    let resp = Response::builder()
                                        .status(StatusCode::BAD_GATEWAY)
                                        .body(Full::new(Bytes::from(
                                            "Failed to convert upstream response",
                                        )))
                                        .unwrap();
                                    Ok(resp)
                                }
                            }
                        }
                        Err(err) => {
                            error!("Upstream request failed with detailed error: {:?}", err);
                            let resp = Response::builder()
                                .status(StatusCode::BAD_GATEWAY)
                                .body(Full::new(Bytes::from(err.to_string())))
                                .unwrap();
                            Ok(resp)
                        }
                    },
                    Err(err) => {
                        error!("Failed to convert request: {}", err);
                        let resp = Response::builder()
                            .status(StatusCode::BAD_GATEWAY)
                            .body(Full::new(Bytes::from("Failed to convert request")))
                            .unwrap();
                        Ok(resp)
                    }
                }
            }
        })
    };

    // Serve the single TLS connection
    if let Err(e) = auto.serve_connection(TokioIo::new(tls), svc).await {
        if !is_closed(&e) {
            warn!("TLS connection error: {}", e);
        }
    }

    Ok(())
}
