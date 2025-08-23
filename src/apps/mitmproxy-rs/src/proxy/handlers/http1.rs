//! HTTP/1.1 protocol handler using hyper
//!
//! This handler implements the ProtocolHandler trait for HTTP/1.1 connections,
//! providing a modern hyper-based implementation that replaces the manual parsing.

use crate::proxy::message::{HttpProtocol, ProxyRequest, ProxyResponse};
use crate::proxy::protocol::{
    ConnectionContext, ConnectionStream, ProtocolHandler, RequestContext,
};
use crate::proxy::{ProxyError, ProxyResult};
use crate::wasm::{EventType, PluginAction};
use async_trait::async_trait;
use http::{HeaderMap, Method, Request, Response, StatusCode, Uri};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request as HyperRequest, Response as HyperResponse};
use hyper_util::rt::TokioIo;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite};
use tracing::{debug, error, info, warn};

/// HTTP/1.1 protocol handler
#[derive(Debug)]
pub struct Http1Handler {
    /// Whether to enable HTTP/1.1 keep-alive
    pub keep_alive: bool,
    /// Maximum number of requests per connection
    pub max_requests_per_connection: Option<usize>,
}

impl Http1Handler {
    /// Create a new HTTP/1.1 handler
    pub fn new() -> Self {
        Self {
            keep_alive: true,
            max_requests_per_connection: Some(100),
        }
    }

    /// Create a new HTTP/1.1 handler with custom settings
    pub fn with_settings(keep_alive: bool, max_requests_per_connection: Option<usize>) -> Self {
        Self {
            keep_alive,
            max_requests_per_connection,
        }
    }

