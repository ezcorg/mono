//! HTTP/2 protocol handler using h2 crate
//!
//! This handler implements the ProtocolHandler trait for HTTP/2 connections.

use crate::proxy::message::{HttpProtocol, ProxyRequest, ProxyResponse};
use crate::proxy::protocol::{
    ConnectionContext, ConnectionStream, ProtocolHandler, RequestContext,
};
use crate::proxy::{ProxyError, ProxyResult};
use async_trait::async_trait;
use std::net::SocketAddr;
use tracing::{debug, error, info, warn};

/// HTTP/2 protocol handler
#[derive(Debug)]
pub struct Http2Handler {
    /// Maximum concurrent streams
    pub max_concurrent_streams: u32,
    /// Initial connection window size
    pub initial_connection_window_size: u32,
    /// Initial stream window size
    pub initial_stream_window_size: u32,
}

impl Http2Handler {
    /// Create a new HTTP/2 handler
    pub fn new() -> Self {
        Self {
            max_concurrent_streams: 100,
            initial_connection_window_size: 1024 * 1024, // 1MB
            initial_stream_window_size: 64 * 1024,       // 64KB
        }
    }

    /// Create a new HTTP/2 handler with custom settings
    pub fn with_settings(
        max_concurrent_streams: u32,
        initial_connection_window_size: u32,
        initial_stream_window_size: u32,
    ) -> Self {
        Self {
            max_concurrent_streams,
            initial_connection_window_size,
            initial_stream_window_size,
        }
    }

    /// Forward request using HTTP/1.1 as fallback for now
    /// TODO: Implement proper HTTP/2 forwarding
    async fn forward_request_fallback(
        &self,
        request: ProxyRequest,
        context: &RequestContext,
    ) -> ProxyResult<ProxyResponse> {
        // For now, use HTTP/1.1 handler as fallback
        // This ensures the system works while we develop proper HTTP/2 support
        let http1_handler = crate::proxy::handlers::Http1Handler::new();

        // Extract host and port
        let (host, port) = self.extract_host_and_port(&request)?;
        let target_addr = format!("{}:{}", host, port)
            .parse::<SocketAddr>()
            .map_err(|e| ProxyError::Http2(format!("Invalid address {}:{}: {}", host, port, e)))?;

        // Use HTTP/1.1 handler for upstream connection
        http1_handler
            .handle_request(request, target_addr, context)
            .await
            .map_err(|e| ProxyError::Http2(format!("Fallback HTTP/1.1 failed: {}", e)))
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
impl ProtocolHandler for Http2Handler {
    async fn handle_connection(
        &self,
        _conn: Box<dyn ConnectionStream>,
        client_addr: SocketAddr,
        _context: ConnectionContext,
    ) -> ProxyResult<()> {
        info!(
            "HTTP/2 connection handling for {} (using fallback)",
            client_addr
        );

        // TODO: Implement proper HTTP/2 connection handling
        // For now, return an error to indicate this needs implementation
        warn!("HTTP/2 connection handling not fully implemented yet");
        Err(ProxyError::Http2(
            "HTTP/2 connection handling not fully implemented - use HTTP/1.1 fallback".to_string(),
        ))
    }

    fn protocol(&self) -> HttpProtocol {
        HttpProtocol::Http2
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

impl Clone for Http2Handler {
    fn clone(&self) -> Self {
        Self {
            max_concurrent_streams: self.max_concurrent_streams,
            initial_connection_window_size: self.initial_connection_window_size,
            initial_stream_window_size: self.initial_stream_window_size,
        }
    }
}

impl Default for Http2Handler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::message::ProxyRequest;
    use http::{HeaderMap, Method, Uri};

    #[test]
    fn test_extract_host_and_port() {
        let handler = Http2Handler::new();

        // Test with URI containing host and port
        let uri: Uri = "https://example.com:8443/path".parse().unwrap();
        let request = ProxyRequest::new(
            Method::GET,
            uri,
            HeaderMap::new(),
            Vec::new(),
            HttpProtocol::Http2,
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
            HttpProtocol::Http2,
        );

        let (host, port) = handler.extract_host_and_port(&request).unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 443);
    }
}
