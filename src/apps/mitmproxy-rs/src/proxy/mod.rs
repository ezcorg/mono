use crate::cert::CertificateAuthority;
use crate::config::Config;

use bytes::Bytes;
use futures::TryStreamExt;
use http_body_util::{BodyExt, Full};
use hyper::body::{Body, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::upgrade;
use hyper::{header, Method, Request, Response, StatusCode};
use std::{net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;
use tokio_rustls::{rustls, TlsAcceptor};
use tracing::{debug, error, info, warn};

use hyper_util::server::conn::auto::Builder as AutoServer;
use hyper_util::{rt::TokioExecutor, rt::TokioIo};
use reqwest::{self};

/// Custom error type for proxy operations
#[derive(Debug)]
pub enum ProxyError {
    /// IO-related errors
    Io(std::io::Error),
    /// TLS/rustls-related errors
    Tls(rustls::Error),
    /// HTTP/Hyper-related errors
    Http(hyper::Error),
    /// Certificate authority errors
    Cert(Box<dyn std::error::Error + Send + Sync>),
    /// Generic errors with a message
    Generic(String),
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProxyError::Io(e) => write!(f, "IO error: {}", e),
            ProxyError::Tls(e) => write!(f, "TLS error: {}", e),
            ProxyError::Http(e) => write!(f, "HTTP error: {}", e),
            ProxyError::Cert(e) => write!(f, "Certificate error: {}", e),
            ProxyError::Generic(msg) => write!(f, "Proxy error: {}", msg),
        }
    }
}

impl std::error::Error for ProxyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ProxyError::Io(e) => Some(e),
            ProxyError::Tls(e) => Some(e),
            ProxyError::Http(e) => Some(e),
            ProxyError::Cert(e) => Some(e.as_ref()),
            ProxyError::Generic(_) => None,
        }
    }
}

impl From<std::io::Error> for ProxyError {
    fn from(err: std::io::Error) -> Self {
        ProxyError::Io(err)
    }
}

impl From<rustls::Error> for ProxyError {
    fn from(err: rustls::Error) -> Self {
        ProxyError::Tls(err)
    }
}

impl From<hyper::Error> for ProxyError {
    fn from(err: hyper::Error) -> Self {
        ProxyError::Http(err)
    }
}

impl From<hyper::http::Error> for ProxyError {
    fn from(err: hyper::http::Error) -> Self {
        ProxyError::Generic(format!("HTTP error: {}", err))
    }
}

impl From<reqwest::Error> for ProxyError {
    fn from(err: reqwest::Error) -> Self {
        ProxyError::Generic(format!("Reqwest error: {}", err))
    }
}

#[derive(Debug, Clone)]
pub struct ProxyServer {
    listen_addr: SocketAddr,
    ca: Arc<CertificateAuthority>,
    config: Arc<Config>,
    upstream: UpstreamClient,
}

type UpstreamClient = reqwest::Client;
pub type ProxyResult<T> = Result<T, ProxyError>;

impl ProxyServer {
    pub fn new(
        listen_addr: SocketAddr,
        ca: CertificateAuthority,
        config: Config,
    ) -> ProxyResult<Self> {
        // reqwest client that supports HTTP/1.1 and HTTP/2 (ALPN) to upstream servers
        let upstream = client()?;

        Ok(Self {
            listen_addr,
            ca: Arc::new(ca),
            config: Arc::new(config),
            upstream,
        })
    }

