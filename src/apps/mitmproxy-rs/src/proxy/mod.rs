pub mod forwarder;
pub mod handlers;
pub mod http;
pub mod listener;
pub mod message;
pub mod protocol;
pub mod tls;

#[cfg(test)]
mod tests;

pub use listener::ProxyServer;

use anyhow::Result;
use std::net::SocketAddr;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tracing::{debug, error};

use crate::wasm::{EventType, HttpRequest, PluginManager, RequestContext};

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

    #[error("Unsupported protocol: {0}")]
    UnsupportedProtocol(String),

    #[error("Protocol negotiation failed: {0}")]
    ProtocolNegotiation(String),

    #[error("HTTP/2 error: {0}")]
    Http2(String),

    #[error("HTTP/3 error: {0}")]
    Http3(String),
}

pub type ProxyResult<T> = Result<T, ProxyError>;

// DNS resolver with caching using standard library functions
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

#[derive(Clone, Debug)]
struct DnsCacheEntry {
    addresses: Vec<SocketAddr>,
    expires_at: Instant,
}

#[derive(Debug)]
pub struct DnsResolver {
    cache: Arc<RwLock<HashMap<String, DnsCacheEntry>>>,
    cache_ttl: Duration,
}

impl DnsResolver {
    pub async fn new() -> Result<Self> {
        Ok(Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            cache_ttl: Duration::from_secs(300), // 5 minutes cache
        })
    }

    pub async fn resolve(&self, hostname: &str) -> ProxyResult<Vec<SocketAddr>> {
        self.resolve_with_port(hostname, 443).await
    }

    pub async fn resolve_with_port(
        &self,
        hostname: &str,
        default_port: u16,
    ) -> ProxyResult<Vec<SocketAddr>> {
        // Basic validation - let standard library handle the rest
        let hostname = hostname.trim();
        if hostname.is_empty() {
            return Err(ProxyError::DnsResolution(
                "Empty hostname provided".to_string(),
            ));
        }

        // Handle IP addresses directly for efficiency
        // Check for IPv6 with brackets and port: [::1]:8080
        if hostname.starts_with('[') {
            if let Some(bracket_end) = hostname.find(']') {
                let ipv6_part = &hostname[1..bracket_end];
                if let Ok(ip) = ipv6_part.parse::<std::net::IpAddr>() {
                    let port = if hostname.len() > bracket_end + 1
                        && hostname.chars().nth(bracket_end + 1) == Some(':')
                    {
                        hostname[bracket_end + 2..]
                            .parse::<u16>()
                            .unwrap_or(default_port)
                    } else {
                        default_port
                    };
                    let addr = SocketAddr::new(ip, port);
                    debug!("Direct IPv6 address resolution: {} -> {}", hostname, addr);
                    return Ok(vec![addr]);
                }
            }
        }

        // Check if it's a plain IP address (IPv4 or IPv6 without brackets)
        if let Ok(ip) = hostname.parse::<std::net::IpAddr>() {
            let addr = SocketAddr::new(ip, default_port);
            debug!("Direct IP address resolution: {} -> {}", hostname, addr);
            return Ok(vec![addr]);
        }

        // Check for IPv4 with port: 192.168.1.1:3000
        if !hostname.contains("::") && hostname.matches(':').count() == 1 {
            if let Some(colon_pos) = hostname.rfind(':') {
                let host_part = &hostname[..colon_pos];
                let port_str = &hostname[colon_pos + 1..];

                if let (Ok(ip), Ok(port)) = (
                    host_part.parse::<std::net::IpAddr>(),
                    port_str.parse::<u16>(),
                ) {
                    let addr = SocketAddr::new(ip, port);
                    debug!(
                        "Direct IPv4 address resolution with port: {} -> {}",
                        hostname, addr
                    );
                    return Ok(vec![addr]);
                }
            }
        }

        // Prepare the lookup target - if hostname doesn't contain a port, add the default
        let lookup_target =
            if hostname.contains(':') && !hostname.parse::<std::net::IpAddr>().is_ok() {
                // Hostname already contains port (and it's not an IPv6 address)
                hostname.to_string()
            } else {
                // Add default port
                format!("{}:{}", hostname, default_port)
            };

        // Create cache key
        let cache_key = lookup_target.clone();

        // Check cache first
        {
            let cache = self.cache.read().await;
            if let Some(entry) = cache.get(&cache_key) {
                if entry.expires_at > Instant::now() {
                    debug!("DNS cache hit for {}", cache_key);
                    return Ok(entry.addresses.clone());
                }
            }
        }

        debug!("DNS cache miss for {}, resolving...", cache_key);

        // Perform DNS resolution using standard library with retry logic
        let mut last_error = None;

        // Try resolution with exponential backoff
        for attempt in 0..3 {
            match tokio::net::lookup_host(&lookup_target).await {
                Ok(addrs) => {
                    let addresses: Vec<SocketAddr> = addrs.collect();

                    if addresses.is_empty() {
                        return Err(ProxyError::DnsResolution(format!(
                            "No addresses found for '{}'",
                            hostname
                        )));
                    }

                    // Cache the result
                    let entry = DnsCacheEntry {
                        addresses: addresses.clone(),
                        expires_at: Instant::now() + self.cache_ttl,
                    };

                    {
                        let mut cache = self.cache.write().await;
                        cache.insert(cache_key.clone(), entry);

                        // Clean up expired entries periodically
                        if cache.len() > 1000 {
                            let now = Instant::now();
                            cache.retain(|_, entry| entry.expires_at > now);
                        }
                    }

                    debug!(
                        "DNS resolved {} to {} addresses",
                        cache_key,
                        addresses.len()
                    );
                    return Ok(addresses);
                }
                Err(e) => {
                    last_error = Some(e);
                    if attempt < 2 {
                        // Exponential backoff: 100ms, 200ms
                        let delay = Duration::from_millis(100 * (1 << attempt));
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }

        Err(ProxyError::DnsResolution(format!(
            "Failed to resolve '{}' after 3 attempts: {}",
            hostname,
            last_error.unwrap()
        )))
    }

    pub async fn resolve_with_fallback(
        &self,
        hostname: &str,
        default_port: u16,
    ) -> ProxyResult<SocketAddr> {
        let addresses = self.resolve_with_port(hostname, default_port).await?;

        // Try to connect to each address to find a working one
        for addr in &addresses {
            match tokio::time::timeout(Duration::from_secs(2), TcpStream::connect(addr)).await {
                Ok(Ok(_)) => {
                    debug!("Successfully connected to {} for {}", addr, hostname);
                    return Ok(*addr);
                }
                Ok(Err(_)) | Err(_) => {
                    debug!(
                        "Failed to connect to {} for {}, trying next",
                        addr, hostname
                    );
                    continue;
                }
            }
        }

        // If no address worked, return the first one anyway
        Ok(addresses[0])
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
    client: tokio::net::tcp::OwnedReadHalf,
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
