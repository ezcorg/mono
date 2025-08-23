//! Common message types for multi-protocol proxy support
//!
//! This module provides unified request/response representations that work
//! across HTTP/1.1, HTTP/2, and HTTP/3 protocols.

use http::{HeaderMap, Method, Request, Response, StatusCode, Uri, Version};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Unified message type that can represent both requests and responses
/// across all supported HTTP protocols
#[derive(Debug, Clone)]
pub enum ProxyMessage {
    Request(ProxyRequest),
    Response(ProxyResponse),
}

/// Unified request representation that abstracts over HTTP versions
#[derive(Debug, Clone)]
pub struct ProxyRequest {
    /// HTTP method (GET, POST, etc.)
    pub method: Method,
    /// Request URI
    pub uri: Uri,
    /// HTTP version (will be set based on the protocol handler)
    pub version: Version,
    /// Request headers
    pub headers: HeaderMap,
    /// Request body
    pub body: Vec<u8>,
    /// Original protocol this request came from
    pub protocol: HttpProtocol,
}

/// Unified response representation that abstracts over HTTP versions
#[derive(Debug, Clone)]
pub struct ProxyResponse {
    /// HTTP status code
    pub status: StatusCode,
    /// HTTP version (will be set based on the protocol handler)
    pub version: Version,
    /// Response headers
    pub headers: HeaderMap,
    /// Response body
    pub body: Vec<u8>,
    /// Original protocol this response came from
    pub protocol: HttpProtocol,
}

/// Supported HTTP protocols
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum HttpProtocol {
    Http1_1,
    Http2,
    Http3,
}

impl HttpProtocol {
    /// Get the ALPN identifier for this protocol
    pub fn alpn_id(&self) -> &'static [u8] {
        match self {
            HttpProtocol::Http1_1 => b"http/1.1",
            HttpProtocol::Http2 => b"h2",
            HttpProtocol::Http3 => b"h3",
        }
    }

    /// Get the HTTP version for this protocol
    pub fn http_version(&self) -> Version {
        match self {
            HttpProtocol::Http1_1 => Version::HTTP_11,
            HttpProtocol::Http2 => Version::HTTP_2,
            HttpProtocol::Http3 => Version::HTTP_3,
        }
    }

    /// Parse protocol from ALPN identifier
    pub fn from_alpn(alpn: &[u8]) -> Option<Self> {
        match alpn {
            b"http/1.1" => Some(HttpProtocol::Http1_1),
            b"h2" => Some(HttpProtocol::Http2),
            b"h3" => Some(HttpProtocol::Http3),
            _ => None,
        }
    }
}

impl ProxyRequest {
    /// Create a new proxy request
    pub fn new(
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Vec<u8>,
        protocol: HttpProtocol,
    ) -> Self {
        Self {
            method,
            uri,
            version: protocol.http_version(),
            headers,
            body,
            protocol,
        }
    }

    /// Convert to standard http::Request
    pub fn to_http_request(self) -> Request<Vec<u8>> {
        let mut builder = Request::builder()
            .method(self.method)
            .uri(self.uri)
            .version(self.version);

        // Add headers
        for (name, value) in self.headers.iter() {
            builder = builder.header(name, value);
        }

        builder.body(self.body).expect("Failed to build request")
    }

    /// Create from standard http::Request
    pub fn from_http_request(req: Request<Vec<u8>>, protocol: HttpProtocol) -> Self {
        let (parts, body) = req.into_parts();
        Self {
            method: parts.method,
            uri: parts.uri,
            version: parts.version,
            headers: parts.headers,
            body,
            protocol,
        }
    }

    /// Convert to the legacy format used by plugins
    pub fn to_legacy_format(&self) -> crate::wasm::HttpRequest {
        let headers: HashMap<String, String> = self
            .headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        crate::wasm::HttpRequest {
            method: self.method.to_string(),
            url: self.uri.to_string(),
            headers,
            body: self.body.clone(),
        }
    }

    /// Create from legacy format used by plugins
    pub fn from_legacy_format(
        legacy: &crate::wasm::HttpRequest,
        protocol: HttpProtocol,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let method = legacy.method.parse()?;
        let uri = legacy.url.parse()?;

        let mut headers = HeaderMap::new();
        for (k, v) in &legacy.headers {
            let header_name: http::HeaderName = k.parse()?;
            let header_value: http::HeaderValue = v.parse()?;
            headers.insert(header_name, header_value);
        }

        Ok(Self::new(
            method,
            uri,
            headers,
            legacy.body.clone(),
            protocol,
        ))
    }
}

impl ProxyResponse {
    /// Create a new proxy response
    pub fn new(
        status: StatusCode,
        headers: HeaderMap,
        body: Vec<u8>,
        protocol: HttpProtocol,
    ) -> Self {
        Self {
            status,
            version: protocol.http_version(),
            headers,
            body,
            protocol,
        }
    }

    /// Convert to standard http::Response
    pub fn to_http_response(self) -> Response<Vec<u8>> {
        let mut builder = Response::builder()
            .status(self.status)
            .version(self.version);

        // Add headers
        for (name, value) in self.headers.iter() {
            builder = builder.header(name, value);
        }

        builder.body(self.body).expect("Failed to build response")
    }