    pub async fn start(&self) -> ProxyResult<()> {
        let listener = TcpListener::bind(self.listen_addr).await?;
        info!("Proxy listening on {}", self.listen_addr);

        let shared = self.clone();

        loop {
            let (io, _peer) = listener.accept().await?;
            let shared = shared.clone();

            tokio::spawn(async move {
                let svc = service_fn(move |req| {
                    let shared = shared.clone();
                    async move {
                        shared.handle_plain_http(req).await.map_err(|e| {
                            error!("Service error: {}", e);
                            // Convert to hyper::Error - this is a bit hacky but necessary
                            // since we can't directly convert ProxyError to hyper::Error
                            std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
                        })
                    }
                });

                // Cleartext side: serve HTTP/1.1 (supports CONNECT+upgrade)
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
            let cfg = self.config.clone();
            let on_upgrade = upgrade::on(&mut req);
            let upstream = self.upstream.clone();

            tokio::spawn(async move {
                match on_upgrade.await {
                    Ok(upgraded) => {
                        if let Err(e) = run_tls_mitm(upstream, upgraded, authority, ca, cfg).await {
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

fn wrap_body(incoming: Incoming) -> reqwest::Body {
    let stream = incoming.into_data_stream().map_err(|e| {
        let err: Box<dyn std::error::Error + Send + Sync> = Box::new(e);
        err
    });
    reqwest::Body::wrap_stream(stream)
}

/// Convert a hyper Request to a reqwest Request
async fn convert_hyper_to_reqwest_request(
    hyper_req: Request<Incoming>,
    client: &reqwest::Client,
) -> ProxyResult<reqwest::Request> {
    let (parts, body) = hyper_req.into_parts();
    // let body_bytes = body.collect().await?.to_bytes();

    let method = match parts.method {
        Method::GET => reqwest::Method::GET,
        Method::POST => reqwest::Method::POST,
        Method::PUT => reqwest::Method::PUT,
        Method::DELETE => reqwest::Method::DELETE,
        Method::HEAD => reqwest::Method::HEAD,
        Method::OPTIONS => reqwest::Method::OPTIONS,
        Method::PATCH => reqwest::Method::PATCH,
        Method::TRACE => reqwest::Method::TRACE,
        _ => {
            return Err(ProxyError::Generic(format!(
                "Unsupported method: {}",
                parts.method
            )))
        }
    };

    // Build the URL properly - for TLS MITM, we need to construct the full URL
    let url = if parts.uri.scheme().is_some() {
        // Already has scheme (absolute URI)
        parts.uri.to_string()
    } else {
        // Origin form - need to construct full URL from Host header
        let host = parts
            .headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .ok_or_else(|| ProxyError::Generic("Missing Host header".to_string()))?;

        let scheme = "https"; // Assume HTTPS for TLS MITM
        let path = parts
            .uri
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/");

        format!("{}://{}{}", scheme, host, path)
    };

    let mut req_builder = client.request(method, &url);

    // Copy headers, but skip Host header as reqwest will set it from the URL
    for (name, value) in parts.headers.iter() {
        if name != header::HOST {
            if let Ok(value_str) = value.to_str() {
                req_builder = req_builder.header(name.as_str(), value_str);
            }
        }
    }

    // Add body if present
    if !body.is_end_stream() {
        req_builder = req_builder.body(wrap_body(body));
    }

    req_builder
        .build()
        .map_err(|e| ProxyError::Generic(format!("Failed to build reqwest request: {}", e)))
}

/// Convert a reqwest Response to a hyper Response
async fn convert_reqwest_to_hyper_response(
    reqwest_resp: reqwest::Response,
) -> ProxyResult<Response<Full<Bytes>>> {
    let status = reqwest_resp.status();
    let headers = reqwest_resp.headers().clone();
    let body_bytes = reqwest_resp.bytes().await?;

    let mut response = Response::builder().status(status);

    // Copy headers
    for (name, value) in headers.iter() {
        response = response.header(name, value);
    }

    response
        .body(Full::new(body_bytes))
        .map_err(|e| ProxyError::Generic(format!("Failed to build hyper response: {}", e)))
}

fn client() -> ProxyResult<UpstreamClient> {
    let client = reqwest::Client::builder()
        .pool_idle_timeout(std::time::Duration::from_secs(10))
        .pool_max_idle_per_host(1)
        .http1_title_case_headers()
        .build()
        .map_err(|e| ProxyError::Generic(format!("Failed to build reqwest client: {}", e)))?;
    Ok(client)
}

/// Performs TLS MITM on a CONNECT tunnel, then serves the *client-facing* side
/// with a Hyper auto server (h1 or h2) and forwards each request to the real upstream via `upstream`.
async fn run_tls_mitm(
    upstream: reqwest::Client,
    upgraded: upgrade::Upgraded,
    authority: String,
    ca: Arc<CertificateAuthority>,
    _config: Arc<Config>,
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

fn strip_proxy_headers(h: &mut hyper::HeaderMap) {
    // hop-by-hop headers (RFC 7230 6.1)
    const HOPS: &[&str] = &[
        "connection",
        "proxy-connection",
        "keep-alive",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ];
    for k in HOPS {
        h.remove(*k);
    }
}

fn parse_authority_host_port(authority: &str, default_port: u16) -> ProxyResult<(String, u16)> {
    match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            Ok((h.to_string(), p.parse().unwrap_or(default_port)))
        }
        _ => Ok((authority.to_string(), default_port)),
    }
}

async fn build_server_tls_for_host(
    ca: &CertificateAuthority,
    host: &str,
) -> ProxyResult<rustls::ServerConfig> {
    // Use your CA to mint a leaf cert for `host`
    let cert = ca
        .get_certificate_for_domain(host)
        .await
        .map_err(|e| ProxyError::Cert(e.into()))?;
    // Minimal rustls server config
    let mut cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert.cert_der], cert.key_der)
        .map_err(|e| ProxyError::Tls(rustls::Error::General(e.to_string())))?;
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(cfg)
}

fn is_closed<E: std::fmt::Display>(e: &E) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains("broken pipe")
        || s.contains("connection reset")
        || s.contains("connection aborted")
        || s.contains("unexpected eof")
        || s.contains("close_notify")
}
