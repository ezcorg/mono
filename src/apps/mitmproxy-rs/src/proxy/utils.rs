use crate::cert::{CertError, CertificateAuthority};

use bytes::Bytes;
use futures::TryStreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Body, Incoming};
use hyper::{header, Method, Request, Response};
use reqwest::Certificate;
use tokio_rustls::rustls;
use wasmtime_wasi_http::p3::bindings::http::types::ErrorCode;
use wasmtime_wasi_http::body::HyperIncomingBody;
use wasmtime_wasi_http::p3::{Request as WasiRequest};

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

impl From<CertError> for ProxyError {
    fn from(err: CertError) -> Self {
        ProxyError::Cert(Box::new(err))
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

pub type UpstreamClient = reqwest::Client;
pub type ProxyResult<T> = Result<T, ProxyError>;

/// Wrap a hyper Incoming body as a reqwest Body
pub fn wrap_body(incoming: Incoming) -> reqwest::Body {
    let stream = incoming.into_data_stream().map_err(|e| {
        let err: Box<dyn std::error::Error + Send + Sync> = Box::new(e);
        err
    });
    reqwest::Body::wrap_stream(stream)
}

pub fn wrap_box_body(body: BoxBody<Bytes, ErrorCode>) -> reqwest::Body {
    let stream = body.into_data_stream().map_err(|e| {
        let err: Box<dyn std::error::Error + Send + Sync> = Box::new(e);
        err
    });
    reqwest::Body::wrap_stream(stream)
}

pub fn convert_hyper_boxed_body_to_reqwest_request(
    hyper_req: Request<BoxBody<Bytes, ErrorCode>>,
    client: &reqwest::Client,
) -> ProxyResult<reqwest::Request> {
    let (parts, body) = hyper_req.into_parts();

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

        // TODO: fixme this to handle http vs https properly
        let scheme = "https";
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
        req_builder = req_builder.body(wrap_box_body(body));
    }

    req_builder
        .build()
        .map_err(|e| ProxyError::Generic(format!("Failed to build reqwest request: {}", e)))
}

/// Convert a hyper Request to a reqwest Request
pub fn convert_hyper_incoming_to_reqwest_request(
    hyper_req: Request<Incoming>,
    client: &reqwest::Client,
) -> ProxyResult<reqwest::Request> {
    let (parts, body) = hyper_req.into_parts();

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

        // TODO: fixme this to handle http vs https properly
        let scheme = "https";
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
pub async fn convert_reqwest_to_hyper_response(
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

/// Convert a Response<BoxBody<Bytes, ErrorCode>> to a Response<Full<Bytes>>
pub async fn convert_boxbody_to_full_response(
    response: Response<BoxBody<Bytes, ErrorCode>>,
) -> ProxyResult<Response<Full<Bytes>>> {
    let (parts, body) = response.into_parts();
    
    // Collect all body data into bytes
    let body_bytes = body.collect().await
        .map_err(|e| ProxyError::Generic(format!("Failed to collect body data: {}", e)))?
        .to_bytes();
    
    // Build new response with Full<Bytes> body
    let mut response_builder = Response::builder()
        .status(parts.status)
        .version(parts.version);
    
    // Copy all headers
    for (name, value) in parts.headers.iter() {
        response_builder = response_builder.header(name, value);
    }
    
    response_builder
        .body(Full::new(body_bytes))
        .map_err(|e| ProxyError::Generic(format!("Failed to build response: {}", e)))
}

/// Create a configured reqwest client for upstream requests
pub fn client(ca: CertificateAuthority) -> ProxyResult<UpstreamClient> {
    let ca_cert = Certificate::from_der(&ca.get_root_certificate_der()?)
        .map_err(|e| ProxyError::Cert(e.to_string().into()))?;

    let client = reqwest::Client::builder()
        .pool_idle_timeout(std::time::Duration::from_secs(10))
        .pool_max_idle_per_host(1)
        .add_root_certificate(ca_cert)
        .http1_title_case_headers()
        .build()
        .map_err(|e| ProxyError::Generic(format!("Failed to build reqwest client: {}", e)))?;
    Ok(client)
}

/// Strip hop-by-hop headers from HTTP requests/responses
pub fn strip_proxy_headers(h: &mut hyper::HeaderMap) {
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

/// Parse authority string into host and port components
pub fn parse_authority_host_port(authority: &str, default_port: u16) -> ProxyResult<(String, u16)> {
    match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            Ok((h.to_string(), p.parse().unwrap_or(default_port)))
        }
        _ => Ok((authority.to_string(), default_port)),
    }
}

/// Build a TLS server configuration for the given host using the CA
pub async fn build_server_tls_for_host(
    ca: &CertificateAuthority,
    host: &str,
) -> ProxyResult<rustls::ServerConfig> {
    // Use your CA to mint a leaf cert for `host`
    let cert = ca
        .get_certificate_for_domain(host)
        .await
        .map_err(|e| ProxyError::Cert(e.into()))?;

    let root_cert_der = ca
        .get_root_certificate_der()
        .map_err(|e| ProxyError::Cert(e.into()))?;
    let cert_chain = vec![cert.cert_der.clone(), root_cert_der.into()];

    // Minimal rustls server config
    let mut cfg = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(cert_chain, cert.key_der)
        .map_err(|e| ProxyError::Tls(rustls::Error::General(e.to_string())))?;
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(cfg)
}

/// Check if an error indicates a closed connection
pub fn is_closed<E: std::fmt::Display>(e: &E) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains("broken pipe")
        || s.contains("connection reset")
        || s.contains("connection aborted")
        || s.contains("unexpected eof")
        || s.contains("close_notify")
}