    /// Handle a single HTTP/1.1 request
    async fn handle_single_request(
        &self,
        request: HyperRequest<Incoming>,
        context: Arc<ConnectionContext>,
    ) -> Result<HyperResponse<Full<Bytes>>, Infallible> {
        let result = self.process_request(request, context).await;

        match result {
            Ok(response) => Ok(response),
            Err(e) => {
                error!("Error processing HTTP/1.1 request: {}", e);
                Ok(self.create_error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))
            }
        }
    }

    /// Process a single request through the proxy pipeline
    async fn process_request(
        &self,
        hyper_request: HyperRequest<Incoming>,
        context: Arc<ConnectionContext>,
    ) -> ProxyResult<HyperResponse<Full<Bytes>>> {
        // Convert hyper request to our internal format
        let (parts, body) = hyper_request.into_parts();
        let body_bytes = body
            .collect()
            .await
            .map_err(|e| ProxyError::Http(format!("Failed to read request body: {}", e)))?
            .to_bytes()
            .to_vec();

        let proxy_request = ProxyRequest::new(
            parts.method,
            parts.uri.clone(),
            parts.headers,
            body_bytes,
            HttpProtocol::Http1_1,
        );

        // Create request context for plugins
        let request_id = uuid::Uuid::new_v4().to_string();
        let target_host = self.extract_target_host(&parts.uri, &proxy_request.headers)?;

        let request_context = RequestContext {
            request_id: request_id.clone(),
            client_addr: context.client_addr,
            target_host: target_host.clone(),
            is_https: context.is_https,
            plugin_manager: context.plugin_manager.clone(),
            config: context.config.clone(),
        };

        // Execute plugin events for request
        let mut plugin_context = crate::proxy::create_request_context(
            &crate::proxy::Connection {
                id: request_id.clone(),
                client_addr: context.client_addr,
                target_host: Some(target_host.clone()),
                is_https: context.is_https,
            },
            &proxy_request.method.to_string(),
            &proxy_request.uri.to_string(),
            &proxy_request.to_legacy_format().headers,
            proxy_request.body.clone(),
        )
        .await;

        // Execute request start event
        let actions = crate::proxy::execute_plugin_event(
            &context.plugin_manager,
            EventType::RequestStart,
            &mut plugin_context,
        )
        .await?;

        // Check for blocking/redirect actions
        for action in &actions {
            match action {
                PluginAction::Block(reason) => {
                    return Ok(self.create_error_response(StatusCode::FORBIDDEN, reason));
                }
                PluginAction::Redirect(url) => {
                    return Ok(self.create_redirect_response(url));
                }
                _ => {}
            }
        }

        // Forward request to upstream server
        let response = self
            .forward_request(proxy_request, &request_context)
            .await?;

        // Execute plugin events for response
        plugin_context.response = Some(response.to_legacy_format());
        let _response_actions = crate::proxy::execute_plugin_event(
            &context.plugin_manager,
            EventType::ResponseHeaders,
            &mut plugin_context,
        )
        .await?;

        // Convert response back to hyper format
        let hyper_response = self.convert_to_hyper_response(response)?;

        Ok(hyper_response)
    }

    /// Forward request to upstream server
    async fn forward_request(
        &self,
        request: ProxyRequest,
        context: &RequestContext,
    ) -> ProxyResult<ProxyResponse> {
        // Extract host and port
        let (host, port) = self.extract_host_and_port(&request.uri, &request.headers)?;

        // For now, create a simple socket address - in a full implementation,
        // we would use the DNS resolver from the connection context
        let target_addr = format!("{}:{}", host, port)
            .parse::<SocketAddr>()
            .map_err(|e| ProxyError::Http(format!("Invalid address {}:{}: {}", host, port, e)))?;

        // Connect to upstream server
        let upstream_stream = crate::proxy::establish_upstream_connection(target_addr).await?;
        let io = TokioIo::new(upstream_stream);

        // Create HTTP client connection
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
            .await
            .map_err(|e| {
                ProxyError::Http(format!("Failed to establish HTTP/1.1 connection: {}", e))
            })?;

        // Spawn connection task
        tokio::task::spawn(async move {
            if let Err(err) = conn.await {
                error!("HTTP/1.1 connection failed: {}", err);
            }
        });

        // Convert our request to hyper request
        let hyper_request = request.to_http_request();
        let (parts, body) = hyper_request.into_parts();
        let hyper_req = HyperRequest::from_parts(parts, Full::new(Bytes::from(body)));

        // Send request and get response
        let hyper_response = sender
            .send_request(hyper_req)
            .await
            .map_err(|e| ProxyError::Http(format!("Failed to send request: {}", e)))?;

        // Convert response
        let (parts, body) = hyper_response.into_parts();
        let body_bytes = body
            .collect()
            .await
            .map_err(|e| ProxyError::Http(format!("Failed to read response body: {}", e)))?
            .to_bytes()
            .to_vec();

        let proxy_response = ProxyResponse::new(
            parts.status,
            parts.headers,
            body_bytes,
            HttpProtocol::Http1_1,
        );

        Ok(proxy_response)
    }

    /// Extract target host from URI and headers
    fn extract_target_host(&self, uri: &Uri, headers: &HeaderMap) -> ProxyResult<String> {
        // Try to get host from URI first
        if let Some(host) = uri.host() {
            return Ok(host.to_string());
        }

        // Fall back to Host header
        if let Some(host_header) = headers.get("host") {
            let host_str = host_header
                .to_str()
                .map_err(|_| ProxyError::InvalidRequest("Invalid Host header".to_string()))?;

            // Remove port if present
            let host = if let Some(colon_pos) = host_str.find(':') {
                &host_str[..colon_pos]
            } else {
                host_str
            };

            return Ok(host.to_string());
        }

        Err(ProxyError::InvalidRequest(
            "No host specified in request".to_string(),
        ))
    }

    /// Extract host and port from URI and headers
    fn extract_host_and_port(&self, uri: &Uri, headers: &HeaderMap) -> ProxyResult<(String, u16)> {
        // Try to get from URI first
        if let Some(host) = uri.host() {
            let port = uri
                .port_u16()
                .unwrap_or(if uri.scheme_str() == Some("https") {
                    443
                } else {
                    80
                });
            return Ok((host.to_string(), port));
        }

        // Fall back to Host header
        if let Some(host_header) = headers.get("host") {
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
                Ok((host_str.to_string(), 80))
            }
        } else {
            Err(ProxyError::InvalidRequest(
                "No host specified in request".to_string(),
            ))
        }
    }

    /// Convert ProxyResponse to hyper response
    fn convert_to_hyper_response(
        &self,
        response: ProxyResponse,
    ) -> ProxyResult<HyperResponse<Full<Bytes>>> {
        let mut builder = HyperResponse::builder()
            .status(response.status)
            .version(response.version);

        // Add headers
        for (name, value) in response.headers.iter() {
            builder = builder.header(name, value);
        }

        let body = Full::new(Bytes::from(response.body));
        builder
            .body(body)
            .map_err(|e| ProxyError::Http(format!("Failed to build response: {}", e)))
    }

    /// Create an error response
    fn create_error_response(
        &self,
        status: StatusCode,
        message: &str,
    ) -> HyperResponse<Full<Bytes>> {
        let body = format!("Proxy Error: {}", message);
        HyperResponse::builder()
            .status(status)
            .header("content-type", "text/plain")
            .header("content-length", body.len())
            .body(Full::new(Bytes::from(body)))
            .unwrap()
    }

    /// Create a redirect response
    fn create_redirect_response(&self, location: &str) -> HyperResponse<Full<Bytes>> {
        HyperResponse::builder()
            .status(StatusCode::FOUND)
            .header("location", location)
            .header("content-length", "0")
            .body(Full::new(Bytes::new()))
            .unwrap()
    }
}

