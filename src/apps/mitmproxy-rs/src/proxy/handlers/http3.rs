//! HTTP/3 protocol handler using quinn + h3 crates
//!
//! This handler implements the ProtocolHandler trait for HTTP/3 connections.

use crate::proxy::message::{HttpProtocol, ProxyRequest, ProxyResponse};
use crate::proxy::protocol::{
    ConnectionContext, ConnectionStream, ProtocolHandler, RequestContext,
};
use crate::proxy::{ProxyError, ProxyResult};
use async_trait::async_trait;
use std::net::SocketAddr;
use tracing::{debug, error, info, warn};

/// HTTP/3 protocol handler
#[derive(Debug)]
pub struct Http3Handler {
    /// Maximum concurrent streams
    pub max_concurrent_streams: u32,
    /// Maximum idle timeout for connections
    pub max_idle_timeout: std::time::Duration,
    /// Keep alive interval
    pub keep_alive_interval: std::time::Duration,
}

impl Http3Handler {
    /// Create a new HTTP/3 handler
    pub fn new() -> Self {
        Self {
            max_concurrent_streams: 100,
            max_idle_timeout: std::time::Duration::from_secs(30),
            keep_alive_interval: std::time::Duration::from_secs(5),
        }
    }

    /// Create a new HTTP/3 handler with custom settings
    pub fn with_settings(
        max_concurrent_streams: u32,
        max_idle_timeout: std::time::Duration,
        keep_alive_interval: std::time::Duration,
    ) -> Self {
        Self {
            max_concurrent_streams,
            max_idle_timeout,
            keep_alive_interval,
        }
    }

    /// Forward request using HTTP/1.1 as fallback for now
    /// TODO: Implement proper HTTP/3 forwarding
    async fn forward_request_fallback(
        &self,
        request: ProxyRequest,
        context: &RequestContext,
    ) -> ProxyResult<ProxyResponse> {
        // For now, use HTTP/1.1 handler as fallback
        // This ensures the system works while we develop proper HTTP/3 support
        let http1_handler = crate::proxy::handlers::Http1Handler::new();

        // Extract host and port
        let (host, port) = self.extract_host_and_port(&request)?;
        let target_addr = format!("{}:{}", host, port)
            .parse::<SocketAddr>()
            .map_err(|e| ProxyError::Http3(format!("Invalid address {}:{}: {}", host, port, e)))?;

        // Use HTTP/1.1 handler for upstream connection
        http1_handler
            .handle_request(request, target_addr, context)
            .await
            .map_err(|e| ProxyError::Http3(format!("Fallback HTTP/1.1 failed: {}", e)))
    }

    /// Extract host and port from request
    fn extract_host_and_port(&self, request: &ProxyRequest) -> ProxyResult<(String, u16)> {
        // Try to get from URI first
        if let Some(host) = request.uri.host() {
            let port = request.uri.port_u16().unwrap_or_else(|| {
                if request.uri.scheme_str() == Some("https") {
                    443
                } else {
                    80
                }
            });
            return Ok((host.to_string(), port));
        }

        // Fall back to Host header
        if let Some(host_header) = request.headers.get("host") {
            let host_str = host_header
                .to_str()
                .map_err(|_| ProxyError::InvalidRequest("Invalid Host header".to_string()))?;

            if let Some(colon_pos) = host_str.find(':') {
                let host = host_str[..colon_pos].to_string();
                let port = host_str[colon_pos + 1..].parse::<u16>().map_err(|_| {
                    ProxyError::InvalidRequest("Invalid port in Host header".to_string())
                })?;
                Ok((host, port))
            } else {
                // Default port based on the request's apparent scheme
                let port = if request.uri.scheme_str() == Some("https") {
                    443
                } else {
                    80
                };
                Ok((host_str.to_string(), port))
            }
        } else {
            Err(ProxyError::InvalidRequest(
                "No host specified in request".to_string(),
            ))
        }
    }
}

#[async_trait]
impl ProtocolHandler for Http3Handler {
    async fn handle_connection(
        &self,
        _conn: Box<dyn ConnectionStream>,
        client_addr: SocketAddr,
        _context: ConnectionContext,
    ) -> ProxyResult<()> {
        info!(
            "HTTP/3 connection handling for {} (using fallback)",
            client_addr
        );

        // Note: HTTP/3 connections are handled differently since they use QUIC
        // This method is primarily for TCP-based connections
        // HTTP/3 would typically be handled at the QUIC endpoint level

        warn!("HTTP/3 connection handling not fully implemented yet");
        Err(ProxyError::Http3(
            "HTTP/3 requires QUIC endpoint setup at server level - use HTTP/1.1 fallback"
                .to_string(),
        ))
    }

    fn protocol(&self) -> HttpProtocol {
        HttpProtocol::Http3
    }

    async fn handle_request(
        &self,
        request: ProxyRequest,
        _upstream_addr: SocketAddr,
        context: &RequestContext,
    ) -> ProxyResult<ProxyResponse> {
        // Use fallback implementation for now
        self.forward_request_fallback(request, context).await
    }
}

impl Clone for Http3Handler {
    fn clone(&self) -> Self {
        Self {
            max_concurrent_streams: self.max_concurrent_streams,
            max_idle_timeout: self.max_idle_timeout,
            keep_alive_interval: self.keep_alive_interval,
        }
    }
}

impl Default for Http3Handler {
    fn default() -> Self {
        Self::new()
    }
}

/// HTTP/3 server implementation using QUIC
/// This would be used to set up a QUIC endpoint for HTTP/3 support
/// TODO: Implement proper QUIC/HTTP/3 server
pub struct Http3Server {
    handler: Http3Handler,
}

impl Http3Server {
    pub fn new(handler: Http3Handler) -> Self {
        Self { handler }
    }

    /// Start accepting HTTP/3 connections
    /// TODO: Implement proper QUIC endpoint setup
    pub async fn start(&self, _bind_addr: SocketAddr) -> ProxyResult<()> {
        warn!("HTTP/3 server not fully implemented yet");
        Err(ProxyError::Http3(
            "HTTP/3 server requires QUIC implementation".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::message::ProxyRequest;
    use http::{HeaderMap, Method, Uri};

    #[test]
    fn test_extract_host_and_port() {
        let handler = Http3Handler::new();

        // Test with URI containing host and port
        let uri: Uri = "https://example.com:8443/path".parse().unwrap();
        let request = ProxyRequest::new(
            Method::GET,
            uri,
            HeaderMap::new(),
            Vec::new(),
            HttpProtocol::Http3,
        );

        let (host, port) = handler.extract_host_and_port(&request).unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 8443);

        // Test with URI containing host but no port (HTTPS)
        let uri: Uri = "https://example.com/path".parse().unwrap();
        let request = ProxyRequest::new(
            Method::GET,
            uri,
            HeaderMap::new(),
            Vec::new(),
            HttpProtocol::Http3,
        );

        let (host, port) = handler.extract_host_and_port(&request).unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 443);
    }
}
