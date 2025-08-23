//! Unified forwarder for multi-protocol support
//!
//! This module provides a unified interface for forwarding requests across
//! different HTTP protocols (HTTP/1.1, HTTP/2, HTTP/3).

use crate::proxy::handlers::{Http1Handler, Http2Handler, Http3Handler};
use crate::proxy::message::{HttpProtocol, ProxyRequest, ProxyResponse};
use crate::proxy::protocol::{ProtocolHandler, ProtocolNegotiator, RequestContext};
use crate::proxy::{ProxyError, ProxyResult};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing::{debug, error, info, warn};

/// Unified forwarder that can handle requests across multiple protocols
#[derive(Debug)]
pub struct UnifiedForwarder {
    /// HTTP/1.1 handler
    http1_handler: Http1Handler,
    /// HTTP/2 handler
    http2_handler: Http2Handler,
    /// HTTP/3 handler
    http3_handler: Http3Handler,
    /// Protocol negotiator for determining upstream protocol
    protocol_negotiator: ProtocolNegotiator,
    /// DNS resolver for upstream connections
    dns_resolver: Arc<crate::proxy::DnsResolver>,
}

impl UnifiedForwarder {
    /// Create a new unified forwarder
    pub fn new(dns_resolver: Arc<crate::proxy::DnsResolver>) -> Self {
        let mut protocol_negotiator = ProtocolNegotiator::new();

        // Register protocol handlers
        protocol_negotiator.register_handler(Box::new(Http1Handler::new()));
        protocol_negotiator.register_handler(Box::new(Http2Handler::new()));
        protocol_negotiator.register_handler(Box::new(Http3Handler::new()));

        Self {
            http1_handler: Http1Handler::new(),
            http2_handler: Http2Handler::new(),
            http3_handler: Http3Handler::new(),
            protocol_negotiator,
            dns_resolver,
        }
    }

    /// Create a new unified forwarder with custom handlers
    pub fn with_handlers(
        http1_handler: Http1Handler,
        http2_handler: Http2Handler,
        http3_handler: Http3Handler,
        dns_resolver: Arc<crate::proxy::DnsResolver>,
    ) -> Self {
        let mut protocol_negotiator = ProtocolNegotiator::new();

        // Register protocol handlers
        protocol_negotiator.register_handler(Box::new(http1_handler.clone()));
        protocol_negotiator.register_handler(Box::new(http2_handler.clone()));
        protocol_negotiator.register_handler(Box::new(http3_handler.clone()));

        Self {
            http1_handler,
            http2_handler,
            http3_handler,
            protocol_negotiator,
            dns_resolver,
        }
    }

    /// Forward a request to the upstream server using the best available protocol
    pub async fn forward_request(
        &self,
        request: ProxyRequest,
        context: &RequestContext,
    ) -> ProxyResult<ProxyResponse> {
        // Extract target information
        let (host, port) = self.extract_host_and_port(&request)?;

        // Resolve upstream address
        let upstream_addr = self.resolve_upstream_address(&host, port).await?;

        // Determine the best protocol for upstream connection
        let upstream_protocol = self.negotiate_upstream_protocol(&host, port).await?;

        info!(
            "Forwarding request to {}:{} using {:?}",
            host, port, upstream_protocol
        );

        // Forward using the appropriate protocol handler
        match upstream_protocol {
            HttpProtocol::Http1_1 => {
                ProtocolHandler::handle_request(
                    &self.http1_handler,
                    request,
                    upstream_addr,
                    context,
                )
                .await
            }
            HttpProtocol::Http2 => {
                ProtocolHandler::handle_request(
                    &self.http2_handler,
                    request,
                    upstream_addr,
                    context,
                )
                .await
            }
            HttpProtocol::Http3 => {
                ProtocolHandler::handle_request(
                    &self.http3_handler,
                    request,
                    upstream_addr,
                    context,
                )
                .await
            }
        }
    }

