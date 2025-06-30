pub mod http;
pub mod listener;
pub mod tls;

#[cfg(test)]
mod tests;

pub use listener::ProxyServer;

use anyhow::Result;
use std::net::SocketAddr;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tracing::{debug, error, info};

use crate::cert::CertificateAuthority;
use crate::config::Config;
use crate::wasm::{EventType, HttpRequest, HttpResponse, PluginManager, RequestContext};

#[derive(Debug)]
pub struct Connection {
    pub id: String,
    pub client_addr: SocketAddr,
    pub target_host: Option<String>,
    pub is_https: bool,
}

impl Connection {
    pub fn new(client_addr: SocketAddr) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            client_addr,
            target_host: None,
            is_https: false,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("TLS error: {0}")]
    Tls(#[from] rustls::Error),

    #[error("HTTP error: {0}")]
    Http(String),

    #[error("Certificate error: {0}")]
    Certificate(#[from] crate::cert::CertError),

    #[error("Plugin error: {0}")]
    Plugin(#[from] crate::wasm::WasmError),

    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    #[error("Connection timeout")]
    Timeout,

    #[error("DNS resolution failed: {0}")]
    DnsResolution(String),
}

pub type ProxyResult<T> = Result<T, ProxyError>;

// Simple DNS resolver using tokio's built-in functionality
pub struct DnsResolver;

impl DnsResolver {
    pub async fn new() -> Result<Self> {
        Ok(Self)
    }

    pub async fn resolve(&self, hostname: &str) -> ProxyResult<Vec<SocketAddr>> {
        // Validate hostname before attempting resolution
        if hostname.is_empty() {
            return Err(ProxyError::DnsResolution(
                "Empty hostname provided".to_string(),
            ));
        }

        // Trim whitespace and validate hostname format
        let hostname = hostname.trim();
        if hostname.is_empty() {
            return Err(ProxyError::DnsResolution(
                "Hostname is empty after trimming".to_string(),
            ));
        }

        // Basic hostname validation - check for invalid characters
        if hostname.contains(' ')
            || hostname.contains('\t')
            || hostname.contains('\n')
            || hostname.contains('\r')
        {
            return Err(ProxyError::DnsResolution(format!(
                "Invalid hostname format: '{}'",
                hostname
            )));
        }

        // Use tokio's built-in DNS resolution
        let addrs: Vec<SocketAddr> = tokio::net::lookup_host(format!("{}:443", hostname))
            .await
            .map_err(|e| {
                ProxyError::DnsResolution(format!("Failed to resolve '{}': {}", hostname, e))
            })?
            .collect();

        if addrs.is_empty() {
            return Err(ProxyError::DnsResolution(format!(
                "No addresses found for '{}'",
                hostname
            )));
        }

        Ok(addrs)
    }
}

// HTTP parser utilities
pub fn parse_http_request(
    data: &[u8],
) -> ProxyResult<(String, String, std::collections::HashMap<String, String>)> {
    let request_str = String::from_utf8_lossy(data);
    let lines: Vec<&str> = request_str.lines().collect();

    if lines.is_empty() {
        return Err(ProxyError::InvalidRequest("Empty request".to_string()));
    }

    // Parse request line
    let request_line_parts: Vec<&str> = lines[0].split_whitespace().collect();
    if request_line_parts.len() < 3 {
        return Err(ProxyError::InvalidRequest(
            "Invalid request line".to_string(),
        ));
    }

    let method = request_line_parts[0].to_string();
    let url = request_line_parts[1].to_string();

    // Parse headers
    let mut headers = std::collections::HashMap::new();
    for line in &lines[1..] {
        if line.is_empty() {
            break;
        }

        if let Some(colon_pos) = line.find(':') {
            let key = line[..colon_pos].trim().to_lowercase();
            let value = line[colon_pos + 1..].trim().to_string();
            headers.insert(key, value);
        }
    }

    Ok((method, url, headers))
}

pub fn extract_host_from_headers(
    headers: &std::collections::HashMap<String, String>,
) -> Option<String> {
    headers
        .get("host")
        .map(|host| host.trim().to_string())
        .filter(|host| !host.is_empty())
}

pub fn is_connect_request(method: &str) -> bool {
    method.eq_ignore_ascii_case("CONNECT")
}

// Connection utilities
pub async fn establish_upstream_connection(target_addr: SocketAddr) -> ProxyResult<TcpStream> {
    let stream = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        TcpStream::connect(target_addr),
    )
    .await
    .map_err(|_| ProxyError::Timeout)?
    .map_err(ProxyError::Io)?;

    debug!("Established upstream connection to {}", target_addr);
    Ok(stream)
}

// Bidirectional data forwarding
pub async fn forward_data(
    mut client: tokio::net::tcp::OwnedReadHalf,
    mut upstream: tokio::net::tcp::OwnedWriteHalf,
) -> ProxyResult<()> {
    let mut buffer = vec![0u8; 8192];

    loop {
        match client.try_read(&mut buffer) {
            Ok(0) => break, // EOF
            Ok(n) => {
                upstream.write_all(&buffer[..n]).await?;
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // No data available, yield control
                tokio::task::yield_now().await;
                continue;
            }
            Err(e) => return Err(ProxyError::Io(e)),
        }
    }

    Ok(())
}

// Plugin integration helpers
pub async fn create_request_context(
    connection: &Connection,
    method: &str,
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    body: Vec<u8>,
) -> RequestContext {
    RequestContext {
        request_id: connection.id.clone(),
        client_ip: connection.client_addr.ip(),
        target_host: connection.target_host.clone().unwrap_or_default(),
        request: HttpRequest {
            method: method.to_string(),
            url: url.to_string(),
            headers: headers.clone(),
            body,
        },
        response: None,
    }
}

pub async fn execute_plugin_event(
    plugin_manager: &PluginManager,
    event_type: EventType,
    context: &mut RequestContext,
) -> ProxyResult<Vec<crate::wasm::PluginAction>> {
    plugin_manager
        .execute_event(event_type, context)
        .await
        .map_err(ProxyError::Plugin)
}