#[async_trait]
impl ProtocolHandler for Http1Handler {
    async fn handle_connection(
        &self,
        conn: Box<dyn ConnectionStream>,
        client_addr: SocketAddr,
        context: ConnectionContext,
    ) -> ProxyResult<()> {
        let io = TokioIo::new(conn);
        let context = Arc::new(context);

        // Create service function that captures context
        let context_clone = context.clone();
        let handler = self.clone();
        let service = service_fn(move |req| {
            let context = context_clone.clone();
            let handler = handler.clone();
            async move { handler.handle_single_request(req, context).await }
        });

        // Configure HTTP/1.1 connection
        let mut conn_builder = http1::Builder::new();
        if self.keep_alive {
            conn_builder.keep_alive(true);
        }
        if let Some(max_requests) = self.max_requests_per_connection {
            // Note: hyper doesn't have a direct way to limit requests per connection
            // This would need to be implemented at a higher level
        }

        // Serve the connection
        if let Err(err) = conn_builder.serve_connection(io, service).await {
            if !err.is_closed() && !err.is_incomplete_message() {
                error!("HTTP/1.1 connection error: {}", err);
                return Err(ProxyError::Http(format!("Connection error: {}", err)));
            }
        }

        debug!("HTTP/1.1 connection closed for {}", client_addr);
        Ok(())
    }

    fn protocol(&self) -> HttpProtocol {
        HttpProtocol::Http1_1
    }

    async fn handle_request(
        &self,
        request: ProxyRequest,
        upstream_addr: SocketAddr,
        context: &RequestContext,
    ) -> ProxyResult<ProxyResponse> {
        // This is used by the unified forwarder
        self.forward_request(request, context).await
    }
}

impl Clone for Http1Handler {
    fn clone(&self) -> Self {
        Self {
            keep_alive: self.keep_alive,
            max_requests_per_connection: self.max_requests_per_connection,
        }
    }
}

impl Default for Http1Handler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::{Method, Uri};

    #[test]
    fn test_extract_host_and_port() {
        let handler = Http1Handler::new();
        let headers = HeaderMap::new();

        // Test URI with host and port
        let uri: Uri = "http://example.com:8080/path".parse().unwrap();
        let (host, port) = handler.extract_host_and_port(&uri, &headers).unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 8080);

        // Test URI with host but no port (HTTP)
        let uri: Uri = "http://example.com/path".parse().unwrap();
        let (host, port) = handler.extract_host_and_port(&uri, &headers).unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 80);

        // Test URI with host but no port (HTTPS)
        let uri: Uri = "https://example.com/path".parse().unwrap();
        let (host, port) = handler.extract_host_and_port(&uri, &headers).unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 443);
    }

    #[test]
    fn test_extract_target_host() {
        let handler = Http1Handler::new();
        let mut headers = HeaderMap::new();

        // Test URI with host
        let uri: Uri = "http://example.com/path".parse().unwrap();
        let host = handler.extract_target_host(&uri, &headers).unwrap();
        assert_eq!(host, "example.com");

        // Test Host header fallback
        let uri: Uri = "/path".parse().unwrap();
        headers.insert("host", "example.com:8080".parse().unwrap());
        let host = handler.extract_target_host(&uri, &headers).unwrap();
        assert_eq!(host, "example.com");
    }
}
