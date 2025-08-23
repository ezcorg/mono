//! Protocol handler abstraction for multi-protocol proxy support
//!
//! This module defines the trait and infrastructure for handling different
//! HTTP protocols (HTTP/1.1, HTTP/2, HTTP/3) in a unified way.

use super::message::{HttpProtocol, ProxyMessage, ProxyRequest, ProxyResponse};
use super::{ProxyError, ProxyResult};
use async_trait::async_trait;
use std::net::SocketAddr;
use tokio::io::{AsyncRead, AsyncWrite};

/// Helper trait for connection streams that combines the necessary traits
pub trait ConnectionStream: AsyncRead + AsyncWrite + Unpin + Send {}

// Blanket implementation for any type that implements the required traits
impl<T> ConnectionStream for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

/// Trait for protocol-specific handlers
///
/// Each protocol (HTTP/1.1, HTTP/2, HTTP/3) implements this trait to provide
/// a unified interface for handling connections.
#[async_trait]
pub trait ProtocolHandler: Send + Sync {
    /// Handle an incoming connection using this protocol
    ///
    /// This method should:
    /// 1. Parse incoming requests from the connection
    /// 2. Convert them to ProxyMessage format
    /// 3. Forward them to the upstream server
    /// 4. Convert responses back to the appropriate wire format
    /// 5. Send responses back to the client
    async fn handle_connection(
        &self,
        conn: Box<dyn ConnectionStream>,
        client_addr: SocketAddr,
        context: ConnectionContext,
    ) -> ProxyResult<()>;

    /// Get the protocol this handler supports
    fn protocol(&self) -> HttpProtocol;

    /// Check if this handler can handle the given ALPN protocol
    fn supports_alpn(&self, alpn: &[u8]) -> bool {
        self.protocol().alpn_id() == alpn
    }

    /// Handle a single request-response cycle
    ///
    /// This is used by the unified forwarder to process individual messages
    async fn handle_request(
        &self,
        request: ProxyRequest,
        upstream_addr: SocketAddr,
        context: &RequestContext,
    ) -> ProxyResult<ProxyResponse>;
}

/// Context information for a connection
#[derive(Debug, Clone)]
pub struct ConnectionContext {
    /// Client address
    pub client_addr: SocketAddr,
    /// Target host (if known from CONNECT or Host header)
    pub target_host: Option<String>,
    /// Whether this is an HTTPS connection
    pub is_https: bool,
    /// Plugin manager for executing plugin events
    pub plugin_manager: crate::wasm::PluginManager,
    /// Configuration
    pub config: crate::config::Config,
    /// DNS resolver
    pub dns_resolver: std::sync::Arc<super::DnsResolver>,
}

/// Context information for a single request
#[derive(Debug, Clone)]
pub struct RequestContext {
    /// Unique request ID
    pub request_id: String,
    /// Client address
    pub client_addr: SocketAddr,
    /// Target host
    pub target_host: String,
    /// Whether this is an HTTPS request
    pub is_https: bool,
    /// Plugin manager for executing plugin events
    pub plugin_manager: crate::wasm::PluginManager,
    /// Configuration
    pub config: crate::config::Config,
}

/// Protocol negotiation result
#[derive(Debug, Clone)]
pub enum ProtocolNegotiation {
    /// Use HTTP/1.1
    Http1_1,
    /// Use HTTP/2
    Http2,
    /// Use HTTP/3
    Http3,
    /// Protocol not supported
    Unsupported(Vec<u8>),
}

/// Protocol negotiator for ALPN-based protocol selection
pub struct ProtocolNegotiator {
    handlers: std::collections::HashMap<HttpProtocol, Box<dyn ProtocolHandler>>,
}

// Manual Debug implementation (does not print handlers)
impl std::fmt::Debug for ProtocolNegotiator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProtocolNegotiator")
            .field(
                "handlers",
                &"HashMap<HttpProtocol, Box<dyn ProtocolHandler>>",
            )
            .finish()
    }
}

impl ProtocolNegotiator {
    /// Create a new protocol negotiator
    pub fn new() -> Self {
        Self {
            handlers: std::collections::HashMap::new(),
        }
    }

    /// Register a protocol handler
    pub fn register_handler(&mut self, handler: Box<dyn ProtocolHandler>) {
        let protocol = handler.protocol();
        self.handlers.insert(protocol, handler);
    }