    /// Create from standard http::Response
    pub fn from_http_response(res: Response<Vec<u8>>, protocol: HttpProtocol) -> Self {
        let (parts, body) = res.into_parts();
        Self {
            status: parts.status,
            version: parts.version,
            headers: parts.headers,
            body,
            protocol,
        }
    }

    /// Convert to the legacy format used by plugins
    pub fn to_legacy_format(&self) -> crate::wasm::HttpResponse {
        let headers: HashMap<String, String> = self
            .headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        crate::wasm::HttpResponse {
            status: self.status.as_u16(),
            headers,
            body: self.body.clone(),
        }
    }

    /// Create from legacy format used by plugins
    pub fn from_legacy_format(
        legacy: &crate::wasm::HttpResponse,
        protocol: HttpProtocol,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let status = StatusCode::from_u16(legacy.status)?;

        let mut headers = HeaderMap::new();
        for (k, v) in &legacy.headers {
            let header_name: http::HeaderName = k.parse()?;
            let header_value: http::HeaderValue = v.parse()?;
            headers.insert(header_name, header_value);
        }

        Ok(Self::new(status, headers, legacy.body.clone(), protocol))
    }
}

impl ProxyMessage {
    /// Get the protocol this message originated from
    pub fn protocol(&self) -> HttpProtocol {
        match self {
            ProxyMessage::Request(req) => req.protocol,
            ProxyMessage::Response(res) => res.protocol,
        }
    }

    /// Check if this is a request message
    pub fn is_request(&self) -> bool {
        matches!(self, ProxyMessage::Request(_))
    }

    /// Check if this is a response message
    pub fn is_response(&self) -> bool {
        matches!(self, ProxyMessage::Response(_))
    }

    /// Get the request if this is a request message
    pub fn as_request(&self) -> Option<&ProxyRequest> {
        match self {
            ProxyMessage::Request(req) => Some(req),
            _ => None,
        }
    }

    /// Get the response if this is a response message
    pub fn as_response(&self) -> Option<&ProxyResponse> {
        match self {
            ProxyMessage::Response(res) => Some(res),
            _ => None,
        }
    }

    /// Get mutable request if this is a request message
    pub fn as_request_mut(&mut self) -> Option<&mut ProxyRequest> {
        match self {
            ProxyMessage::Request(req) => Some(req),
            _ => None,
        }
    }

    /// Get mutable response if this is a response message
    pub fn as_response_mut(&mut self) -> Option<&mut ProxyResponse> {
        match self {
            ProxyMessage::Response(res) => Some(res),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::{Method, Uri};

    #[test]
    fn test_protocol_alpn_conversion() {
        assert_eq!(HttpProtocol::Http1_1.alpn_id(), b"http/1.1");
        assert_eq!(HttpProtocol::Http2.alpn_id(), b"h2");
        assert_eq!(HttpProtocol::Http3.alpn_id(), b"h3");

        assert_eq!(
            HttpProtocol::from_alpn(b"http/1.1"),
            Some(HttpProtocol::Http1_1)
        );
        assert_eq!(HttpProtocol::from_alpn(b"h2"), Some(HttpProtocol::Http2));
        assert_eq!(HttpProtocol::from_alpn(b"h3"), Some(HttpProtocol::Http3));
        assert_eq!(HttpProtocol::from_alpn(b"unknown"), None);
    }

    #[test]
    fn test_proxy_request_conversion() {
        let method = Method::GET;
        let uri: Uri = "https://example.com/test".parse().unwrap();
        let headers = HeaderMap::new();
        let body = b"test body".to_vec();
        let protocol = HttpProtocol::Http2;

        let proxy_req = ProxyRequest::new(
            method.clone(),
            uri.clone(),
            headers.clone(),
            body.clone(),
            protocol,
        );

        assert_eq!(proxy_req.method, method);
        assert_eq!(proxy_req.uri, uri);
        assert_eq!(proxy_req.body, body);
        assert_eq!(proxy_req.protocol, protocol);
        assert_eq!(proxy_req.version, Version::HTTP_2);

        // Test conversion to http::Request and back
        let http_req = proxy_req.clone().to_http_request();
        let proxy_req2 = ProxyRequest::from_http_request(http_req, protocol);

        assert_eq!(proxy_req.method, proxy_req2.method);
        assert_eq!(proxy_req.uri, proxy_req2.uri);
        assert_eq!(proxy_req.body, proxy_req2.body);
    }

    #[test]
    fn test_proxy_response_conversion() {
        let status = StatusCode::OK;
        let headers = HeaderMap::new();
        let body = b"response body".to_vec();
        let protocol = HttpProtocol::Http3;

        let proxy_res = ProxyResponse::new(status, headers.clone(), body.clone(), protocol);

        assert_eq!(proxy_res.status, status);
        assert_eq!(proxy_res.body, body);
        assert_eq!(proxy_res.protocol, protocol);
        assert_eq!(proxy_res.version, Version::HTTP_3);

        // Test conversion to http::Response and back
        let http_res = proxy_res.clone().to_http_response();
        let proxy_res2 = ProxyResponse::from_http_response(http_res, protocol);

        assert_eq!(proxy_res.status, proxy_res2.status);
        assert_eq!(proxy_res.body, proxy_res2.body);
    }
}