    /// Forward a request using a specific protocol
    pub async fn forward_request_with_protocol(
        &self,
        request: ProxyRequest,
        context: &RequestContext,
        protocol: HttpProtocol,
    ) -> ProxyResult<ProxyResponse> {
        // Extract target information
        let (host, port) = self.extract_host_and_port(&request)?;

        // Resolve upstream address
        let upstream_addr = self.resolve_upstream_address(&host, port).await?;

        info!(
            "Forwarding request to {}:{} using forced protocol {:?}",
            host, port, protocol
        );

        // Forward using the specified protocol handler
        match protocol {
            HttpProtocol::Http1_1 => {
                ProtocolHandler::handle_request(
                    &self.http1_handler,
                    request,
                    upstream_addr,
                    context,
                )
                .await
            }
            HttpProtocol::Http2 => {
                ProtocolHandler::handle_request(
                    &self.http2_handler,
                    request,
                    upstream_addr,
                    context,
                )
                .await
            }
            HttpProtocol::Http3 => {
                ProtocolHandler::handle_request(
                    &self.http3_handler,
                    request,
                    upstream_addr,
                    context,
                )
                .await
            }
        }
    }

    /// Negotiate the best protocol for upstream connection
    async fn negotiate_upstream_protocol(
        &self,
        host: &str,
        port: u16,
    ) -> ProxyResult<HttpProtocol> {
        // For now, use a simple heuristic:
        // 1. Try HTTP/2 for HTTPS (port 443)
        // 2. Fall back to HTTP/1.1 for HTTP (port 80) or unknown ports
        // 3. HTTP/3 would require QUIC capability detection

        match port {
            443 => {
                // For HTTPS, prefer HTTP/2 but fall back to HTTP/1.1
                // In a full implementation, we would:
                // 1. Attempt TLS connection with ALPN
                // 2. Check what protocols the server supports
                // 3. Choose the best available protocol

                debug!("Using HTTP/2 for HTTPS connection to {}:{}", host, port);
                Ok(HttpProtocol::Http2)
            }
            80 => {
                // For HTTP, use HTTP/1.1 (most compatible)
                debug!("Using HTTP/1.1 for HTTP connection to {}:{}", host, port);
                Ok(HttpProtocol::Http1_1)
            }
            _ => {
                // For other ports, default to HTTP/1.1
                debug!(
                    "Using HTTP/1.1 for connection to {}:{} (unknown port)",
                    host, port
                );
                Ok(HttpProtocol::Http1_1)
            }
        }
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

    /// Resolve upstream address using DNS resolver
    async fn resolve_upstream_address(&self, host: &str, port: u16) -> ProxyResult<SocketAddr> {
        self.dns_resolver.resolve_with_fallback(host, port).await
    }

    /// Get supported protocols for a given host
    pub async fn get_supported_protocols(&self, host: &str, port: u16) -> Vec<HttpProtocol> {
        // In a full implementation, this would:
        // 1. Attempt connections with different protocols
        // 2. Cache the results for future use
        // 3. Return the list of supported protocols

        // For now, return a static list based on port
        match port {
            443 => vec![HttpProtocol::Http2, HttpProtocol::Http1_1], // HTTPS supports both
            80 => vec![HttpProtocol::Http1_1], // HTTP typically only supports HTTP/1.1
            _ => vec![HttpProtocol::Http1_1],  // Default to HTTP/1.1 for unknown ports
        }
    }

    /// Check if a specific protocol is supported by the upstream
    pub async fn is_protocol_supported(
        &self,
        host: &str,
        port: u16,
        protocol: HttpProtocol,
    ) -> bool {
        let supported = self.get_supported_protocols(host, port).await;
        supported.contains(&protocol)
    }

    /// Get statistics about forwarded requests
    pub fn get_stats(&self) -> ForwarderStats {
        // In a full implementation, this would track:
        // - Number of requests per protocol
        // - Success/failure rates
        // - Average response times
        // - Protocol negotiation results

        ForwarderStats {
            total_requests: 0,
            http1_requests: 0,
            http2_requests: 0,
            http3_requests: 0,
            failed_requests: 0,
        }
    }
}

/// Statistics for the unified forwarder
#[derive(Debug, Clone)]
pub struct ForwarderStats {
    pub total_requests: u64,
    pub http1_requests: u64,
    pub http2_requests: u64,
    pub http3_requests: u64,
    pub failed_requests: u64,
}

impl ForwarderStats {
    pub fn success_rate(&self) -> f64 {
        if self.total_requests == 0 {
            0.0
        } else {
            (self.total_requests - self.failed_requests) as f64 / self.total_requests as f64
        }
    }