    /// Negotiate protocol based on ALPN
    pub fn negotiate_protocol(&self, alpn: Option<&[u8]>) -> ProtocolNegotiation {
        match alpn {
            Some(alpn_bytes) => {
                if let Some(protocol) = HttpProtocol::from_alpn(alpn_bytes) {
                    if self.handlers.contains_key(&protocol) {
                        match protocol {
                            HttpProtocol::Http1_1 => ProtocolNegotiation::Http1_1,
                            HttpProtocol::Http2 => ProtocolNegotiation::Http2,
                            HttpProtocol::Http3 => ProtocolNegotiation::Http3,
                        }
                    } else {
                        ProtocolNegotiation::Unsupported(alpn_bytes.to_vec())
                    }
                } else {
                    ProtocolNegotiation::Unsupported(alpn_bytes.to_vec())
                }
            }
            None => {
                // Default to HTTP/1.1 for cleartext connections
                if self.handlers.contains_key(&HttpProtocol::Http1_1) {
                    ProtocolNegotiation::Http1_1
                } else {
                    ProtocolNegotiation::Unsupported(b"none".to_vec())
                }
            }
        }
    }

    /// Get handler for a specific protocol
    pub fn get_handler(&self, protocol: HttpProtocol) -> Option<&dyn ProtocolHandler> {
        self.handlers.get(&protocol).map(|h| h.as_ref())
    }

    /// Handle connection with appropriate protocol handler
    pub async fn handle_connection(
        &self,
        conn: Box<dyn ConnectionStream>,
        client_addr: SocketAddr,
        alpn: Option<&[u8]>,
        context: ConnectionContext,
    ) -> ProxyResult<()> {
        match self.negotiate_protocol(alpn) {
            ProtocolNegotiation::Http1_1 => {
                if let Some(handler) = self.get_handler(HttpProtocol::Http1_1) {
                    handler.handle_connection(conn, client_addr, context).await
                } else {
                    Err(ProxyError::Http(
                        "HTTP/1.1 handler not available".to_string(),
                    ))
                }
            }
            ProtocolNegotiation::Http2 => {
                if let Some(handler) = self.get_handler(HttpProtocol::Http2) {
                    handler.handle_connection(conn, client_addr, context).await
                } else {
                    Err(ProxyError::Http("HTTP/2 handler not available".to_string()))
                }
            }
            ProtocolNegotiation::Http3 => {
                if let Some(handler) = self.get_handler(HttpProtocol::Http3) {
                    handler.handle_connection(conn, client_addr, context).await
                } else {
                    Err(ProxyError::Http("HTTP/3 handler not available".to_string()))
                }
            }
            ProtocolNegotiation::Unsupported(alpn_bytes) => Err(ProxyError::Http(format!(
                "Unsupported protocol: {}",
                String::from_utf8_lossy(&alpn_bytes)
            ))),
        }
    }

    /// Get list of supported ALPN protocols
    pub fn supported_alpn_protocols(&self) -> Vec<Vec<u8>> {
        self.handlers
            .keys()
            .map(|protocol| protocol.alpn_id().to_vec())
            .collect()
    }
}

impl Default for ProtocolNegotiator {
    fn default() -> Self {
        Self::new()
    }
}

/// Utility functions for protocol handling
pub mod utils {
    use super::*;

    /// Extract ALPN protocol from TLS connection
    pub fn extract_alpn_from_tls(
        tls_stream: &tokio_rustls::server::TlsStream<tokio::net::TcpStream>,
    ) -> Option<Vec<u8>> {
        tls_stream.get_ref().1.alpn_protocol().map(|p| p.to_vec())
    }

    /// Create a connection context from basic parameters
    pub fn create_connection_context(
        client_addr: SocketAddr,
        target_host: Option<String>,
        is_https: bool,
        plugin_manager: crate::wasm::PluginManager,
        config: crate::config::Config,
        dns_resolver: std::sync::Arc<crate::proxy::DnsResolver>,
    ) -> ConnectionContext {
        ConnectionContext {
            client_addr,
            target_host,
            is_https,
            plugin_manager,
            config,
            dns_resolver,
        }
    }

    /// Create a request context from connection context
    pub fn create_request_context(
        connection_ctx: &ConnectionContext,
        request_id: String,
        target_host: String,
    ) -> RequestContext {
        RequestContext {
            request_id,
            client_addr: connection_ctx.client_addr,
            target_host,
            is_https: connection_ctx.is_https,
            plugin_manager: connection_ctx.plugin_manager.clone(),
            config: connection_ctx.config.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_protocol_negotiation() {
        let negotiator = ProtocolNegotiator::new();

        // Test ALPN negotiation
        assert!(matches!(
            negotiator.negotiate_protocol(Some(b"h2")),
            ProtocolNegotiation::Unsupported(_)
        ));

        assert!(matches!(
            negotiator.negotiate_protocol(Some(b"unknown")),
            ProtocolNegotiation::Unsupported(_)
        ));

        assert!(matches!(
            negotiator.negotiate_protocol(None),
            ProtocolNegotiation::Unsupported(_)
        ));
    }

    #[test]
    fn test_supported_alpn_protocols() {
        let negotiator = ProtocolNegotiator::new();
        let protocols = negotiator.supported_alpn_protocols();
        assert!(protocols.is_empty());
    }
}
