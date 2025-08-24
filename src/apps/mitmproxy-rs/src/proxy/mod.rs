use crate::cert::CertificateAuthority;
use crate::config::Config;

use std::{convert::Infallible, net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;
use tokio_rustls::{rustls, TlsAcceptor};
use tracing::{debug, error, info, warn};

use http_body_util::Full;
use hyper::body::Body;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::upgrade;
use hyper::{header, Method, Request, Response, StatusCode, Uri};

use hyper_rustls::HttpsConnector;
use hyper_rustls::HttpsConnectorBuilder;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::server::conn::auto::Builder as AutoServer;
use hyper_util::{rt::TokioExecutor, rt::TokioIo};

#[derive(Debug, Clone)]
pub struct ProxyServer {
    listen_addr: SocketAddr,
    ca: Arc<CertificateAuthority>,
    config: Arc<Config>,
    upstream: UpstreamClient,
}

type ReqBody = Full<bytes::Bytes>;
type UpstreamClient = Client<HttpsConnector<HttpConnector>, ReqBody>;
pub type ProxyResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

impl ProxyServer {
    pub async fn new(
        listen_addr: SocketAddr,
        ca: CertificateAuthority,
        config: Config,
    ) -> ProxyResult<Self> {
        // Hyper client that supports HTTP/1.1 and HTTP/2 (ALPN) to upstream servers
        let https = HttpsConnectorBuilder::new()
            .with_native_roots()?
            .https_or_http()
            .enable_http1()
            .enable_http2()
            .build();
        let upstream = hyper_util::client::legacy::Client::builder(TokioExecutor::new())
            .http2_adaptive_window(true)
            .build(https);

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
            let (io, peer) = listener.accept().await?;
            let shared = shared.clone();

            tokio::spawn(async move {
                let svc = service_fn(move |req| {
                    let shared = shared.clone();
                    async move { shared.handle_plain_http(req).await }
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
        mut req: Request<ReqBody>,
    ) -> Result<Response<ReqBody>, Infallible> {
        if req.method() == Method::CONNECT {
            // Host:port lives in the request-target for CONNECT (authority-form)
            let authority = req
                .uri()
                .authority()
                .map(|a| a.as_str().to_string())
                .unwrap_or_default();
            if authority.is_empty() {
                return Ok(resp(StatusCode::BAD_REQUEST, "CONNECT missing authority"));
            }

            // Send 200, then hijack the TCP stream and do TLS MITM
            let mut resp = Response::new(ReqBody::new(bytes::Bytes::new()));
            *resp.status_mut() = StatusCode::OK;

            let ca = self.ca.clone();
            let cfg = self.config.clone();
            let up = self.upstream.clone();

            tokio::spawn(async move {
                match upgrade::on(&mut req).await {
                    Ok(upgraded) => {
                        if let Err(e) = run_tls_mitm(upgraded, authority, ca, cfg, up).await {
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

            return Ok(resp);
        }

        // ----- Plain HTTP proxying (request line is absolute-form from clients) -----
        // Convert absolute-form URI to origin-form for upstream.
        // Also ensure Host header is correct and strip proxy-only headers.
        if let Some((scheme, authority, path_and_query)) = split_absolute_uri(req.uri()) {
            // Set authority as Host header (if not present)
            if !req.headers().contains_key(header::HOST) {
                req.headers_mut()
                    .insert(header::HOST, authority.parse().unwrap());
            }
            // Build origin-form URI for upstream request
            let new_uri = Uri::builder()
                .path_and_query(path_and_query)
                .build()
                .unwrap();
            *req.uri_mut() = new_uri;

            // Strip hop-by-hop / proxy headers
            strip_proxy_headers(req.headers_mut());
            // TODO: plugin: on_request(&mut req, &conn).await;

            // Forward using the shared HTTPS client (supports http/1.1 & http/2 upstream)
            match self.upstream.request(req).await {
                Ok(mut resp) => {
                    // TODO: plugin: on_response(&mut resp, &conn).await;
                    Ok(resp)
                }
                Err(err) => {
                    warn!("upstream error: {}", err);
                    Ok(resp(StatusCode::BAD_GATEWAY, "Upstream error"))
                }
            }
        } else {
            // Not absolute-form; some clients still send origin-form even to HTTP proxies.
            // Best effort: just pass it upstream (requires Host header).
            strip_proxy_headers(req.headers_mut());
            match self.upstream.request(req).await {
                Ok(resp) => Ok(resp),
                Err(err) => {
                    warn!("upstream error: {}", err);
                    Ok(resp(StatusCode::BAD_GATEWAY, "Upstream error"))
                }
            }
        }
    }
}

/// Performs TLS MITM on a CONNECT tunnel, then serves the *client-facing* side
/// with a Hyper auto server (h1 or h2) and forwards each request to the real upstream via `upstream`.
async fn run_tls_mitm(
    upgraded: upgrade::Upgraded,
    authority: String,
    ca: Arc<CertificateAuthority>,
    _config: Arc<Config>,
    upstream: UpstreamClient,
) -> ProxyResult<()> {
    // Extract host + port, default :443
    let (host, _port) = parse_authority_host_port(&authority, 443)?;

    // --- Build a server TLS config for the client side (fake cert for `host`) ---
    let server_tls = build_server_tls_for_host(&*ca, &host).await?;
    let acceptor = TlsAcceptor::from(Arc::new(server_tls));

    let tls = acceptor.accept(TokioIo::new(upgraded)).await?;
    debug!("TLS established with client for {}", host);

    // Auto (h1/h2) Hyper server over the client TLS stream.
    let executor = TokioExecutor::new();
    let mut auto = AutoServer::new(executor);

    // Service that proxies each decrypted request to the real upstream host.
    let svc = service_fn(move |mut req: Request<Body>| {
        let upstream = upstream.clone();
        let host = host.clone();
        let mut inner_conn = conn.clone();

        async move {
            // Rebuild absolute info if client sends origin-form (expected inside TLS).
            ensure_authority_and_scheme(&host, &mut req);

            // Strip hop-by-hop/proxy headers *from the client*
            strip_proxy_headers(req.headers_mut());

            // TODO: plugin: on_tls_request(&mut req, &inner_conn).await;

            // Now rewrite URI to origin-form for upstream, using the path+query only.
            if let Some((_sch, _auth, path)) = split_absolute_uri(req.uri()) {
                let new_uri = Uri::builder().path_and_query(path).build().unwrap();
                *req.uri_mut() = new_uri;
            }

            // Make sure Host header matches the real upstream host.
            req.headers_mut()
                .insert(header::HOST, host.parse().unwrap());

            match upstream.request(req).await {
                Ok(mut resp) => {
                    // TODO: plugin: on_tls_response(&mut resp, &inner_conn).await;
                    Ok::<_, Infallible>(resp)
                }
                Err(err) => {
                    warn!("upstream (tls) error: {}", err);
                    Ok::<_, Infallible>(resp(StatusCode::BAD_GATEWAY, "Upstream error"))
                }
            }
        }
    });

    // Serve the single TLS connection (keep-alive and HTTP/2 streams handled by Hyper)
    auto.serve_connection(TokioIo::new(tls), svc).await?;
    Ok(())
}

/* ----------------- Small helpers below ----------------- */

fn resp(status: StatusCode, text: &str) -> Response<ReqBody> {
    let mut r = Response::new(ReqBody::new(bytes::Bytes::from(text.into())));
    *r.status_mut() = status;
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    r
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

fn split_absolute_uri(uri: &Uri) -> Option<(&str, String, String)> {
    let scheme = uri.scheme_str()?;
    let auth = uri.authority()?.as_str().to_string();
    let pq = uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    Some((scheme, auth, pq))
}

fn parse_authority_host_port(authority: &str, default_port: u16) -> ProxyResult<(String, u16)> {
    match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            Ok((h.to_string(), p.parse().unwrap_or(default_port)))
        }
        _ => Ok((authority.to_string(), default_port)),
    }
}

fn ensure_authority_and_scheme(host: &str, req: &mut Request<ReqBody>) {
    // If client sent origin-form (e.g., GET /path), inject scheme/authority for our own bookkeeping
    if req.uri().authority().is_none() || req.uri().scheme().is_none() {
        let path = req
            .uri()
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/");
        let abs = format!("https://{}{}", host, path);
        *req.uri_mut() = abs.parse().unwrap();
    }
}

async fn build_server_tls_for_host(
    ca: &CertificateAuthority,
    host: &str,
) -> ProxyResult<rustls::ServerConfig> {
    // Use your CA to mint a leaf cert for `host`
    let cert = ca.get_certificate_for_domain(host).await?;
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