    pub fn protocol_distribution(&self) -> (f64, f64, f64) {
        if self.total_requests == 0 {
            (0.0, 0.0, 0.0)
        } else {
            let total = self.total_requests as f64;
            (
                self.http1_requests as f64 / total,
                self.http2_requests as f64 / total,
                self.http3_requests as f64 / total,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proxy::message::{HttpProtocol, ProxyRequest};
    use http::{HeaderMap, Method, Uri};

    #[tokio::test]
    async fn test_extract_host_and_port() {
        let dns_resolver = Arc::new(crate::proxy::DnsResolver::new().await.unwrap());
        let forwarder = UnifiedForwarder::new(dns_resolver);

        // Test with URI containing host and port
        let uri: Uri = "https://example.com:8443/path".parse().unwrap();
        let request = ProxyRequest::new(
            Method::GET,
            uri,
            HeaderMap::new(),
            Vec::new(),
            HttpProtocol::Http1_1,
        );

        let (host, port) = forwarder.extract_host_and_port(&request).unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 8443);

        // Test with URI containing host but no port (HTTPS)
        let uri: Uri = "https://example.com/path".parse().unwrap();
        let request = ProxyRequest::new(
            Method::GET,
            uri,
            HeaderMap::new(),
            Vec::new(),
            HttpProtocol::Http1_1,
        );

        let (host, port) = forwarder.extract_host_and_port(&request).unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 443);

        // Test with URI containing host but no port (HTTP)
        let uri: Uri = "http://example.com/path".parse().unwrap();
        let request = ProxyRequest::new(
            Method::GET,
            uri,
            HeaderMap::new(),
            Vec::new(),
            HttpProtocol::Http1_1,
        );

        let (host, port) = forwarder.extract_host_and_port(&request).unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 80);
    }

    #[tokio::test]
    async fn test_negotiate_upstream_protocol() {
        let dns_resolver = Arc::new(crate::proxy::DnsResolver::new().await.unwrap());
        let forwarder = UnifiedForwarder::new(dns_resolver);

        // Test HTTPS port
        let protocol = forwarder
            .negotiate_upstream_protocol("example.com", 443)
            .await
            .unwrap();
        assert_eq!(protocol, HttpProtocol::Http2);

        // Test HTTP port
        let protocol = forwarder
            .negotiate_upstream_protocol("example.com", 80)
            .await
            .unwrap();
        assert_eq!(protocol, HttpProtocol::Http1_1);

        // Test unknown port
        let protocol = forwarder
            .negotiate_upstream_protocol("example.com", 8080)
            .await
            .unwrap();
        assert_eq!(protocol, HttpProtocol::Http1_1);
    }

    #[tokio::test]
    async fn test_get_supported_protocols() {
        let dns_resolver = Arc::new(crate::proxy::DnsResolver::new().await.unwrap());
        let forwarder = UnifiedForwarder::new(dns_resolver);

        // Test HTTPS port
        let protocols = forwarder.get_supported_protocols("example.com", 443).await;
        assert!(protocols.contains(&HttpProtocol::Http2));
        assert!(protocols.contains(&HttpProtocol::Http1_1));

        // Test HTTP port
        let protocols = forwarder.get_supported_protocols("example.com", 80).await;
        assert!(protocols.contains(&HttpProtocol::Http1_1));
        assert!(!protocols.contains(&HttpProtocol::Http2));
    }
}
